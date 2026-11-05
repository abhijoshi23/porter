import { createHash, randomUUID } from 'node:crypto';
import {
  askUser,
  type ConfirmationTokens,
  defineTool,
  digest,
  externalText,
  InvalidInputError,
  paginate,
  paginationInput,
  PorterError,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import { matchByName, type Books } from './books.js';
import {
  customRange,
  daysBetween,
  PERIODS,
  periodRange,
  previousRange,
  todayIn,
  yearEarlier,
  type Range,
} from './dates.js';
import { invoiceSchema, type Customer, type Invoice } from './entities.js';
import { formatMoney, fromCents, sumCents, toCents } from './money.js';
import { parseProfitAndLoss, type Pnl, type PnlSection } from './report.js';

export interface ToolDeps {
  books: Books;
  tokens: ConfirmationTokens;
  now: () => number;
  tz: string;
  requireElicitation: boolean;
}

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A date as YYYY-MM-DD.');

/** Customer names and memos are the business's own data, but can hold anything someone typed. */
const name = (s: string) => externalText(s, 200);

const customerOut = z.object({ id: z.string(), name: z.string() });

// ---------------------------------------------------------------------------------------
// find_customers

const findCustomers = (d: ToolDeps) =>
  defineTool({
    name: 'find_customers',
    title: 'Find customers',
    description:
      'Look up customers in QuickBooks by name, company or contact name, with their open balance and email. ' +
      'Use it to get the customer id for create_invoice or find_invoices, or to answer "what does X owe". ' +
      'Without a query, lists customers by open balance (largest first). Example: { "query": "amy" }.',
    input: z.object({
      query: z
        .string()
        .max(100)
        .optional()
        .describe('Part of a name, e.g. "bird sanctuary". Omit to list all.'),
      withBalanceOnly: z.boolean().default(false).describe('Only customers who owe something.'),
      ...paginationInput,
    }),
    output: z.object({
      total: z.number(),
      customers: z.array(
        customerOut.extend({
          company: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
          balance: z.number().describe('Open balance, net of unapplied payments and credits.'),
          currency: z.string(),
        }),
      ),
      nextCursor: z.string().optional(),
    }),
    handler: async ({ query, withBalanceOnly, cursor, limit }) => {
      const [all, company] = await Promise.all([d.books.customers(), d.books.company()]);
      let list = query
        ? matchByName(all, query, (c) => [
            c.DisplayName,
            c.CompanyName ?? '',
            [c.GivenName, c.FamilyName].filter(Boolean).join(' '),
          ])
        : [...all].sort(
            (a, b) => b.Balance - a.Balance || a.DisplayName.localeCompare(b.DisplayName),
          );
      if (withBalanceOnly) list = list.filter((c) => c.Balance > 0);
      const page = paginate(list, { cursor, limit });
      return {
        data: {
          total: page.total,
          customers: page.items.map((c) => ({
            id: c.Id,
            name: name(c.DisplayName),
            ...(c.CompanyName && c.CompanyName !== c.DisplayName
              ? { company: name(c.CompanyName) }
              : {}),
            ...(c.PrimaryEmailAddr ? { email: c.PrimaryEmailAddr.Address } : {}),
            ...(c.PrimaryPhone ? { phone: c.PrimaryPhone.FreeFormNumber } : {}),
            balance: c.Balance,
            currency: c.CurrencyRef?.value ?? company.homeCurrency,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
        summary:
          page.total === 0
            ? `No active customers match${query ? ` "${query}"` : ''}.`
            : `${page.total} customer(s)${query ? ` matching "${query}"` : ''}; showing ${page.items.length}.`,
      };
    },
  });

// ---------------------------------------------------------------------------------------
// find_items

const findItems = (d: ToolDeps) =>
  defineTool({
    name: 'find_items',
    title: 'Find products and services',
    description:
      'Look up the products and services that can go on an invoice, with their default price. ' +
      'Use before create_invoice to pick items. Example: { "query": "design" }.',
    input: z.object({
      query: z.string().max(100).optional().describe('Part of a name or SKU. Omit to list all.'),
      ...paginationInput,
    }),
    output: z.object({
      total: z.number(),
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string().describe('Service, Inventory, NonInventory, Group…'),
          description: z.string().optional(),
          sku: z.string().optional(),
          unitPrice: z
            .number()
            .optional()
            .describe('Default rate; an invoice line may override it.'),
          taxable: z.boolean().optional(),
          quantityOnHand: z.number().optional(),
        }),
      ),
      nextCursor: z.string().optional(),
    }),
    handler: async ({ query, cursor, limit }) => {
      const all = await d.books.items();
      const list = query
        ? matchByName(all, query, (i) => [i.Name, i.FullyQualifiedName ?? '', i.Sku ?? ''])
        : all;
      const page = paginate(list, { cursor, limit });
      return {
        data: {
          total: page.total,
          items: page.items.map((i) => ({
            id: i.Id,
            name: name(i.FullyQualifiedName ?? i.Name),
            type: i.Type,
            ...(i.Description ? { description: externalText(i.Description, 300) } : {}),
            ...(i.Sku ? { sku: i.Sku } : {}),
            ...(i.UnitPrice !== undefined ? { unitPrice: i.UnitPrice } : {}),
            ...(i.Taxable !== undefined ? { taxable: i.Taxable } : {}),
            ...(i.QtyOnHand !== undefined ? { quantityOnHand: i.QtyOnHand } : {}),
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
        summary:
          page.total === 0
            ? `No active products or services match${query ? ` "${query}"` : ''}.`
            : `${page.total} item(s)${query ? ` matching "${query}"` : ''}; showing ${page.items.length}.`,
      };
    },
  });

// ---------------------------------------------------------------------------------------
// find_invoices

type InvoiceStatus = 'paid' | 'open' | 'overdue';

function statusOf(inv: Invoice, today: string): { status: InvoiceStatus; daysOverdue: number } {
  if (toCents(inv.Balance) <= 0) return { status: 'paid', daysOverdue: 0 };
  const late = inv.DueDate ? daysBetween(inv.DueDate, today) : 0;
  return late > 0 ? { status: 'overdue', daysOverdue: late } : { status: 'open', daysOverdue: 0 };
}

const invoiceRow = z.object({
  id: z.string(),
  number: z.string().optional().describe('The invoice number people see (DocNumber).'),
  customer: customerOut,
  date: z.string(),
  dueDate: z.string().optional(),
  total: z.number(),
  balance: z.number().describe('Still owed.'),
  currency: z.string(),
  status: z.enum(['paid', 'open', 'overdue']),
  daysOverdue: z.number(),
  partiallyPaid: z.boolean(),
  emailed: z.boolean(),
  url: z.string().describe('Opens the invoice in QuickBooks.'),
});

function toRow(d: ToolDeps, inv: Invoice, today: string, home: string): z.infer<typeof invoiceRow> {
  const { status, daysOverdue } = statusOf(inv, today);
  return {
    id: inv.Id,
    ...(inv.DocNumber ? { number: inv.DocNumber } : {}),
    customer: { id: inv.CustomerRef.value, name: name(inv.CustomerRef.name ?? '') },
    date: inv.TxnDate,
    ...(inv.DueDate ? { dueDate: inv.DueDate } : {}),
    total: inv.TotalAmt,
    balance: inv.Balance,
    currency: inv.CurrencyRef?.value ?? home,
    status,
    daysOverdue,
    partiallyPaid: inv.Balance > 0 && toCents(inv.Balance) < toCents(inv.TotalAmt),
    emailed: inv.EmailStatus === 'EmailSent',
    url: d.books.qbo.appUrl('invoice', inv.Id),
  };
}

const findInvoices = (d: ToolDeps) =>
  defineTool({
    name: 'find_invoices',
    title: 'Find invoices',
    description:
      'List invoices, newest first, filtered by customer, status and date. Pass `number` to get one invoice with its lines. ' +
      'For "who owes me" and aging, use who_owes_me instead. Dates are YYYY-MM-DD invoice dates. ' +
      'Example: { "customer": "Amy\'s Bird Sanctuary", "status": "overdue" }.',
    input: z.object({
      customer: z.string().max(100).optional().describe('Customer id or name.'),
      status: z
        .enum(['any', 'open', 'overdue', 'paid'])
        .default('any')
        .describe('open = not fully paid (includes overdue); overdue = past its due date.'),
      from: dateInput.optional().describe('Invoice date on or after (YYYY-MM-DD).'),
      to: dateInput.optional().describe('Invoice date on or before (YYYY-MM-DD).'),
      number: z
        .string()
        .max(21)
        .regex(/^[A-Za-z0-9_\-/.#]+$/)
        .optional()
        .describe('Exact invoice number, e.g. "1037". Returns its lines too.'),
      ...paginationInput,
    }),
    output: z.object({
      total: z.number(),
      invoices: z.array(invoiceRow),
      detail: z
        .object({
          lines: z.array(
            z.object({
              item: z.string().optional(),
              description: z.string().optional(),
              quantity: z.number().optional(),
              rate: z.number().optional(),
              amount: z.number(),
            }),
          ),
          tax: z.number().optional(),
          memo: z.string().optional().describe('Message to the customer printed on the invoice.'),
        })
        .optional()
        .describe('Present when `number` matched exactly one invoice.'),
      asOf: z.string().describe('Today in the business time zone, used for "overdue".'),
      nextCursor: z.string().optional(),
    }),
    handler: async (a) => {
      const today = todayIn(d.tz, d.now());
      const where: string[] = [];
      if (a.customer) where.push(`CustomerRef = '${(await d.books.customer(a.customer)).Id}'`);
      if (a.from) where.push(`TxnDate >= '${a.from}'`);
      if (a.to) where.push(`TxnDate <= '${a.to}'`);
      if (a.number) where.push(`DocNumber = '${a.number}'`);
      if (a.status === 'paid') where.push(`Balance = '0'`);
      if (a.status === 'open' || a.status === 'overdue') where.push(`Balance > '0'`);
      const [{ rows, capped }, company] = await Promise.all([
        d.books.qbo.query('Invoice', invoiceSchema, { where, orderBy: 'TxnDate DESC, Id DESC' }),
        d.books.company(),
      ]);
      let list = rows.map((r) => toRow(d, r, today, company.homeCurrency));
      if (a.status === 'overdue') list = list.filter((r) => r.status === 'overdue');
      const page = paginate(list, { cursor: a.cursor, limit: a.limit });
      const one = a.number && rows.length === 1 ? rows[0]! : undefined;
      const detail = one
        ? {
            lines: one.Line.filter((l) => l.DetailType === 'SalesItemLineDetail').map((l) => ({
              ...(l.SalesItemLineDetail?.ItemRef?.name
                ? { item: name(l.SalesItemLineDetail.ItemRef.name) }
                : {}),
              ...(l.Description ? { description: externalText(l.Description, 500) } : {}),
              ...(l.SalesItemLineDetail?.Qty !== undefined
                ? { quantity: l.SalesItemLineDetail.Qty }
                : {}),
              ...(l.SalesItemLineDetail?.UnitPrice !== undefined
                ? { rate: l.SalesItemLineDetail.UnitPrice }
                : {}),
              amount: l.Amount,
            })),
            ...(one.TxnTaxDetail?.TotalTax !== undefined ? { tax: one.TxnTaxDetail.TotalTax } : {}),
            ...(one.CustomerMemo?.value
              ? { memo: externalText(one.CustomerMemo.value, 1000) }
              : {}),
          }
        : undefined;
      const what = a.status === 'any' ? '' : `${a.status} `;
      return {
        data: {
          total: page.total,
          invoices: page.items,
          ...(detail ? { detail } : {}),
          asOf: today,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
        summary:
          page.total === 0
            ? `No ${what}invoices match.${a.number ? ` There is no invoice number ${a.number}.` : ''}`
            : `${page.total} ${what}invoice(s); showing ${page.items.length}, newest first.${capped ? ' Only the newest 10,000 were read; narrow the dates.' : ''}`,
      };
    },
  });

// ---------------------------------------------------------------------------------------
// who_owes_me

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
type Bucket = (typeof BUCKETS)[number];
const bucketOf = (late: number): Bucket =>
  late <= 0
    ? 'current'
    : late <= 30
      ? 'days1to30'
      : late <= 60
        ? 'days31to60'
        : late <= 90
          ? 'days61to90'
          : 'over90';

const aging = z.object({
  current: z.number().describe('Not yet due.'),
  days1to30: z.number(),
  days31to60: z.number(),
  days61to90: z.number(),
  over90: z.number(),
});

const whoOwesMe = (d: ToolDeps) =>
  defineTool({
    name: 'who_owes_me',
    title: 'Who owes me (receivables and aging)',
    description:
      'Money customers owe on open invoices, grouped by customer, biggest overdue first, with aging buckets ' +
      '(not yet due, 1-30, 31-60, 61-90, over 90 days past due), the oldest invoices and contact emails for follow-up. ' +
      'Use for "who owes me", "what is overdue", "AR aging", "who should I chase". Example: { "overdueOnly": true }.',
    input: z.object({
      customer: z.string().max(100).optional().describe('Limit to one customer (id or name).'),
      overdueOnly: z.boolean().default(false).describe('Only customers with something past due.'),
      minDaysOverdue: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Only count invoices at least this many days past due, e.g. 60.'),
      ...paginationInput,
    }),
    output: z.object({
      asOf: z.string().describe('Today in the business time zone.'),
      totals: z.array(
        z.object({
          currency: z.string(),
          open: z.number(),
          overdue: z.number(),
          aging,
          invoices: z.number(),
          customers: z.number(),
        }),
      ),
      customers: z.array(
        customerOut.extend({
          email: z.string().optional(),
          currency: z.string(),
          open: z.number(),
          overdue: z.number(),
          aging,
          maxDaysOverdue: z.number(),
          invoices: z
            .array(
              z.object({
                id: z.string(),
                number: z.string().optional(),
                dueDate: z.string().optional(),
                balance: z.number(),
                daysOverdue: z.number(),
                emailed: z.boolean(),
              }),
            )
            .describe('Up to 5, most overdue first.'),
          moreInvoices: z.number(),
          note: z.string().optional(),
        }),
      ),
      total: z.number().describe('Customers matching.'),
      nextCursor: z.string().optional(),
    }),
    handler: async (a) => {
      const today = todayIn(d.tz, d.now());
      const where = [`Balance > '0'`];
      let only: Customer | undefined;
      if (a.customer) {
        only = await d.books.customer(a.customer);
        where.push(`CustomerRef = '${only.Id}'`);
      }
      const [{ rows }, customers, company] = await Promise.all([
        d.books.qbo.query('Invoice', invoiceSchema, { where }),
        d.books.customers(),
        d.books.company(),
      ]);
      const byId = new Map(customers.map((c) => [c.Id, c]));

      interface Acc {
        id: string;
        name: string;
        currency: string;
        cents: Record<Bucket, number>;
        invoices: { inv: Invoice; late: number }[];
      }
      const acc = new Map<string, Acc>();
      for (const inv of rows) {
        const late = inv.DueDate ? daysBetween(inv.DueDate, today) : 0;
        if (a.minDaysOverdue && late < a.minDaysOverdue) continue;
        const cid = inv.CustomerRef.value;
        const currency = inv.CurrencyRef?.value ?? company.homeCurrency;
        const key = `${cid}|${currency}`;
        let e = acc.get(key);
        if (!e) {
          e = {
            id: cid,
            name: name(byId.get(cid)?.DisplayName ?? inv.CustomerRef.name ?? cid),
            currency,
            cents: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 },
            invoices: [],
          };
          acc.set(key, e);
        }
        e.cents[bucketOf(late)] += toCents(inv.Balance);
        e.invoices.push({ inv, late });
      }

      const overdueCents = (c: Record<Bucket, number>) =>
        c.days1to30 + c.days31to60 + c.days61to90 + c.over90;
      const openCents = (c: Record<Bucket, number>) => c.current + overdueCents(c);
      let list = [...acc.values()];
      if (a.overdueOnly) list = list.filter((e) => overdueCents(e.cents) > 0);
      list.sort(
        (x, y) =>
          overdueCents(y.cents) - overdueCents(x.cents) || openCents(y.cents) - openCents(x.cents),
      );

      const totals = new Map<
        string,
        { cents: Record<Bucket, number>; invoices: number; customers: number }
      >();
      for (const e of list) {
        const t = totals.get(e.currency) ?? {
          cents: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 },
          invoices: 0,
          customers: 0,
        };
        for (const b of BUCKETS) t.cents[b] += e.cents[b];
        t.invoices += e.invoices.length;
        t.customers++;
        totals.set(e.currency, t);
      }
      const money = (c: Record<Bucket, number>) =>
        Object.fromEntries(BUCKETS.map((b) => [b, fromCents(c[b])])) as Record<Bucket, number>;

      const page = paginate(list, { cursor: a.cursor, limit: a.limit });
      const out = page.items.map((e) => {
        const c = byId.get(e.id);
        const sorted = e.invoices.sort((x, y) => y.late - x.late);
        const open = openCents(e.cents);
        // The customer balance nets unapplied payments and credit notes; open invoices don't.
        const credit =
          c && !a.minDaysOverdue && toCents(c.Balance) < open
            ? `QuickBooks shows a balance of ${formatMoney(c.Balance, e.currency)}: unapplied payments or credits not yet matched to these invoices.`
            : undefined;
        return {
          id: e.id,
          name: e.name,
          ...(c?.PrimaryEmailAddr ? { email: c.PrimaryEmailAddr.Address } : {}),
          currency: e.currency,
          open: fromCents(open),
          overdue: fromCents(overdueCents(e.cents)),
          aging: money(e.cents),
          maxDaysOverdue: Math.max(0, sorted[0]?.late ?? 0),
          invoices: sorted.slice(0, 5).map(({ inv, late }) => ({
            id: inv.Id,
            ...(inv.DocNumber ? { number: inv.DocNumber } : {}),
            ...(inv.DueDate ? { dueDate: inv.DueDate } : {}),
            balance: inv.Balance,
            daysOverdue: Math.max(0, late),
            emailed: inv.EmailStatus === 'EmailSent',
          })),
          moreInvoices: Math.max(0, sorted.length - 5),
          ...(credit ? { note: credit } : {}),
        };
      });

      const totalsOut = [...totals.entries()].map(([currency, t]) => ({
        currency,
        open: fromCents(openCents(t.cents)),
        overdue: fromCents(overdueCents(t.cents)),
        aging: money(t.cents),
        invoices: t.invoices,
        customers: t.customers,
      }));
      const lines = totalsOut.map(
        (t) =>
          `${formatMoney(t.open, t.currency)} open across ${t.invoices} invoice(s) from ${t.customers} customer(s); ${formatMoney(t.overdue, t.currency)} overdue`,
      );
      const top = out[0];
      return {
        data: {
          asOf: today,
          totals: totalsOut,
          customers: out,
          total: page.total,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
        summary:
          list.length === 0
            ? `Nobody owes anything${a.overdueOnly || a.minDaysOverdue ? ' past due' : ''}${only ? ` (${name(only.DisplayName)})` : ''} as of ${today}.`
            : `As of ${today}: ${lines.join('. ')}.${top && top.overdue > 0 ? ` Most overdue: ${top.name}, ${formatMoney(top.overdue, top.currency)} (up to ${top.maxDaysOverdue} days late).` : ''}`,
      };
    },
  });

// ---------------------------------------------------------------------------------------
// profit_and_loss

const pnlLine = z.object({
  account: z.string(),
  amount: z.number(),
  previous: z.number().optional().describe('Same account in the comparison period.'),
});
const pnlSection = z.object({
  total: z.number(),
  previousTotal: z.number().optional(),
  lines: z.array(pnlLine).describe('Largest first, capped by maxLinesPerSection.'),
  moreLines: z.number(),
});

const profitAndLoss = (d: ToolDeps) =>
  defineTool({
    name: 'profit_and_loss',
    title: 'Profit and loss',
    description:
      "Income, costs, expenses and net income for a period, from QuickBooks' Profit and Loss report, optionally compared with the previous period or the same period last year. " +
      'Periods run to today when current ("this_month" = month to date) and follow the company\'s fiscal year. ' +
      'Example: { "period": "last_month", "compareTo": "previous_period" }.',
    input: z.object({
      period: z
        .enum(PERIODS)
        .default('this_month')
        .describe('Ignored when start and end are given.'),
      start: dateInput.optional().describe('Custom range start (YYYY-MM-DD), with end.'),
      end: dateInput.optional().describe('Custom range end (YYYY-MM-DD), with start.'),
      basis: z
        .enum(['accrual', 'cash'])
        .default('accrual')
        .describe('accrual: when invoiced/billed. cash: when paid.'),
      compareTo: z.enum(['none', 'previous_period', 'previous_year']).default('none'),
      maxLinesPerSection: z.number().int().min(0).max(50).default(8),
    }),
    output: z.object({
      period: z.object({ start: z.string(), end: z.string(), label: z.string() }),
      comparedWith: z.object({ start: z.string(), end: z.string(), label: z.string() }).optional(),
      basis: z.string(),
      currency: z.string(),
      income: pnlSection,
      costOfGoodsSold: pnlSection,
      grossProfit: z.number(),
      expenses: pnlSection,
      otherIncome: pnlSection,
      otherExpenses: pnlSection,
      netIncome: z.number(),
      previousNetIncome: z.number().optional(),
      noActivity: z.boolean(),
    }),
    handler: async (a) => {
      if ((a.start === undefined) !== (a.end === undefined)) {
        throw new InvalidInputError('Give both start and end, or neither (to use `period`).');
      }
      const today = todayIn(d.tz, d.now());
      const company = await d.books.company();
      const range: Range =
        a.start && a.end
          ? customRange(a.start, a.end)
          : periodRange(a.period, today, company.fiscalStartMonth);
      const compare =
        a.compareTo === 'previous_period'
          ? previousRange(range)
          : a.compareTo === 'previous_year'
            ? yearEarlier(range)
            : undefined;
      const fetch = (r: Range) =>
        d.books.qbo
          .report('ProfitAndLoss', {
            start_date: r.start,
            end_date: r.end,
            accounting_method: a.basis === 'cash' ? 'Cash' : 'Accrual',
          })
          .then(parseProfitAndLoss);
      const [cur, prev] = await Promise.all([fetch(range), compare ? fetch(compare) : undefined]);

      const section = (
        k: keyof Pick<
          Pnl,
          'income' | 'costOfGoodsSold' | 'expenses' | 'otherIncome' | 'otherExpenses'
        >,
      ) => {
        const s: PnlSection = cur[k];
        const before = new Map(
          (prev?.[k].lines ?? []).map((l) => [l.accountId ?? l.account, l.amount]),
        );
        const sorted = [...s.lines].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
        return {
          total: s.total,
          ...(prev ? { previousTotal: prev[k].total } : {}),
          lines: sorted.slice(0, a.maxLinesPerSection).map((l) => ({
            account: name(l.account),
            amount: l.amount,
            ...(prev ? { previous: before.get(l.accountId ?? l.account) ?? 0 } : {}),
          })),
          moreLines: Math.max(0, sorted.length - a.maxLinesPerSection),
        };
      };
      const currency = cur.currency || company.homeCurrency;
      const m = (n: number) => formatMoney(n, currency);
      const change =
        prev && toCents(prev.netIncome) !== 0
          ? ` (${m(prev.netIncome)} ${compare!.label}, ${cur.netIncome >= prev.netIncome ? 'up' : 'down'} ${Math.abs(Math.round(((cur.netIncome - prev.netIncome) / Math.abs(prev.netIncome)) * 100))}%)`
          : prev
            ? ` (${m(prev.netIncome)} ${compare!.label})`
            : '';
      return {
        data: {
          period: range,
          ...(compare ? { comparedWith: compare } : {}),
          basis: a.basis,
          currency,
          income: section('income'),
          costOfGoodsSold: section('costOfGoodsSold'),
          grossProfit: cur.grossProfit,
          expenses: section('expenses'),
          otherIncome: section('otherIncome'),
          otherExpenses: section('otherExpenses'),
          netIncome: cur.netIncome,
          ...(prev ? { previousNetIncome: prev.netIncome } : {}),
          noActivity: cur.noActivity,
        },
        summary: cur.noActivity
          ? `No transactions recorded for ${range.label} (${range.start} to ${range.end}).`
          : `${range.label} (${range.start} to ${range.end}, ${a.basis} basis): income ${m(cur.income.total)}, expenses ${m(sumCentsOf(cur))}, net income ${m(cur.netIncome)}${change}.`,
      };
    },
  });

/** Cost of goods sold, expenses and other expenses together, for the one-line summary. */
const sumCentsOf = (p: Pnl) =>
  fromCents(sumCents([p.costOfGoodsSold.total, p.expenses.total, p.otherExpenses.total]));

// ---------------------------------------------------------------------------------------
// create_invoice

const previewSchema = z.object({
  customer: customerOut.extend({ email: z.string().optional() }),
  invoiceDate: z.string(),
  dueDate: z
    .string()
    .optional()
    .describe("Absent: QuickBooks sets it from the customer's payment terms."),
  lines: z.array(
    z.object({
      item: z.object({ id: z.string(), name: z.string() }),
      description: z.string().optional(),
      quantity: z.number(),
      rate: z.number(),
      amount: z.number(),
    }),
  ),
  subtotal: z.number(),
  currency: z.string(),
  memo: z.string().optional(),
  taxCode: z.object({ id: z.string(), name: z.string() }).optional(),
  taxNote: z.string(),
});
type Preview = z.infer<typeof previewSchema>;

function previewText(p: Preview): string {
  const m = (n: number) => formatMoney(n, p.currency);
  const lines = p.lines
    .map((l) => `  - ${l.item.name}: ${l.quantity} × ${m(l.rate)} = ${m(l.amount)}`)
    .join('\n');
  return [
    `Create an invoice in QuickBooks for ${p.customer.name}?`,
    lines,
    `Subtotal ${m(p.subtotal)} (${p.taxNote})`,
    `Dated ${p.invoiceDate}, due ${p.dueDate ?? "per the customer's terms"}. It is not emailed to the customer.`,
  ].join('\n');
}

const createInvoice = (d: ToolDeps) =>
  defineTool({
    name: 'create_invoice',
    title: 'Create invoice (asks the user first)',
    // No concrete example here: a write tool's example is a ready-made call, and small models
    // have run it verbatim on unrelated requests (qwen2.5-coder 14b eval, 2026-11-05).
    description:
      'Creates an invoice in QuickBooks, only when the user has asked for one. Nothing is created until the user approves: ' +
      (d.requireElicitation
        ? 'the client shows them the invoice and asks. Clients that cannot ask the user are refused. '
        : 'clients that can ask the user show them the invoice; otherwise the first call returns `status: "preview"` and a `confirmationToken`. ' +
          "Show the user that preview, and only after they say yes call again with the same arguments plus `confirmationToken`. Never pass a token the user hasn't approved. ") +
      'The invoice is not emailed. Customer and items must already exist (find_customers, find_items); if a name matches several, ask the user which. ' +
      'Shape: { "customer": "<customer id>", "lines": [{ "item": "<item id>", "quantity": <number> }] }.',
    input: z.object({
      customer: z.string().min(1).max(100).describe('Customer id (preferred) or exact name.'),
      lines: z
        .array(
          z.object({
            item: z.string().min(1).max(100).describe('Product/service id or name.'),
            quantity: z.number().positive().max(1_000_000).default(1),
            rate: z
              .number()
              .min(0)
              .max(10_000_000)
              .optional()
              .describe("Unit price. Defaults to the item's price."),
            description: z
              .string()
              .max(4000)
              .optional()
              .describe("Defaults to the item's description."),
          }),
        )
        .min(1)
        .max(50),
      invoiceDate: dateInput.optional().describe('Defaults to today.'),
      dueDate: dateInput.optional().describe("Defaults to the customer's payment terms."),
      memo: z
        .string()
        .max(1000)
        .optional()
        .describe('Message to the customer printed on the invoice.'),
      taxCode: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Sales tax code name or id, e.g. "HST ON". Required for Canadian and other non-US companies.',
        ),
      confirmationToken: z
        .string()
        .max(200)
        .optional()
        .describe('From a previous preview, only after the user approved it.'),
    }),
    output: z.object({
      status: z.enum(['created', 'preview', 'cancelled']),
      preview: previewSchema,
      confirmationToken: z.string().optional(),
      expiresInSeconds: z.number().optional(),
      invoice: z
        .object({
          id: z.string(),
          number: z.string().optional(),
          total: z.number().describe('Including any tax QuickBooks calculated.'),
          tax: z.number().optional(),
          balance: z.number(),
          dueDate: z.string().optional(),
          url: z.string(),
        })
        .optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // A second identical approved call is answered from Intuit's idempotency record, not a duplicate.
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (a, ctx) => {
      const preview = await buildPreview(d, a);
      const conn = await d.books.qbo.connection();
      const dg = digest({ realm: conn.realmId, preview });
      const purpose = `create_invoice:${dg}`;

      const ask = await askUser(ctx, {
        message: previewText(preview),
        digest: dg,
        tokens: d.tokens,
      });
      if (ask.status === 'pending') return ask.result;
      if (ask.status === 'declined') {
        return {
          data: { status: 'cancelled' as const, preview },
          summary: 'The user did not approve the invoice, so nothing was created.',
        };
      }
      if (ask.status === 'dismissed') {
        return {
          data: { status: 'cancelled' as const, preview },
          summary:
            'Nothing was created: the approval prompt was dismissed or could not be shown to the user. ' +
            'Show the user this invoice and ask whether to try again; do not retry on your own.',
        };
      }

      let requestKey: string;
      if (ask.status === 'confirmed') {
        // 2026 era: the minted state is unique per approval round, so a retried round maps to
        // the same QuickBooks request id. 2025 era: one call, one id.
        requestKey = String(ctx.mcp.mcpReq.requestState() ?? randomUUID());
      } else {
        if (d.requireElicitation) {
          throw new PorterError(
            'Nothing was created: this client cannot ask the user to approve the invoice, and the server requires that (QUICKBOOKS_REQUIRE_ELICITATION, on by default).',
            {
              hint:
                'Tell the user to create it in QuickBooks directly, use a client that supports elicitation, or set QUICKBOOKS_REQUIRE_ELICITATION=false ' +
                "to allow preview-and-confirm instead. Don't retry.",
            },
          );
        }
        if (!a.confirmationToken) {
          return {
            data: {
              status: 'preview' as const,
              preview,
              confirmationToken: d.tokens.mint(purpose),
              expiresInSeconds: 600,
            },
            summary:
              'Preview only: nothing was created. Show the user this invoice and ask them to approve it. ' +
              'If they say yes, call create_invoice again with the same arguments plus this confirmationToken.',
          };
        }
        const check = d.tokens.verify(a.confirmationToken, purpose);
        if (check === 'expired') {
          throw new InvalidInputError('The confirmation token expired (they last 10 minutes).', {
            hint: 'Call create_invoice without confirmationToken for a fresh preview and ask the user again.',
          });
        }
        if (check !== 'ok') {
          throw new InvalidInputError(
            'The confirmation token does not match this invoice: the arguments, prices or customer changed since the preview, or the token is from another preview.',
            {
              hint: 'Call create_invoice without confirmationToken, show the user the new preview, and ask again.',
            },
          );
        }
        requestKey = a.confirmationToken;
      }

      const requestId = `porter-${createHash('sha256').update(requestKey).digest('hex').slice(0, 40)}`;
      const created = await d.books.qbo.create(
        'Invoice',
        invoiceBody(preview),
        requestId,
        invoiceSchema,
      );
      d.books.invalidate();
      ctx.log.info({ invoice: created.Id }, 'invoice created');
      const m = (n: number) => formatMoney(n, preview.currency);
      return {
        data: {
          status: 'created' as const,
          preview,
          invoice: {
            id: created.Id,
            ...(created.DocNumber ? { number: created.DocNumber } : {}),
            total: created.TotalAmt,
            ...(created.TxnTaxDetail?.TotalTax !== undefined
              ? { tax: created.TxnTaxDetail.TotalTax }
              : {}),
            balance: created.Balance,
            ...(created.DueDate ? { dueDate: created.DueDate } : {}),
            url: d.books.qbo.appUrl('invoice', created.Id),
          },
        },
        summary: `Created invoice ${created.DocNumber ?? created.Id} for ${preview.customer.name}: ${m(created.TotalAmt)}${created.DueDate ? `, due ${created.DueDate}` : ''}. It has not been emailed.`,
      };
    },
  });

type CreateArgs = {
  customer: string;
  lines: {
    item: string;
    quantity: number;
    rate?: number | undefined;
    description?: string | undefined;
  }[];
  invoiceDate?: string | undefined;
  dueDate?: string | undefined;
  memo?: string | undefined;
  taxCode?: string | undefined;
};

/** Resolves names to ids and prices, so the preview (and its digest) is exactly what will be sent. */
async function buildPreview(d: ToolDeps, a: CreateArgs): Promise<Preview> {
  const [customer, company] = await Promise.all([d.books.customer(a.customer), d.books.company()]);
  const items = await Promise.all(a.lines.map((l) => d.books.item(l.item)));
  const today = todayIn(d.tz, d.now());
  const invoiceDate = a.invoiceDate ?? today;
  if (a.dueDate && a.dueDate < invoiceDate) {
    throw new InvalidInputError(
      `The due date ${a.dueDate} is before the invoice date ${invoiceDate}.`,
    );
  }
  const lines = a.lines.map((l, i) => {
    const item = items[i]!;
    const rate = l.rate ?? item.UnitPrice;
    if (rate === undefined) {
      throw new InvalidInputError(`"${item.Name}" has no default price.`, {
        hint: 'Ask the user for the rate and pass it on that line.',
      });
    }
    const description = l.description ?? item.Description;
    return {
      item: { id: item.Id, name: name(item.FullyQualifiedName ?? item.Name) },
      ...(description ? { description } : {}),
      quantity: l.quantity,
      rate,
      amount: fromCents(Math.round(l.quantity * rate * 100)),
    };
  });

  // US companies use automated sales tax: QuickBooks works it out from the address. Elsewhere
  // (GST/HST/PST, VAT) every line needs a tax code, and guessing one is not ours to do.
  const us = (company.Country ?? 'US') === 'US';
  let taxCode: Preview['taxCode'];
  if (a.taxCode) {
    const t = await d.books.taxCode(a.taxCode);
    taxCode = { id: t.Id, name: t.Name };
  } else if (!us) {
    const codes = (await d.books.taxCodes()).slice(0, 15).map((t) => `${t.Name} [id:${t.Id}]`);
    throw new InvalidInputError(
      `This company is in ${company.Country}, where each invoice line needs a sales tax code.`,
      {
        hint: `Ask the user which applies and pass it as taxCode. Available: ${codes.join('; ')}.`,
      },
    );
  }
  const currency = customer.CurrencyRef?.value ?? company.homeCurrency;
  return {
    customer: {
      id: customer.Id,
      name: name(customer.DisplayName),
      ...(customer.PrimaryEmailAddr ? { email: customer.PrimaryEmailAddr.Address } : {}),
    },
    invoiceDate,
    ...(a.dueDate ? { dueDate: a.dueDate } : {}),
    lines,
    subtotal: fromCents(sumCents(lines.map((l) => l.amount))),
    currency,
    ...(a.memo ? { memo: a.memo } : {}),
    ...(taxCode ? { taxCode } : {}),
    taxNote: taxCode
      ? `tax code ${taxCode.name}; QuickBooks calculates the tax`
      : 'before sales tax; QuickBooks adds any tax when it creates the invoice',
  };
}

function invoiceBody(p: Preview) {
  return {
    CustomerRef: { value: p.customer.id },
    TxnDate: p.invoiceDate,
    ...(p.dueDate ? { DueDate: p.dueDate } : {}),
    ...(p.memo ? { CustomerMemo: { value: p.memo } } : {}),
    Line: p.lines.map((l) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: l.amount,
      ...(l.description ? { Description: l.description } : {}),
      SalesItemLineDetail: {
        ItemRef: { value: l.item.id },
        Qty: l.quantity,
        UnitPrice: l.rate,
        ...(p.taxCode ? { TaxCodeRef: { value: p.taxCode.id } } : {}),
      },
    })),
  };
}

/** Registration order is the tools/list order (stable, for prompt caching). */
export function allTools(d: ToolDeps) {
  return [
    whoOwesMe(d),
    profitAndLoss(d),
    findInvoices(d),
    findCustomers(d),
    findItems(d),
    createInvoice(d),
  ];
}
