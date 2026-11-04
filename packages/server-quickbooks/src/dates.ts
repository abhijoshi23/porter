import { InvalidInputError } from '@abhijoshi23/porter-toolkit';

/**
 * QuickBooks transaction dates are plain calendar dates with no time zone. "Today", and so
 * "overdue" and "this month", depend on where the business is: 9 pm in Toronto on the 31st
 * is already the 1st in UTC.
 */
export function todayIn(tz: string, now: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DAY = 86_400_000;

const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY);
}

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY);
}

export function isDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return fromUtc(toUtc(d)) === d; // rejects 2026-02-30
}

function monthStart(y: number, m: number): string {
  // m may be out of 0-11; Date.UTC normalizes it.
  return fromUtc(Date.UTC(y, m, 1));
}

export const PERIODS = [
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'last_12_months',
] as const;
export type Period = (typeof PERIODS)[number];

export interface Range {
  start: string;
  end: string;
  label: string;
}

/**
 * Calendar periods. "This" periods run to today, not to the end of the period, so a
 * month-to-date P&L doesn't silently include future-dated transactions. `fiscalStartMonth`
 * (1-12) shifts quarters and years for companies whose fiscal year isn't January.
 */
export function periodRange(p: Period, today: string, fiscalStartMonth = 1): Range {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7) - 1;
  const fs = fiscalStartMonth - 1;
  const fiscal = fs !== 0;
  // Months since the fiscal year began (0-11), and that year's start.
  const intoYear = (m - fs + 12) % 12;
  const yearStart = monthStart(y, m - intoYear);
  const qStart = monthStart(y, m - (intoYear % 3));
  const fy = fiscal ? 'fiscal ' : '';
  switch (p) {
    case 'this_month':
      return { start: monthStart(y, m), end: today, label: 'this month to date' };
    case 'last_month':
      return {
        start: monthStart(y, m - 1),
        end: addDays(monthStart(y, m), -1),
        label: 'last month',
      };
    case 'this_quarter':
      return { start: qStart, end: today, label: `this ${fy}quarter to date` };
    case 'last_quarter': {
      const start = addMonths(qStart, -3);
      return { start, end: addDays(qStart, -1), label: `last ${fy}quarter` };
    }
    case 'this_year':
      return { start: yearStart, end: today, label: `this ${fy}year to date` };
    case 'last_year':
      return {
        start: addMonths(yearStart, -12),
        end: addDays(yearStart, -1),
        label: `last ${fy}year`,
      };
    case 'last_12_months':
      return {
        start: addDays(addMonths(today, -12), 1),
        end: today,
        label: 'the last 12 months',
      };
  }
}

/** Same day `n` months away, clamped to the month's last day (Mar 31 − 1 month = Feb 28). */
export function addMonths(d: string, n: number): string {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 + n;
  const day = +d.slice(8, 10);
  const last = +fromUtc(Date.UTC(y, m + 1, 0)).slice(8, 10);
  return fromUtc(Date.UTC(y, m, Math.min(day, last)));
}

/**
 * The range just before `r`, for "compared with the previous period". Ranges that start on
 * the 1st move back by whole months (October → September, Q3 → Q2, Nov 1-4 → Oct 1-4);
 * other ranges move back by their length in days.
 */
export function previousRange(r: Range): Range {
  if (r.start.endsWith('-01')) {
    const months =
      (+r.end.slice(0, 4) - +r.start.slice(0, 4)) * 12 +
      (+r.end.slice(5, 7) - +r.start.slice(5, 7)) +
      1;
    const monthEnd = addDays(addMonths(r.end.slice(0, 8) + '01', 1), -1) === r.end;
    const end = monthEnd ? addDays(r.start, -1) : addMonths(r.end, -months);
    return { start: addMonths(r.start, -months), end, label: 'the previous period' };
  }
  const len = daysBetween(r.start, r.end);
  const end = addDays(r.start, -1);
  return { start: addDays(end, -len), end, label: 'the previous period' };
}

/** The same dates one year earlier. */
export function yearEarlier(r: Range): Range {
  return { start: addMonths(r.start, -12), end: addMonths(r.end, -12), label: 'a year earlier' };
}

export function customRange(start: string, end: string): Range {
  for (const d of [start, end]) {
    if (!isDate(d)) {
      throw new InvalidInputError(`"${d}" is not a valid date.`, { hint: 'Use YYYY-MM-DD.' });
    }
  }
  if (start > end) {
    throw new InvalidInputError(`The start date ${start} is after the end date ${end}.`);
  }
  if (daysBetween(start, end) > 3 * 366) {
    throw new InvalidInputError('Ranges longer than three years are not supported.', {
      hint: 'Ask for one year at a time.',
    });
  }
  return { start, end, label: `${start} to ${end}` };
}
