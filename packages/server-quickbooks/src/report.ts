import { PorterError } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import { fromCents, toCents } from './money.js';

/**
 * QuickBooks report JSON is a tree: sections (`type: "Section"`, tagged with a `group`
 * such as Income or Expenses) hold a header, rows, and a summary; leaves are `Data` rows of
 * `ColData` cells. Sub-accounts nest as sections inside sections. Amounts are strings
 * ("2250.00", or "" for none). We read the last column, which is the total when the report
 * is requested with a single column (the default `summarize_column_by=Total`).
 */

const cell = z.looseObject({ value: z.string().default(''), id: z.string().optional() });
type Cell = z.infer<typeof cell>;
interface RowT {
  type?: string | undefined;
  group?: string | undefined;
  ColData?: Cell[] | undefined;
  Header?: { ColData?: Cell[] | undefined } | undefined;
  Rows?: { Row?: RowT[] | undefined } | undefined;
  Summary?: { ColData?: Cell[] | undefined } | undefined;
}
const row: z.ZodType<RowT> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional(),
    group: z.string().optional(),
    ColData: z.array(cell).optional(),
    Header: z.looseObject({ ColData: z.array(cell).optional() }).optional(),
    Rows: z.looseObject({ Row: z.array(row).optional() }).optional(),
    Summary: z.looseObject({ ColData: z.array(cell).optional() }).optional(),
  }),
);

const reportSchema = z.looseObject({
  Header: z.looseObject({
    ReportName: z.string().optional(),
    StartPeriod: z.string().optional(),
    EndPeriod: z.string().optional(),
    ReportBasis: z.string().optional(),
    Currency: z.string().optional(),
    Option: z.array(z.looseObject({ Name: z.string(), Value: z.string() })).optional(),
  }),
  Rows: z.looseObject({ Row: z.array(row).optional() }).optional(),
});

export interface PnlLine {
  /** Sub-accounts as "Parent › Child". */
  account: string;
  accountId?: string;
  amount: number;
}

export interface PnlSection {
  total: number;
  lines: PnlLine[];
}

export interface Pnl {
  start: string;
  end: string;
  basis: string;
  currency: string;
  income: PnlSection;
  costOfGoodsSold: PnlSection;
  expenses: PnlSection;
  otherIncome: PnlSection;
  otherExpenses: PnlSection;
  grossProfit: number;
  netOperatingIncome: number;
  netIncome: number;
  /** QuickBooks found no transactions in the period. */
  noActivity: boolean;
}

const amountOf = (cells: Cell[] | undefined): number | null => {
  const v = cells?.at(-1)?.value.replace(/,/g, '') ?? '';
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Leaf lines of a section, depth-first, with parent names as a path. */
function lines(rows: RowT[] | undefined, path: string[], out: PnlLine[]): void {
  for (const r of rows ?? []) {
    if (r.Rows?.Row?.length || r.Header) {
      const name = r.Header?.ColData?.[0]?.value ?? '';
      // A parent account can carry its own amount next to its children's.
      const own = amountOf(r.Header?.ColData);
      if (own) {
        out.push({
          account: [...path, name].join(' › '),
          ...(r.Header?.ColData?.[0]?.id ? { accountId: r.Header.ColData[0].id } : {}),
          amount: own,
        });
      }
      lines(r.Rows?.Row, name ? [...path, name] : path, out);
      continue;
    }
    const amount = amountOf(r.ColData);
    const first = r.ColData?.[0];
    if (amount === null || !first) continue;
    out.push({
      account: [...path, first.value].join(' › '),
      ...(first.id ? { accountId: first.id } : {}),
      amount,
    });
  }
}

const GROUPS = {
  Income: 'income',
  COGS: 'costOfGoodsSold',
  Expenses: 'expenses',
  OtherIncome: 'otherIncome',
  OtherExpenses: 'otherExpenses',
} as const;

export function parseProfitAndLoss(json: unknown): Pnl {
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    throw new PorterError(
      'QuickBooks returned the Profit and Loss report in an unexpected format.',
      {
        cause: parsed.error,
      },
    );
  }
  const r = parsed.data;
  const empty = (): PnlSection => ({ total: 0, lines: [] });
  const out: Pnl = {
    start: r.Header.StartPeriod ?? '',
    end: r.Header.EndPeriod ?? '',
    basis: r.Header.ReportBasis ?? '',
    currency: r.Header.Currency ?? '',
    income: empty(),
    costOfGoodsSold: empty(),
    expenses: empty(),
    otherIncome: empty(),
    otherExpenses: empty(),
    grossProfit: 0,
    netOperatingIncome: 0,
    netIncome: 0,
    noActivity:
      r.Header.Option?.some((o) => o.Name === 'NoReportData' && o.Value === 'true') ?? false,
  };
  const summaries: Record<string, number> = {};
  for (const top of r.Rows?.Row ?? []) {
    const total = amountOf(top.Summary?.ColData) ?? 0;
    if (top.group) summaries[top.group] = total;
    const key = top.group ? GROUPS[top.group as keyof typeof GROUPS] : undefined;
    if (!key) continue;
    const section = out[key];
    section.total = total;
    lines(top.Rows?.Row, [], section.lines);
  }
  // Prefer QuickBooks' own totals; derive only when a summary row is missing.
  const c = (n: number) => toCents(n);
  out.grossProfit =
    summaries.GrossProfit ?? fromCents(c(out.income.total) - c(out.costOfGoodsSold.total));
  out.netOperatingIncome =
    summaries.NetOperatingIncome ?? fromCents(c(out.grossProfit) - c(out.expenses.total));
  out.netIncome =
    summaries.NetIncome ??
    fromCents(c(out.netOperatingIncome) + c(out.otherIncome.total) - c(out.otherExpenses.total));
  return out;
}
