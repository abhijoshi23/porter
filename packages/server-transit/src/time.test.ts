import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatGtfsTime,
  formatLocal,
  parseGtfsTime,
  parseUserTime,
  serviceDayStart,
  weekdayOf,
} from './time.js';

const TZ = 'America/Toronto';
const at = (date: string, secs: number) => formatLocal(serviceDayStart(date, TZ) + secs * 1000, TZ);

describe('GTFS time strings', () => {
  it('parses times past midnight and HSR-style padding', () => {
    expect(parseGtfsTime('08:15:00')).toBe(8 * 3600 + 15 * 60);
    expect(parseGtfsTime(' 4:30:00')).toBe(4.5 * 3600); // HSR writes this
    expect(parseGtfsTime('31:01:49')).toBe(31 * 3600 + 1 * 60 + 49); // TTC's latest trip
    expect(parseGtfsTime('')).toBeNull();
    expect(parseGtfsTime('8:75:00')).toBeNull();
    expect(formatGtfsTime(25 * 3600 + 5)).toBe('25:00:05');
  });
});

describe('service days', () => {
  it('a 24:40 trip on Friday runs at 00:40 Saturday', () => {
    expect(at('20261030', parseGtfsTime('24:40:00')!)).toBe('2026-10-31T00:40:00-04:00');
  });

  it('on the fall-back day, 00:00 is 1 a.m. by the clock (noon minus 12 h)', () => {
    // 2026-11-01: clocks go 02:00 EDT → 01:00 EST. Noon is EST, so noon − 12 h = 00:00 EST = 01:00 EDT.
    expect(at('20261101', 0)).toBe('2026-11-01T01:00:00-04:00');
    // And 08:00:00 is 08:00 EST, as riders expect.
    expect(at('20261101', 8 * 3600)).toBe('2026-11-01T08:00:00-05:00');
  });

  it('on the spring-forward day, 00:00 is 11 p.m. the evening before', () => {
    // 2026-03-08: 02:00 EST → 03:00 EDT. Noon EDT − 12 h = 23:00 EST on 7 March.
    expect(at('20260308', 0)).toBe('2026-03-07T23:00:00-05:00');
    expect(at('20260308', 8 * 3600)).toBe('2026-03-08T08:00:00-04:00');
  });

  it('ordinary days start at midnight', () => {
    expect(at('20261102', 0)).toBe('2026-11-02T00:00:00-05:00');
    expect(at('20260715', 0)).toBe('2026-07-15T00:00:00-04:00');
  });

  it('date arithmetic crosses months and years', () => {
    expect(addDays('20261231', 1)).toBe('20270101');
    expect(addDays('20260301', -1)).toBe('20260228');
    expect(weekdayOf('20261102')).toBe(0); // Monday
    expect(weekdayOf('20261101')).toBe(6); // Sunday
  });
});

describe('parseUserTime', () => {
  const now = Date.parse('2026-11-02T13:00:00Z'); // 08:00 EST

  it('reads a bare clock time as today in the agency zone', () => {
    expect(formatLocal(parseUserTime('17:30', TZ, now), TZ)).toBe('2026-11-02T17:30:00-05:00');
  });

  it('accepts local date-times and offset instants', () => {
    expect(formatLocal(parseUserTime('2026-07-01T09:00', TZ, now), TZ)).toBe(
      '2026-07-01T09:00:00-04:00',
    );
    expect(parseUserTime('2026-11-02T14:00:00Z', TZ, now)).toBe(Date.parse('2026-11-02T14:00:00Z'));
  });

  it('handles the DST gap and overlap without crashing', () => {
    // 02:30 on spring-forward day doesn't exist: take 03:30 EDT.
    expect(formatLocal(parseUserTime('2026-03-08T02:30', TZ, now), TZ)).toBe(
      '2026-03-08T03:30:00-04:00',
    );
    // 01:30 on fall-back day happens twice: take the first (EDT).
    expect(formatLocal(parseUserTime('2026-11-01T01:30', TZ, now), TZ)).toBe(
      '2026-11-01T01:30:00-04:00',
    );
  });

  it('rejects nonsense with a hint', () => {
    expect(() => parseUserTime('after lunch', TZ, now)).toThrow(InvalidInputError);
    expect(() => parseUserTime('25:00', TZ, now)).toThrow(/not a valid clock time/);
  });
});
