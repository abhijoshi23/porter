import { MemoryCache, type HttpClient, type Logger } from '@abhijoshi23/porter-toolkit';
import type { Agency } from './agencies.js';
import { decodeFeed, type Alert, type FeedMessage, type TripUpdate } from './gtfs-rt.js';

/** Why there are, or aren't, live predictions. Always reported, so the model never presents a schedule as live. */
export type RealtimeState =
  | { status: 'live'; feedTimestamp: string; ageSeconds: number }
  | { status: 'stale'; feedTimestamp: string; ageSeconds: number; note: string }
  | { status: 'unavailable'; note: string };

export interface Prediction {
  /**
   * - `predicted`: the agency's live estimate for this stop.
   * - `scheduled`: no live estimate for this run (realtime off, stale, or not tracked).
   * - `canceled`: the run is cancelled. `skipped`: it won't stop here.
   * - `departed`: live data says the vehicle has already passed this stop.
   */
  status: 'predicted' | 'scheduled' | 'canceled' | 'skipped' | 'departed';
  expectedMs?: number;
  /** Seconds late (negative = early). */
  delaySeconds?: number;
  vehicle?: string;
}

interface Index {
  state: RealtimeState;
  byTrip: Map<string, TripUpdate[]>;
}

const NOT_TRACKED: Prediction = { status: 'scheduled' };

/**
 * Fetches and interprets GTFS-RT. Feeds are cached for 30 s: producers update every
 * 15–30 s, and many tool calls in one conversation shouldn't each hit the agency.
 *
 * Realtime is best-effort by design. Any failure (network, decode, stale feed) degrades
 * to scheduled times with a `realtime.status` that says why, and never fails the tool
 * call. A stale feed is a real case: on 2026-11-02 GRT's trip-updates feed was serving a
 * snapshot from February. Treating that as live would invent delays.
 */
export class RealtimeClient {
  private readonly feeds = new MemoryCache<FeedMessage>({ max: 16, ttlMs: 30_000 });

