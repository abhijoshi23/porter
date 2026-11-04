import { describe, expect, it } from 'vitest';
import { formatMoney, fromCents, sumCents } from './money.js';

describe('money', () => {
  it('adds in cents', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(fromCents(sumCents([0.1, 0.2]))).toBe(0.3);
    expect(fromCents(sumCents([1200.4, -600.2]))).toBe(600.2);
  });

  it("formats in the currency's own locale", () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatMoney(1234.5, 'CAD')).toBe('$1,234.50');
    expect(formatMoney(-5, 'GBP')).toBe('-£5.00');
    expect(formatMoney(5, 'XXZ')).toMatch(/^XXZ\s5\.00$/); // ISO 4217 syntax, unknown code
  });
});
