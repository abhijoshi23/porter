/**
 * Money is added up in integer cents. QuickBooks sends amounts as JSON numbers, and summing
 * 0.1 + 0.2 as floats gives 0.30000000000000004: harmless once, visibly wrong in a column
 * total of 400 invoices.
 */
export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => cents / 100;

export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((s, a) => s + toCents(a), 0);
}

/** Each currency in its home locale, so both USD and CAD show as "$1,234.50". */
const LOCALES: Record<string, string> = {
  USD: 'en-US',
  CAD: 'en-CA',
  GBP: 'en-GB',
  AUD: 'en-AU',
  EUR: 'en-IE',
  INR: 'en-IN',
};

/** "$1,234.50", "£1,234.50": for summaries. Structured output keeps plain numbers and the currency code. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(LOCALES[currency] ?? 'en-CA', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
