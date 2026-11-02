import { describe, expect, it } from 'vitest';
import { getAgency, resolveAgencyId } from './agencies.js';
import type { FeedDb, Route, Stop } from './feed-db.js';
import { resolveStop } from './stops.js';

/** A FeedDb stand-in with just the in-memory parts resolveStop reads. */
function fakeDb(stops: Partial<Stop>[], routes: Route[]): FeedDb {
  const db = {
    stops: new Map<string, Stop>(),
    children: new Map<string, string[]>(),
    routes: new Map(routes.map((r) => [r.routeId, r])),
  };
  for (const p of stops) {
    const s: Stop = {
      code: null,
      lat: 43.6,
      lon: -79.4,
      locationType: 0,
      parent: null,
      wheelchair: null,
      platform: null,
      routeIds: [],
      name: '',
      stopId: '',
      ...p,
    };
    db.stops.set(s.stopId, s);
    if (s.parent) db.children.set(s.parent, [...(db.children.get(s.parent) ?? []), s.stopId]);
  }
  return db as unknown as FeedDb;
}
const route = (routeId: string, type: number): Route => ({
  routeId,
  shortName: routeId,
  longName: null,
  type,
  color: null,
});

describe('stations win when riders name them (found by evals)', () => {
  it('TTC: "Finch Station" is the station "Finch", not 35 bus stops on Finch Ave', () => {
    const db = fakeDb(
      [
        { stopId: 'ST', name: 'Finch', locationType: 1, routeIds: ['1'] },
        {
          stopId: 'P1',
          name: 'Finch Station - Southbound Platform',
          parent: 'ST',
          routeIds: ['1'],
        },
        {
          stopId: 'B1',
          name: 'Finch Ave East at Leslie St - Old Cummer GO Station',
          routeIds: ['39'],
          lat: 43.79,
        },
        { stopId: 'B2', name: 'Finch Station', routeIds: ['39'], lat: 43.7, lon: -79.3 },
      ],
      [route('1', 1), route('39', 3)],
    );
    const r = resolveStop(db, 'Finch Station');
    expect(r.stop.stopId).toBe('ST');
    expect(r.stopIds).toEqual(['ST', 'P1']);
  });

  it('GO: "Union Station" is the train station, not the bus terminal', () => {
    const db = fakeDb(
      [
        { stopId: 'UN', name: 'Union Station GO', routeIds: ['LW'] },
        { stopId: '02300', name: 'Union Station Bus Terminal', routeIds: ['16'] },
      ],
      [route('LW', 2), route('16', 3)],
    );
    expect(resolveStop(db, 'Union Station').stop.stopId).toBe('UN');
    expect(resolveStop(db, 'Union').stop.stopId).toBe('UN');
    expect(resolveStop(db, 'Union Station Bus Terminal').stop.stopId).toBe('02300');
  });

  it('on a tie, takes the one rail stop and says what else matched', () => {
    const db = fakeDb(
      [
        { stopId: 'BE', name: 'Bramalea GO', routeIds: ['KI'] },
        { stopId: 'BB', name: 'Bramalea GO', routeIds: ['30'], lat: 43.75, lon: -79.7 },
      ],
      [route('KI', 2), route('30', 3)],
    );
    const r = resolveStop(db, 'Bramalea GO');
    expect(r.stop.stopId).toBe('BE');
    expect(r.label).toMatch(/also matched 1 other stop\(s\), e\.g\. "Bramalea GO \[id:BB\]/);
  });

  it('still refuses to guess between two bus stops', () => {
    const db = fakeDb(
      [
        { stopId: 'A', name: 'Elm St', routeIds: ['1'] },
        { stopId: 'B', name: 'Elm St', routeIds: ['2'], lat: 43.0 },
      ],
      [route('1', 3), route('2', 3)],
    );
    expect(() => resolveStop(db, 'Elm St')).toThrow(/matches 2 different stops/);
  });
});

describe('agency names (found by evals)', () => {
  it('accepts the names people use', () => {
    expect(resolveAgencyId('GO Transit')).toBe('go');
    expect(resolveAgencyId('Grand River Transit')).toBe('grt');
    expect(resolveAgencyId('Hamilton Street Railway')).toBe('hsr');
    expect(resolveAgencyId('TTC')).toBe('ttc');
    expect(resolveAgencyId('Metrolinx')).toBe('go');
    expect(resolveAgencyId('Toronto')).toBeUndefined(); // TTC and GO both serve Toronto
    expect(getAgency('GO Transit', ['go']).id).toBe('go');
    expect(() => getAgency('Brampton Transit', ['go'])).toThrow(/Unknown agency/);
  });
});
