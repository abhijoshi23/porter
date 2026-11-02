import { InvalidInputError, NotFoundError } from '@abhijoshi23/porter-toolkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedDb } from './feed-db.js';
import { serviceWindows } from './schedule.js';
import { resolveRoute, resolveStop, tokens } from './stops.js';
import { buildFixture } from './testing/build.js';
import { CALENDAR_DATES_ONLY, TESTVILLE } from './testing/fixture-feed.js';
import { formatLocal, parseUserTime } from './time.js';

let db: FeedDb;
beforeAll(async () => {
  db = await buildFixture(TESTVILLE);
});
afterAll(() => db.close());

const TZ = 'America/Toronto';
const MON = '20261102';

describe('loading a feed', () => {
  it('reads metadata, BOM-prefixed headers and reordered columns', () => {
    expect(db.meta).toMatchObject({
      agencyName: 'Testville Transit',
      timezone: TZ,
      version: 'TV-2026-11',
      serviceStart: '20261001',
      serviceEnd: '20261231',
      maxSecs: 25 * 3600 + 10 * 60,
    });
    expect(db.stops.get('S1')).toMatchObject({
      name: 'Main / King',
      code: '1001',
      routeIds: ['R1'],
    });
    expect(db.children.get('S3')).toEqual(['S3A', 'S3B', 'E3']);
    // A station gets the routes of its platforms.
    expect(db.stops.get('S3')!.routeIds).toEqual(['R1', 'R2', 'R3']);
  });

  it('works for a calendar_dates-only feed with files in a subfolder (GO-style)', async () => {
    const go = await buildFixture(CALENDAR_DATES_ONLY, 'GO-GTFS/');
    expect(await go.servicesOn(MON)).toEqual(['20261102']);
    expect(await go.servicesOn('20261103')).toEqual([]);
    expect(go.meta).toMatchObject({ serviceStart: MON, serviceEnd: MON, agencyName: 'GO Test' });
    go.close();
  });
});

describe('service calendars', () => {
  it('combines weekly patterns with added and removed dates', async () => {
    expect(await db.servicesOn(MON)).toEqual(['WKDY', 'XTRA']); // XTRA added for this date
    expect(await db.servicesOn('20261103')).toEqual(['WKDY']);
    expect(await db.servicesOn('20261101')).toEqual(['WKND']); // Sunday
    expect(await db.servicesOn('20261111')).toEqual([]); // WKDY removed (holiday)
    expect(await db.servicesOn('20270105')).toEqual([]); // past the calendar's end
  });
});