  constructor(
    private readonly o: {
      http: HttpClient;
      log: Logger;
      maxAgeSeconds: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async fetch(url: string): Promise<FeedMessage> {
    return this.feeds.getOrLoad(url, async () =>
      decodeFeed(await this.o.http.getBytes(url, { timeoutMs: 10_000 })),
    );
  }

  private freshness(feed: FeedMessage): RealtimeState {
    if (!feed.timestamp) return { status: 'live', feedTimestamp: 'unknown', ageSeconds: 0 };
    const ageSeconds = Math.max(0, Math.round(this.now() / 1000 - feed.timestamp));
    const feedTimestamp = new Date(feed.timestamp * 1000).toISOString();
    if (ageSeconds > this.o.maxAgeSeconds) {
      return {
        status: 'stale',
        feedTimestamp,
        ageSeconds,
        note: `The agency's realtime feed was last updated ${describeAge(ageSeconds)} ago, so it was ignored. Times shown are scheduled.`,
      };
    }
    return { status: 'live', feedTimestamp, ageSeconds };
  }

  /** Trip updates, indexed by trip_id. */
  async tripUpdates(agency: Agency): Promise<Index> {
    if (!agency.realtime) {
      return {
        state: { status: 'unavailable', note: agency.realtimeNote ?? 'No open realtime feed.' },
        byTrip: new Map(),
      };
    }
    let feed: FeedMessage;
    try {
      feed = await this.fetch(agency.realtime.tripUpdates);
    } catch (err) {
      this.o.log.warn({ agency: agency.id, err: String(err) }, 'realtime fetch failed');
      return {
        state: {
          status: 'unavailable',
          note: 'The realtime feed could not be reached just now. Times shown are scheduled.',
        },
        byTrip: new Map(),
      };
    }
    const state = this.freshness(feed);
    const byTrip = new Map<string, TripUpdate[]>();
    if (state.status === 'live') {
      for (const tu of feed.tripUpdates) {
        if (!tu.tripId) continue;
        byTrip.set(tu.tripId, [...(byTrip.get(tu.tripId) ?? []), tu]);
      }
    }
    return { state, byTrip };
  }

  async alerts(agency: Agency): Promise<{ state: RealtimeState; alerts: Alert[] }> {
    if (!agency.realtime?.alerts) {
      return {
        state: {
          status: 'unavailable',
          note: agency.realtimeNote ?? 'No open service-alerts feed.',
        },
        alerts: [],
      };
    }
    try {
      const feed = await this.fetch(agency.realtime.alerts);
      // Alerts describe the future too (planned closures), so age matters less; still report it.
      return { state: this.freshness(feed), alerts: feed.alerts };
    } catch (err) {
      this.o.log.warn({ agency: agency.id, err: String(err) }, 'alerts fetch failed');
      return {
        state: {
          status: 'unavailable',
          note: 'The service-alerts feed could not be reached just now.',
        },
        alerts: [],
      };
    }
  }
}

/**
 * Matches one scheduled departure to the live data.
 *
 * - A trip_id repeats every day, so when the producer gives `start_date` it must equal
 *   the departure's service day. When it doesn't (TTC), accept the update only if its
 *   prediction lies within 3 hours of the scheduled time.
 * - Stops are matched by `stop_sequence` first: it is unique within a trip, while a loop
 *   route visits some stop_ids twice, and TTC's realtime stop_ids often differ from its
 *   static ones. Then by stop_id.
 * - Producers drop stops a vehicle has passed. If every update for the trip is for a later
 *   stop, the vehicle has gone by.
 * - With no update for this stop but a known delay upstream, the delay carries forward
 *   (GTFS-RT "propagation").
 */
export function predict(
  index: Index,
  d: { tripId: string; seq: number; stopId: string; serviceDate: string; scheduledMs: number },
): Prediction {
  const candidates = index.byTrip.get(d.tripId);
  if (!candidates) return NOT_TRACKED;
  const tu =
    candidates.find((t) => t.startDate === d.serviceDate) ??
    candidates.find((t) => !t.startDate && withinWindow(t, d.scheduledMs));
  if (!tu) return NOT_TRACKED;
  const vehicle = tu.vehicleLabel ? { vehicle: tu.vehicleLabel } : {};

  // 3 CANCELED, 7 DELETED
  if (tu.scheduleRelationship === 3 || tu.scheduleRelationship === 7) {
    return { status: 'canceled', ...vehicle };
  }

  const stu =
    tu.stopTimeUpdates.find((u) => u.stopSequence === d.seq) ??
    tu.stopTimeUpdates.find((u) => u.stopSequence === undefined && u.stopId === d.stopId);

  if (stu) {
    if (stu.scheduleRelationship === 1) return { status: 'skipped', ...vehicle };
    if (stu.scheduleRelationship === 2) return { ...NOT_TRACKED, ...vehicle }; // NO_DATA
    const ev = stu.departure ?? stu.arrival;
    if (ev?.time) {
      const expectedMs = ev.time * 1000;
      return {
        status: 'predicted',
        expectedMs,
        delaySeconds: Math.round((expectedMs - d.scheduledMs) / 1000),
        ...vehicle,
      };
    }
    if (ev?.delay !== undefined) {
      return {
        status: 'predicted',
        expectedMs: d.scheduledMs + ev.delay * 1000,
        delaySeconds: ev.delay,
        ...vehicle,
      };
    }
  }

  const seqs = tu.stopTimeUpdates.map((u) => u.stopSequence).filter((s) => s !== undefined);
  if (seqs.length > 0 && seqs.every((s) => s > d.seq)) return { status: 'departed', ...vehicle };

  const upstream = tu.stopTimeUpdates
    .filter((u) => u.stopSequence !== undefined && u.stopSequence < d.seq)
    .sort((a, b) => b.stopSequence! - a.stopSequence!)
    .map((u) => (u.departure ?? u.arrival)?.delay)
    .find((x) => x !== undefined);
  const delay = upstream ?? tu.delay;
  if (delay !== undefined) {
    return {
      status: 'predicted',
      expectedMs: d.scheduledMs + delay * 1000,
      delaySeconds: delay,
      ...vehicle,
    };
  }
  return { ...NOT_TRACKED, ...vehicle };
}

function withinWindow(tu: TripUpdate, scheduledMs: number): boolean {
  const t = tu.stopTimeUpdates.map((u) => (u.departure ?? u.arrival)?.time).find((x) => x);
  return t !== undefined && Math.abs(t * 1000 - scheduledMs) < 3 * 3600_000;
}

function describeAge(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}
