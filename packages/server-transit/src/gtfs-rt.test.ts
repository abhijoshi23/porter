import { readFileSync } from 'node:fs';
import { PorterError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { decodeFeed } from './gtfs-rt.js';
import { feedMessage, msg } from './testing/pb-writer.js';

describe('GTFS-RT decoder', () => {
  it('round-trips trip updates, including negative delays and cancellations', () => {
    const bytes = feedMessage({
      timestamp: 1_793_000_000,
      withExtension: true,
      trips: [
        {
          tripId: 'T1',
          startDate: '20261102',
          vehicle: 'Bus 2101',
          stops: [
            { seq: 1, stopId: 'S1', time: 1_793_000_180 },
            { seq: 2, delay: -120 }, // two minutes early: a 10-byte varint on the wire
            { seq: 3, skipped: true },
          ],
        },
        { tripId: 'T2', canceled: true },
      ],
    });
    const feed = decodeFeed(bytes);
    expect(feed.timestamp).toBe(1_793_000_000);
    expect(feed.tripUpdates).toHaveLength(2);
    const [t1, t2] = feed.tripUpdates;
    expect(t1).toMatchObject({
      tripId: 'T1',
      startDate: '20261102',
      vehicleLabel: 'Bus 2101',
      scheduleRelationship: 0,
    });
    expect(t1!.stopTimeUpdates[0]).toMatchObject({
      stopSequence: 1,
      stopId: 'S1',
      departure: { time: 1_793_000_180 },
    });
    expect(t1!.stopTimeUpdates[1]!.departure?.delay).toBe(-120);
    expect(t1!.stopTimeUpdates[2]!.scheduleRelationship).toBe(1);
    expect(t2!.scheduleRelationship).toBe(3);
  });

  it('decodes alerts and prefers English translations', () => {
    const feed = decodeFeed(
      feedMessage({
        timestamp: 1,
        alerts: [
          {
            id: 'A1',
            header: 'Detour on King',
            description: 'Use Main St.',
            routeId: 'R1',
            start: 10,
            end: 20,
          },
        ],
      }),
    );
    expect(feed.alerts[0]).toMatchObject({
      id: 'A1',
      header: 'Detour on King',
      effect: 'DETOUR',
      informed: [{ routeId: 'R1' }],
      activePeriods: [{ start: 10, end: 20 }],
    });
  });

  it('decodes a real producer’s feed (TTC alerts, 2026-11-02)', () => {
    const feed = decodeFeed(
      readFileSync(new URL('../test/fixtures/ttc-alerts-2026-11-02.pb', import.meta.url)),
    );
    expect(feed.alerts.length).toBe(11);
    expect(feed.alerts.every((a) => typeof a.header === 'string' && a.header.length > 0)).toBe(
      true,
    );
    expect(feed.alerts.flatMap((a) => a.informed).some((e) => e.routeId)).toBe(true);
  });

  it('rejects malformed input with a PorterError instead of hanging or crashing', () => {
    const good = feedMessage({
      timestamp: 5,
      trips: [{ tripId: 'T1', stops: [{ seq: 1, time: 9 }] }],
    });
    for (let cut = 1; cut < good.length; cut++) {
      try {
        decodeFeed(good.subarray(0, cut));
      } catch (e) {
        expect(e).toBeInstanceOf(PorterError);
      }
    }
    expect(() => decodeFeed(Uint8Array.from([0x0a, 0xff, 0xff, 0xff, 0x0f]))).toThrow(PorterError);
    expect(() => decodeFeed(Uint8Array.from([0x0b]))).toThrow(/wire type/); // field 1, wire type 3 (group)
    expect(decodeFeed(new Uint8Array(0))).toEqual({ tripUpdates: [], alerts: [] });
    // An HTML error page served with status 200 must not decode as a feed.
    expect(() =>
      decodeFeed(new TextEncoder().encode('<html><body>Service Unavailable</body></html>')),
    ).toThrow(PorterError);
  });

  it('skips deleted entities', () => {
    const entity = msg(
      [1, 'bytes', 'e'],
      [2, 'varint', 1],
      [3, 'bytes', msg([1, 'bytes', msg([1, 'bytes', 'T9'])])],
    );
    expect(decodeFeed(msg([2, 'bytes', entity])).tripUpdates).toEqual([]);
  });
});