describe('departures', () => {
  const at = async (stopIds: string[], date: string, from: string, to: string) => {
    const s = (t: string) => Number(t.slice(0, 2)) * 3600 + Number(t.slice(3, 5)) * 60;
    return db.departures({
      stopIds,
      services: await db.servicesOn(date),
      fromSecs: s(from),
      toSecs: s(to),
      limit: 50,
    });
  };

  it('excludes drop-off-only stops and trip termini', async () => {
    const rows = await at(['S1'], MON, '07:00', '10:00');
    // T9 at 08:07 is drop-off only; T7 ends at S1 (07:15); T8's loop ends at S1 (09:20).
    expect(rows.map((r) => [r.tripId, r.dep])).toEqual([
      ['T1', 8 * 3600 + 5 * 60],
      ['T8', 9 * 3600],
    ]);
  });

  it('reads padded " 7:05:00" times', async () => {
    expect((await at(['S4'], MON, '07:00', '07:10')).map((r) => r.tripId)).toEqual(['T7']);
  });

  it('a trip past midnight belongs to the previous service day', async () => {
    // Tuesday 00:30–01:00 at Central Station: Monday's T6 at 24:40.
    const from = parseUserTime('2026-11-03T00:30', TZ, 0);
    const windows = serviceWindows(db.meta, from, from + 30 * 60_000);
    expect(windows.map((w) => w.date)).toEqual(['20261102', '20261103']);
    const found = [];
    for (const w of windows) {
      for (const r of await db.departures({
        stopIds: ['S3', 'S3A', 'S3B'],
        services: await db.servicesOn(w.date),
        fromSecs: w.fromSecs,
        toSecs: w.toSecs,
        limit: 10,
      })) {
        found.push([r.tripId, formatLocal(w.startMs + r.dep * 1000, TZ)]);
      }
    }
    expect(found).toEqual([['T6', '2026-11-03T00:40:00-05:00']]);
  });

  it('finds direct trips only in the right direction, and handles a loop', async () => {
    const svc = await db.servicesOn(MON);
    const rows = await db.directTrips({
      fromIds: ['S1'],
      toIds: ['S4'],
      services: svc,
      fromSecs: 0,
      toSecs: 86_400,
      limit: 10,
    });
    expect(rows.map((r) => r.tripId)).toEqual(['T1', 'T8']); // not T9 (no pickup), not T7 (wrong way)
    const back = await db.directTrips({
      fromIds: ['S4'],
      toIds: ['S1'],
      services: svc,
      fromSecs: 0,
      toSecs: 86_400,
      limit: 10,
    });
    expect(back.map((r) => [r.tripId, r.fromSeq, r.toSeq])).toEqual([
      ['T7', 1, 2],
      ['T8', 2, 3],
    ]);
  });

  it('summarises a route: patterns and the day’s span', async () => {
    const p = await db.routePatterns('R3');
    expect(p).toEqual([
      {
        directionId: 0,
        headsigns: [{ headsign: 'Albert', trips: 1 }],
        stopIds: ['S4', 'S3A', 'S5'],
      },
    ]);
    expect(await db.routeDay('R3', await db.servicesOn(MON))).toEqual([
      { directionId: 0, trips: 1, first: 23 * 3600 + 50 * 60, last: 23 * 3600 + 50 * 60 },
    ]);
  });
});

describe('stop resolution', () => {
  it('normalises names', () => {
    expect(tokens('University Avenue & Erb Street')).toEqual(['university', 'ave', 'erb', 'st']);
    expect(tokens('KING at JAMES')).toEqual(['king', 'james']);
  });

  it('treats both spellings of one corner as one place', () => {
    const r = resolveStop(db, 'King and Main');
    expect(r.stopIds.sort()).toEqual(['S1', 'S2']);
    expect(r.label).toContain('all 2 stops here');
  });

  it('a station includes its platforms but not its entrances', () => {
    expect(resolveStop(db, 'Central Station').stopIds).toEqual(['S3', 'S3A', 'S3B']);
    expect(resolveStop(db, 'Central Stn').stop.stopId).toBe('S3');
  });

  it('accepts sign codes, ids and partial last words', () => {
    expect(resolveStop(db, '1004')).toMatchObject({ how: 'code', stop: { stopId: 'S4' } });
    expect(resolveStop(db, 'id:S5')).toMatchObject({ how: 'id', stop: { stopId: 'S5' } });
    expect(resolveStop(db, 'University Ave at E').stop.stopId).toBe('S4');
  });

  it('never guesses between different places', () => {
    // Same code on two stops 5 km apart.
    expect(() => resolveStop(db, '2000')).toThrow(InvalidInputError);
    try {
      resolveStop(db, 'Elm Street');
    } catch (e) {
      expect((e as InvalidInputError).hint).toContain('[id:S6]');
      expect((e as InvalidInputError).hint).toContain('[id:S7]');
    }
    expect(() => resolveStop(db, 'Elm Street')).toThrow(/matches 2 different stops/);
    expect(() => resolveStop(db, 'Nowhere Rd')).toThrow(NotFoundError);
    expect(() => resolveStop(db, 'id:E3')).toThrow(NotFoundError); // an entrance isn't a stop
  });

  it('resolves routes by number or name', () => {
    expect(resolveRoute(db, '200').routeId).toBe('R2');
    expect(resolveRoute(db, 'ion light rail').routeId).toBe('R3');
    expect(() => resolveRoute(db, '999')).toThrow(NotFoundError);
  });
});
