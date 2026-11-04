import { describe, expect, it } from 'vitest';
import {
  addMonths,
  customRange,
  daysBetween,
  isDate,
  periodRange,
  previousRange,
  todayIn,
  yearEarlier,
} from './dates.js';

describe('todayIn', () => {
  it('uses the business time zone, not UTC', () => {
    // 2026-11-01 02:30 UTC is still Oct 31 in Toronto.
    const t = Date.parse('2026-11-01T02:30:00Z');
    expect(todayIn('America/Toronto', t)).toBe('2026-10-31');
    expect(todayIn('UTC', t)).toBe('2026-11-01');
  });
});

describe('date arithmetic', () => {
  it('counts days and clamps months', () => {
    expect(daysBetween('2026-08-31', '2026-11-04')).toBe(65);
    expect(daysBetween('2026-11-04', '2026-11-04')).toBe(0);
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-02-28')).toBe(true);
  });
});

describe('periodRange', () => {
  const today = '2026-11-04';
  it('calendar periods, current ones to date', () => {
    expect(periodRange('this_month', today)).toMatchObject({ start: '2026-11-01', end: today });
    expect(periodRange('last_month', today)).toMatchObject({
      start: '2026-10-01',
      end: '2026-10-31',
    });
    expect(periodRange('this_quarter', today)).toMatchObject({ start: '2026-10-01', end: today });
    expect(periodRange('last_quarter', today)).toMatchObject({
      start: '2026-07-01',
      end: '2026-09-30',
    });
    expect(periodRange('this_year', today)).toMatchObject({ start: '2026-01-01', end: today });
    expect(periodRange('last_year', today)).toMatchObject({
      start: '2025-01-01',
      end: '2025-12-31',
    });
    expect(periodRange('last_12_months', today)).toMatchObject({ start: '2025-11-05', end: today });
  });

  it('crosses year boundaries', () => {
    expect(periodRange('last_month', '2026-01-15')).toMatchObject({
      start: '2025-12-01',
      end: '2025-12-31',
    });
    expect(periodRange('last_quarter', '2026-02-01')).toMatchObject({
      start: '2025-10-01',
      end: '2025-12-31',
    });
  });

  it('follows a fiscal year starting in April', () => {
    expect(periodRange('this_year', today, 4)).toMatchObject({
      start: '2026-04-01',
      label: 'this fiscal year to date',
    });
    expect(periodRange('last_year', today, 4)).toMatchObject({
      start: '2025-04-01',
      end: '2026-03-31',
    });
    // Fiscal quarters: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar.
    expect(periodRange('this_quarter', today, 4)).toMatchObject({ start: '2026-10-01' });
    expect(periodRange('this_year', '2026-02-10', 4)).toMatchObject({ start: '2025-04-01' });
    expect(periodRange('this_quarter', '2026-02-10', 4)).toMatchObject({ start: '2026-01-01' });
  });
});

describe('comparison ranges', () => {
  it('moves whole months back for month-aligned ranges', () => {
    expect(previousRange({ start: '2026-10-01', end: '2026-10-31', label: '' })).toMatchObject({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(previousRange({ start: '2026-07-01', end: '2026-09-30', label: '' })).toMatchObject({
      start: '2026-04-01',
      end: '2026-06-30',
    });
    expect(previousRange({ start: '2026-03-01', end: '2026-03-31', label: '' })).toMatchObject({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    // Month to date compares with the same days of last month.
    expect(previousRange({ start: '2026-11-01', end: '2026-11-04', label: '' })).toMatchObject({
      start: '2026-10-01',
      end: '2026-10-04',
    });
  });

  it('moves other ranges back by their length', () => {
    expect(previousRange({ start: '2026-10-10', end: '2026-10-19', label: '' })).toMatchObject({
      start: '2026-09-30',
      end: '2026-10-09',
    });
  });

  it('a year earlier', () => {
    expect(yearEarlier({ start: '2024-02-01', end: '2024-02-29', label: '' })).toMatchObject({
      start: '2023-02-01',
      end: '2023-02-28',
    });
  });

  it('validates custom ranges', () => {
    expect(() => customRange('2026-05-01', '2026-04-01')).toThrow(/after the end/);
    expect(() => customRange('2026-13-01', '2026-12-01')).toThrow(/not a valid date/);
    expect(() => customRange('2020-01-01', '2026-01-01')).toThrow(/three years/);
  });
});
