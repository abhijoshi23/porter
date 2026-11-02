import type { FeedMeta } from './feed-db.js';
import { addDays, localParts, serviceDayStart } from './time.js';

export interface ServiceWindow {
  /** Service day, `YYYYMMDD`. */
  date: string;
  /** Instant that day's GTFS times count from. */
  startMs: number;
  /** The requested instant range, as GTFS seconds on this service day. */
  fromSecs: number;
  toSecs: number;
}

/**
 * Which service days can have departures in [fromMs, toMs], and what range of GTFS
 * seconds that is on each.
 *
 * A departure at 00:30 on Tuesday is either Tuesday's 00:30:00 or Monday's 24:30:00, and
 * which one depends on how the agency wrote it. So we look back as many days as the feed's
 * latest time needs (TTC's 31:01:49 reaches 7 a.m. the next day: one day back), and query
 * each service day separately.
 */
export function serviceWindows(meta: FeedMeta, fromMs: number, toMs: number): ServiceWindow[] {
  const tz = meta.timezone;
  const lookBack = Math.max(1, Math.ceil(meta.maxSecs / 86_400) - 1);
  const first = addDays(localParts(fromMs, tz).date, -lookBack);
  const last = localParts(toMs, tz).date;
  const out: ServiceWindow[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const startMs = serviceDayStart(d, tz);
    const fromSecs = Math.max(0, Math.floor((fromMs - startMs) / 1000));
    const toSecs = Math.floor((toMs - startMs) / 1000);
    if (toSecs < 0 || fromSecs > meta.maxSecs) continue;
    out.push({ date: d, startMs, fromSecs, toSecs });
  }
  return out;
}

/** A note when the requested time is outside the dates the feed covers. */
export function coverageNote(meta: FeedMeta, windows: ServiceWindow[]): string | null {
  if (!meta.serviceStart || !meta.serviceEnd) return null;
  const outside = windows.every((w) => w.date < meta.serviceStart || w.date > meta.serviceEnd);
  if (!outside) return null;
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return `The published schedule covers ${iso(meta.serviceStart)} to ${iso(meta.serviceEnd)}; the requested time is outside it, so no service is listed.`;
}
