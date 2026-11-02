import { InvalidInputError } from '@abhijoshi23/porter-toolkit';

/**
 * GTFS time handling. Three things make transit time unlike ordinary clock time:
 *
 * 1. **Service days, not calendar days.** A trip belongs to the service day it starts on.
 *    A bus leaving at 00:40 after a Friday-night run is usually part of Friday's service,
 *    so GTFS writes it as `24:40:00`. Real feeds go past 30:00 (TTC has `31:01:49`).
 * 2. **Times are offsets from "noon minus 12 hours"**, not from midnight. On most days
 *    that *is* midnight. On the two DST-change days it is not: on the fall-back day, noon
 *    minus 12 h is 01:00 by the wall clock, so `00:00:00` means 1 a.m. The GTFS
 *    reference defines it this way so offsets stay continuous across the change.
 * 3. **Times are in the agency's time zone**, never UTC. All four Ontario agencies use
 *    America/Toronto, but nothing here assumes that.
 *
 * Absolute instants are plain epoch milliseconds. Dates are GTFS `YYYYMMDD` strings.
 */

/** Parses `HH:MM:SS` into seconds after the service-day start. Tolerates `" 4:30:00"` (HSR). */
export function parseGtfsTime(s: string): number | null {
  const m = /^\s*(\d{1,3}):([0-5]\d):([0-5]\d)\s*$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Seconds → `HH:MM:SS`, keeping hours ≥ 24 the way GTFS writes them. */
export function formatGtfsTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  /** `YYYYMMDD` */
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday (GTFS calendar.txt column order). */
  weekday: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Wall-clock parts of an instant in a time zone. */
export function localParts(epochMs: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const { type, value } of formatter(tz).formatToParts(epochMs)) p[type] = value;
  return {
    date: `${p.year}${p.month}${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday!),
  };
}

/** UTC offset of `tz` at an instant, in milliseconds (−4 h → −14 400 000). */
export function offsetMs(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const asUtc = Date.UTC(
    Number(p.date.slice(0, 4)),
    Number(p.date.slice(4, 6)) - 1,
    Number(p.date.slice(6, 8)),
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant GTFS times on `date` are measured from: local noon minus 12 hours.
 * Noon is never inside a DST gap or overlap, so it maps to exactly one instant.
 */
export function serviceDayStart(date: string, tz: string): number {
  const noonAsUtc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    12,
  );
  // Guess with the offset at the guess, then correct once: enough for any real zone.
  let t = noonAsUtc - offsetMs(noonAsUtc, tz);
  t = noonAsUtc - offsetMs(t, tz);
  return t - 12 * 3600_000;
}

/** `YYYYMMDD` plus `days` (may be negative). */
export function addDays(date: string, days: number): string {
  const d = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Day of week for a `YYYYMMDD` date, 0 = Monday. */
export function weekdayOf(date: string): number {
  const d = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
  );
  return (new Date(d).getUTCDay() + 6) % 7;
}

/** `20261102` → `2026-11-02` */
export function isoDate(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** An instant as local ISO 8601 with offset, e.g. `2026-11-02T08:15:00-05:00`. */
export function formatLocal(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  const off = offsetMs(epochMs, tz) / 60_000;
  const sign = off < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  const two = (n: number) => String(n).padStart(2, '0');
  return `${isoDate(p.date)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}${sign}${hh}:${mm}`;
}

/** `08:15` in the zone, for summaries a person reads. */
export function formatClock(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Parses a user-supplied time. Accepts an ISO instant with an offset or `Z`, a local
 * date-time (`2026-11-02T08:15`, read in the agency zone), or a bare local time
 * (`08:15`, today in the agency zone). Returns epoch ms.
 */
export function parseUserTime(input: string, tz: string, now: number): number {
  const s = input.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return Date.parse(s);

  const m = /^(?:(\d{4})-(\d{2})-(\d{2})[T ])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) {
    throw new InvalidInputError(`Could not read the time "${input}".`, {
      hint: 'Use local time like "08:15" or "2026-11-02T08:15", or an ISO instant with an offset.',
    });
  }
  const date = m[1] ? `${m[1]}${m[2]}${m[3]}` : localParts(now, tz).date;
  const [h, min, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || min > 59 || sec > 59) {
    throw new InvalidInputError(`"${input}" is not a valid clock time.`, {
      hint: 'Hours 0–23. For after-midnight service just use the next day’s date.',
    });
  }
  // Local wall time → instant. Try both offsets in play around the moment; keep one that
  // reads back as the requested wall time (in the fall-back overlap, the first one). In
  // the spring-forward gap (02:30 doesn't exist) neither does, and we take the later
  // instant (03:30), which is what a rider means.
  const asUtc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    h,
    min,
    sec,
  );
  const a = asUtc - offsetMs(asUtc, tz);
  const b = asUtc - offsetMs(a, tz);
  const reads = (t: number) => {
    const p = localParts(t, tz);
    return p.date === date && p.hour === h && p.minute === min;
  };
  const ok = [a, b].filter(reads).sort((x, y) => x - y);
  return ok[0] ?? Math.max(a, b);
}
