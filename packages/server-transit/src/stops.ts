import { InvalidInputError, NotFoundError } from '@abhijoshi23/porter-toolkit';
import type { FeedDb, Route, Stop } from './feed-db.js';

/**
 * Turning what a person types ("King and Victoria", "Union", "stop 2939") into stop IDs.
 *
 * Stop names differ by agency: "Frederick / King" (GRT), "ABERDEEN at CHEDOKE" (HSR),
 * "Alness St at Dolomite Dr" (TTC), "Union Station GO" (GO). So names are reduced to
 * tokens: case, accents, punctuation and intersection words (at, and, /, &, @) are dropped,
 * and street-type words are abbreviated (street → st).
 *
 * Like StatCan geography (server-opendata), this never guesses between different places.
 * A name that matches several unrelated stops returns the options. One thing is deliberately
 * merged: stops with the *same* name close together (the 12 bays of "Ainslie Terminal",
 * both sides of "DUNDAS at MAIN"). A rider asking for departures there means all of them.
 */

const ABBREV: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  av: 'ave',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  crescent: 'cres',
  court: 'crt',
  place: 'pl',
  terrace: 'terr',
  parkway: 'pkwy',
  highway: 'hwy',
  station: 'stn',
  sta: 'stn',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  saint: 'st',
  mount: 'mt',
};
const DROP = new Set(['at', 'and', 'the', 'of', 'stop', 'platform']);

export function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !DROP.has(t))
    .map((t) => ABBREV[t] ?? t);
}

const isBoardable = (s: Stop) => s.locationType === 0 || s.locationType === 1;

/** Great-circle distance in metres. */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const MODES: Record<number, string> = {
  0: 'streetcar/light rail',
  1: 'subway',
  2: 'rail',
  3: 'bus',
  4: 'ferry',
  5: 'cable tram',
  6: 'aerial lift',
  7: 'funicular',
  11: 'trolleybus',
  12: 'monorail',
};

export function modeName(type: number | null): string {
  return MODES[type ?? -1] ?? 'other';
}

export function routeLabel(r: Route | undefined, fallbackId: string): string {
  if (!r) return fallbackId;
  if (r.shortName && r.longName) return `${r.shortName} ${r.longName}`;
  return r.shortName ?? r.longName ?? fallbackId;
}

