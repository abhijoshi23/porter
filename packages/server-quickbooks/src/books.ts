import { InvalidInputError, NotFoundError } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import {
  companyInfoSchema,
  customerSchema,
  itemSchema,
  preferencesSchema,
  taxCodeSchema,
  type CompanyInfo,
  type Customer,
  type Item,
  type TaxCode,
} from './entities.js';
import type { QboClient } from './qbo.js';

/** Lists change rarely within a conversation; a short cache saves a round trip per tool call. */
const LIST_TTL_MS = 60_000;

export interface Company extends CompanyInfo {
  homeCurrency: string;
  /** 1-12. */
  fiscalStartMonth: number;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Lowercase, accents and punctuation off, "&" as "and": "Amy's Bird Sanctuary" ~ "amys bird sanctuary". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Ranks entries against what the model typed. Exact (normalized) name first, then names
 * starting with the query, then names containing every query word. Names are matched here,
 * not in a QuickBooks query, so free text never ends up inside a query string.
 */
export function matchByName<T>(list: readonly T[], query: string, name: (t: T) => string[]): T[] {
  const q = normalizeName(query);
  if (!q) return [...list];
  const words = q.split(' ');
  const scored: { t: T; s: number }[] = [];
  for (const t of list) {
    let best = 0;
    for (const raw of name(t)) {
      const n = normalizeName(raw);
      if (!n) continue;
      const s =
        n === q
          ? 3
          : n.startsWith(q)
            ? 2
            : words.every((w) => n.split(' ').some((nw) => nw.startsWith(w)))
              ? 1
              : 0;
      best = Math.max(best, s);
    }
    if (best) scored.push({ t, s: best });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.t);
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** Customers, items and company settings for the connected company, briefly cached. */
export class Books {
  private cache = new Map<string, Cached<unknown>>();

  constructor(
    readonly qbo: QboClient,
    private readonly now: () => number,
  ) {}

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && this.now() - hit.at < ttl) return hit.value;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** After a write, so the next read sees the new balance. */
  invalidate(): void {
    this.cache.clear();
  }

  async customers(): Promise<Customer[]> {
    return this.cached('customers', LIST_TTL_MS, async () => {
      // QuickBooks queries return active records only unless asked otherwise.
      const { rows } = await this.qbo.query('Customer', customerSchema, { orderBy: 'DisplayName' });
      return rows;
    });
  }

  async items(): Promise<Item[]> {
    return this.cached('items', LIST_TTL_MS, async () => {
      const { rows } = await this.qbo.query('Item', itemSchema, { orderBy: 'Name' });
      // Categories only group items in the UI; they can't go on an invoice.
      return rows.filter((i) => i.Type !== 'Category');
    });
  }

  async taxCodes(): Promise<TaxCode[]> {
    return this.cached('taxcodes', 60 * LIST_TTL_MS, async () => {
      const { rows } = await this.qbo.query('TaxCode', taxCodeSchema);
      return rows.filter((t) => t.Active);
    });
  }

  async company(): Promise<Company> {
    return this.cached('company', 60 * LIST_TTL_MS, async () => {
      const c = await this.qbo.connection();
      const [info, prefs] = await Promise.all([
        this.qbo.read('CompanyInfo', c.realmId, companyInfoSchema),
        this.qbo.read('Preferences', '', preferencesSchema).catch(() => undefined),
      ]);
      const month = MONTHS.indexOf((info.FiscalYearStartMonth ?? '').toLowerCase());
      return {
        ...info,
        homeCurrency:
          prefs?.CurrencyPrefs?.HomeCurrency?.value ?? (info.Country === 'CA' ? 'CAD' : 'USD'),
        fiscalStartMonth: month >= 0 ? month + 1 : 1,
      };
    });
  }

  async customer(input: string): Promise<Customer> {
    return resolve(await this.customers(), input, 'customer', (c) => [
      c.DisplayName,
      c.CompanyName ?? '',
      [c.GivenName, c.FamilyName].filter(Boolean).join(' '),
    ]);
  }

  async item(input: string): Promise<Item> {
    return resolve(await this.items(), input, 'item', (i) => [
      i.Name,
      i.FullyQualifiedName ?? '',
      i.Sku ?? '',
    ]);
  }

  async taxCode(input: string): Promise<TaxCode> {
    return resolve(await this.taxCodes(), input, 'tax code', (t) => [t.Name]);
  }
}

const idLike = z.string().regex(/^\d+$/);

/**
 * An id, or a name that identifies exactly one entry. Ambiguity is an error listing the
 * candidates with ids, so the model asks the user or retries with an id, rather than us
 * guessing which "Smith" to invoice.
 */
function resolve<T extends { Id: string }>(
  list: readonly T[],
  input: string,
  what: string,
  names: (t: T) => string[],
): T {
  const trimmed = input.trim().replace(/^\[?id:(\d+)\]?$/i, '$1');
  if (idLike.safeParse(trimmed).success) {
    const byId = list.find((t) => t.Id === trimmed);
    if (byId) return byId;
  }
  const matches = matchByName(list, trimmed, names);
  const exact = matches.filter((t) =>
    names(t).some((n) => normalizeName(n) === normalizeName(trimmed)),
  );
  if (exact.length === 1) return exact[0]!;
  if (matches.length === 1) return matches[0]!;
  const tool = what === 'customer' ? 'find_customers' : what === 'item' ? 'find_items' : null;
  if (matches.length === 0) {
    throw new NotFoundError(`No active ${what} matches "${input}".`, {
      hint: tool
        ? `Use ${tool} to see what exists, or ask the user. Don't create one: these tools can't.`
        : 'Ask the user which one to use.',
    });
  }
  const shown = (exact.length > 1 ? exact : matches)
    .slice(0, 8)
    .map((t) => `${names(t)[0]} [id:${t.Id}]`)
    .join('; ');
  throw new InvalidInputError(`"${input}" matches more than one ${what}: ${shown}.`, {
    hint: `Ask the user which one they mean, then pass its id.`,
  });
}
