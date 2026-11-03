/**
 * CanadaBuys date-times carry no zone. Its data dictionary says they are all UTC−05:00
 * ("Eastern Standard Time, even in summer"), but the data disagrees: closing times
 * cluster at 14:00 in July as in January, and descriptions of the same notices say
 * "14:00 EDT" in summer. (2 p.m. Eastern is the federal government's standard closing
 * time.) A notice closing "2:00 PM ADT" is stored as 13:00, which is 2 p.m. Atlantic in
 * Eastern wall time. So we read them as wall-clock time in America/Toronto, DST included.
 * See docs/decisions-log.md (2026-11-03).
 */
export const TZ = 'America/Toronto';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function parts(epochMs: number): number[] {
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(epochMs)) p[type] = value;
  return [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number);
}

/** Toronto's UTC offset at an instant, in minutes (−240 in summer, −300 in winter). */
export function offsetMinutes(epochMs: number): number {
  const [y, mo, d, h, mi, s] = parts(epochMs);
  return (Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) - Math.floor(epochMs / 1000) * 1000) / 60_000;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * `2026-07-14T14:00:00` (Toronto wall time) → epoch ms. A date alone means the end of
 * that day (23:59:59), the reading that never tells a bidder they're too late too early.
 * In the fall-back overlap the first (daylight) instant is used; times in the
 * spring-forward gap don't occur in practice and land an hour later.
 */
export function easternToEpoch(local: string): number | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = m[4] ? [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : [23, 59, 59];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(asUtc) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Try both of the zone's offsets around this date; keep the one that round-trips,
  // preferring the earlier instant (daylight time) in the overlap.
  const candidates = [-240, -300]
    .map((off) => asUtc - off * 60_000)
    .filter((t) => offsetMinutes(t) * 60_000 === asUtc - t);
  return candidates.length ? Math.min(...candidates) : asUtc + 300 * 60_000;
}

/** Epoch ms → `2026-07-14T14:00:00-04:00`. */
export function formatEastern(epochMs: number): string {
  const [y, mo, d, h, mi, s] = parts(epochMs);
  const off = offsetMinutes(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = off < 0 ? '-' : '+';
  return `${y}-${pad(mo!)}-${pad(d!)}T${pad(h!)}:${pad(mi!)}:${pad(s!)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Epoch ms → `Fri 2026-11-20 14:00 ET`, for summaries. */
export function describeEastern(epochMs: number): string {
  const wd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short' }).format(epochMs);
  return `${wd} ${formatEastern(epochMs).slice(0, 16).replace('T', ' ')} ET`;
}

/** Today's date in Toronto, `YYYY-MM-DD`. */
export function easternDate(epochMs: number): string {
  return formatEastern(epochMs).slice(0, 10);
}