/** Route names as riders say them, in natural order (5, 7, 16, 91, not 16, 5, 7, 91). */
export function routeNames(db: FeedDb, ids: string[]): string[] {
  return ids
    .map((id) => db.routes.get(id)?.shortName ?? db.routes.get(id)?.longName ?? id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** "King / Victoria [id:1234] (code 2939; routes 7, 8)": unique, and enough to choose by. */
export function stopLabel(db: FeedDb, s: Stop): string {
  const extra: string[] = [];
  if (s.locationType === 1) extra.push('station');
  if (s.code && s.code !== s.stopId) extra.push(`code ${s.code}`);
  const routes = routeNames(db, s.routeIds);
  if (routes.length) {
    extra.push(`routes ${routes.slice(0, 8).join(', ')}${routes.length > 8 ? '…' : ''}`);
  }
  return `${s.name} [id:${s.stopId}]${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

export interface ResolvedStop {
  /** What the model should repeat to the user. */
  label: string;
  /** Every stop_id departures are read from (a station's platforms, a terminal's bays). */
  stopIds: string[];
  /** The primary stop, for coordinates and names. */
  stop: Stop;
  how: 'id' | 'code' | 'name';
}

/** All stop_ids that riders board at for this stop: itself plus a station's platforms. */
function boardingIds(db: FeedDb, s: Stop): string[] {
  const kids = db.children.get(s.stopId) ?? [];
  return [s.stopId, ...kids.filter((k) => db.stops.get(k)?.locationType === 0)];
}

export function resolveStop(db: FeedDb, input: string): ResolvedStop {
  const raw = input.trim();
  const byId = (id: string): ResolvedStop | null => {
    const s = db.stops.get(id);
    return s && isBoardable(s)
      ? { label: stopLabel(db, s), stopIds: boardingIds(db, s), stop: s, how: 'id' }
      : null;
  };

  // Explicit "id:<stop_id>", the form every label we return uses.
  const idMatch = /^id:(.+)$/i.exec(raw);
  if (idMatch) {
    const r = byId(idMatch[1]!.trim());
    if (r) return r;
    throw new NotFoundError(`No stop with id ${idMatch[1]}.`, {
      hint: 'Call find_stops to look the stop up by name or location.',
    });
  }

  // A bare number is read as the code on the stop sign first, because that is what a rider
  // knows. In HSR the code and id ranges overlap (stop_id 1001 has code 2939), so the
  // order matters. Codes aren't always unique either: HSR reuses 643 of them.
  const code = /^(?:code[:\s]*|#)?(\w+)$/i.exec(raw)?.[1];
  if (code) {
    const byCode = [...db.stops.values()].filter((s) => isBoardable(s) && s.code === code);
    if (byCode.length === 1) {
      const s = byCode[0]!;
      return { label: stopLabel(db, s), stopIds: boardingIds(db, s), stop: s, how: 'code' };
    }
    if (byCode.length > 1) throw ambiguous(db, raw, byCode);
  }
  const asId = byId(raw);
  if (asId) return asId;

  const want = tokens(raw);
  if (want.length === 0) {
    throw new InvalidInputError('Give a stop name, stop code or id.', {
      hint: 'Example: "King / Victoria", "2939", or "id:1234". find_stops can search by location.',
    });
  }
  const scored = [...db.stops.values()]
    .filter(isBoardable)
    .map((s) => ({ s, score: score(want, tokens(s.name)) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) {
    throw new NotFoundError(`No stop matches "${raw}".`, {
      hint: 'Try fewer words (one street name), a stop code from the sign, or find_stops with near={lat, lon}.',
    });
  }
  const best = Math.max(...scored.map((x) => x.score));
  let cands = scored.filter((x) => x.score === best).map((x) => x.s);

  // A station absorbs its own platforms.
  const stations = new Set(cands.filter((s) => s.locationType === 1).map((s) => s.stopId));
  cands = cands.filter((s) => !(s.parent && stations.has(s.parent)));
  // Platforms of one station (but no station row matched): use the station.
  const parents = new Set(cands.map((s) => s.parent));
  if (cands.length > 1 && parents.size === 1 && cands[0]!.parent) {
    const st = db.stops.get(cands[0]!.parent);
    if (st) cands = [st];
  }

  if (cands.length === 1) {
    const s = cands[0]!;
    return { label: stopLabel(db, s), stopIds: boardingIds(db, s), stop: s, how: 'name' };
  }

  const group = sameNameCluster(cands);
  if (group) {
    const s = group[0]!;
    const ids = [...new Set(group.flatMap((g) => boardingIds(db, g)))];
    return {
      label: `${s.name} (all ${group.length} stops here: ${group.map((g) => `id:${g.stopId}`).join(', ')})`,
      stopIds: ids,
      stop: s,
      how: 'name',
    };
  }
  throw ambiguous(db, raw, cands);
}

/** Exact token-set match scores highest, then all words present, then word prefixes. */
function score(want: string[], have: string[]): number {
  const set = new Set(have);
  if (want.length === have.length && want.every((t) => set.has(t))) return 3;
  if (want.every((t) => set.has(t))) return 2;
  // Allow the last word to be a prefix ("King / Vic").
  const head = want.slice(0, -1);
  const last = want[want.length - 1]!;
  if (head.every((t) => set.has(t)) && have.some((h) => h.startsWith(last))) return 1;
  return 0;
}

/**
 * Same name and all within 400 m of the first: one place in a rider's mind. "Same name"
 * ignores word order, because HSR names the four corners of one intersection
 * "KING at JAMES" and "JAMES at KING".
 */
function sameNameCluster(cands: Stop[]): Stop[] | null {
  const key = (s: Stop) => [...new Set(tokens(s.name))].sort().join(' ');
  const name = key(cands[0]!);
  if (!cands.every((c) => key(c) === name)) return null;
  const a = cands[0]!;
  if (a.lat == null || a.lon == null) return null;
  const near = cands.every(
    (c) => c.lat != null && c.lon != null && distanceM(a.lat!, a.lon!, c.lat, c.lon) <= 400,
  );
  return near ? cands : null;
}

function ambiguous(db: FeedDb, raw: string, cands: Stop[]): InvalidInputError {
  const shown = cands.slice(0, 12).map((s) => `"${stopLabel(db, s)}"`);
  return new InvalidInputError(`"${raw}" matches ${cands.length} different stops.`, {
    hint: `Choose one and pass it as id:<n>, or ask the user which they mean: ${shown.join(', ')}${cands.length > 12 ? ', …' : ''}.`,
  });
}

export function resolveRoute(db: FeedDb, input: string): Route {
  const raw = input.trim();
  const byId = db.routes.get(raw);
  if (byId) return byId;
  const lower = raw.toLowerCase();
  const exact = [...db.routes.values()].filter(
    (r) => r.shortName?.toLowerCase() === lower || r.longName?.toLowerCase() === lower,
  );
  // HSR pads short names: route "1" is "01".
  const numeric = /^\d+$/.test(raw)
    ? [...db.routes.values()].filter(
        (r) => r.shortName && /^\d+$/.test(r.shortName) && Number(r.shortName) === Number(raw),
      )
    : [];
  const want = tokens(raw);
  const partial = [...db.routes.values()].filter((r) => {
    const have = new Set(tokens(`${r.shortName ?? ''} ${r.longName ?? ''}`));
    return want.length > 0 && want.every((t) => have.has(t));
  });
  const cands = exact.length ? exact : numeric.length ? numeric : partial;
  if (cands.length === 1) return cands[0]!;
  if (cands.length === 0) {
    throw new NotFoundError(`No route matches "${raw}".`, {
      hint: 'Use the route number as shown on the bus or train (e.g. "7", "504", "LW"). list_agencies explains the agencies.',
    });
  }
  throw new InvalidInputError(`"${raw}" matches ${cands.length} routes.`, {
    hint: `Choose by route_id: ${cands
      .slice(0, 12)
      .map((r) => `"${routeLabel(r, r.routeId)}" (${modeName(r.type)}; route_id ${r.routeId})`)
      .join(', ')}.`,
  });
}
