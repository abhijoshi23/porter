import { silentLogger, type HttpClient } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { AGENCIES } from './agencies.js';
import { decodeFeed } from './gtfs-rt.js';
import { predict, RealtimeClient } from './realtime.js';
import { feedMessage, type TestTripUpdate } from './testing/pb-writer.js';

const SCHED = Date.parse('2026-11-02T13:05:00Z'); // 08:05 EST
const S = SCHED / 1000;

function index(trips: TestTripUpdate[]) {
  const byTrip = new Map<string, ReturnType<typeof decodeFeed>['tripUpdates']>();
  for (const tu of decodeFeed(feedMessage({ timestamp: S, trips })).tripUpdates) {
    byTrip.set(tu.tripId!, [...(byTrip.get(tu.tripId!) ?? []), tu]);
  }
  return { state: { status: 'live' as const, feedTimestamp: '', ageSeconds: 0 }, byTrip };
}
const dep = { tripId: 'T1', seq: 2, stopId: 'S3A', serviceDate: '20261102', scheduledMs: SCHED };

describe('predict', () => {
  it('uses the stop’s predicted time and computes the delay', () => {
    const p = predict(
      index([{ tripId: 'T1', startDate: '20261102', stops: [{ seq: 2, time: S + 180 }] }]),
      dep,
    );
    expect(p).toEqual({ status: 'predicted', expectedMs: SCHED + 180_000, delaySeconds: 180 });
  });

  it('ignores another day’s run of the same trip_id', () => {
    const p = predict(
      index([{ tripId: 'T1', startDate: '20261030', stops: [{ seq: 2, time: S + 600 }] }]),
      dep,
    );
    expect(p.status).toBe('scheduled');
  });

  it('without start_date, accepts only predictions near the scheduled time (TTC)', () => {
    expect(predict(index([{ tripId: 'T1', stops: [{ seq: 2, time: S + 60 }] }]), dep).status).toBe(
      'predicted',
    );
    expect(
      predict(index([{ tripId: 'T1', stops: [{ seq: 2, time: S + 86_400 }] }]), dep).status,
    ).toBe('scheduled');
  });

  it('matches by stop_sequence even when realtime stop_ids differ (TTC)', () => {
    const p = predict(
      index([
        {
          tripId: 'T1',
          startDate: '20261102',
          stops: [{ seq: 2, stopId: 'rt-9999', time: S - 60 }],
        },
      ]),
      dep,
    );
    expect(p).toMatchObject({ status: 'predicted', delaySeconds: -60 });
  });

  it('reports cancellations, skipped stops and vehicles that have passed', () => {
    expect(
      predict(index([{ tripId: 'T1', startDate: '20261102', canceled: true }]), dep).status,
    ).toBe('canceled');
    expect(
      predict(
        index([{ tripId: 'T1', startDate: '20261102', stops: [{ seq: 2, skipped: true }] }]),
        dep,
      ).status,
    ).toBe('skipped');
    expect(
      predict(
        index([{ tripId: 'T1', startDate: '20261102', stops: [{ seq: 3, time: S + 600 }] }]),
        dep,
      ).status,
    ).toBe('departed');
  });

  it('propagates an upstream delay to later stops', () => {
    const p = predict(
      index([
        { tripId: 'T1', startDate: '20261102', vehicle: '2101', stops: [{ seq: 1, delay: 240 }] },
      ]),
      dep,
    );
    expect(p).toEqual({
      status: 'predicted',
      expectedMs: SCHED + 240_000,
      delaySeconds: 240,
      vehicle: '2101',
    });
  });

  it('untracked trips stay scheduled', () => {
    expect(predict(index([]), dep)).toEqual({ status: 'scheduled' });
  });
});

describe('RealtimeClient', () => {
  const http = (bytes: Uint8Array | Error) =>
    ({
      getBytes: async () => {
        if (bytes instanceof Error) throw bytes;
        return bytes;
      },
    }) as unknown as HttpClient;
  const now = () => SCHED;

  it('ignores a stale feed and says why (GRT served a February snapshot in November)', async () => {
    const rt = new RealtimeClient({
      http: http(
        feedMessage({
          timestamp: Date.parse('2026-02-17T03:59:47Z') / 1000,
          trips: [{ tripId: 'T1' }],
        }),
      ),
      log: silentLogger,
      maxAgeSeconds: 300,
      now,
    });
    const r = await rt.tripUpdates(AGENCIES.grt);
    expect(r.state).toMatchObject({ status: 'stale' });
    expect(r.state.status === 'stale' && r.state.note).toMatch(/last updated 25\d days ago/);
    expect(r.byTrip.size).toBe(0);
  });

  it('degrades to scheduled when the feed is down or garbage, never throws', async () => {
    const down = new RealtimeClient({
      http: http(new Error('ECONNRESET')),
      log: silentLogger,
      maxAgeSeconds: 300,
      now,
    });
    expect((await down.tripUpdates(AGENCIES.hsr)).state.status).toBe('unavailable');
    const junk = new RealtimeClient({
      http: http(new TextEncoder().encode('<html>')),
      log: silentLogger,
      maxAgeSeconds: 300,
      now,
    });
    expect((await junk.tripUpdates(AGENCIES.hsr)).state.status).toBe('unavailable');
  });

  it('explains why GO has no realtime', async () => {
    const rt = new RealtimeClient({
      http: http(new Error('unused')),
      log: silentLogger,
      maxAgeSeconds: 300,
      now,
    });
    const r = await rt.tripUpdates(AGENCIES.go);
    expect(r.state).toEqual({
      status: 'unavailable',
      note: expect.stringContaining('Metrolinx API key'),
    });
  });
});
