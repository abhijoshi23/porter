import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DuckDBInstance,
  listValue,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import { PorterError } from '@abhijoshi23/porter-toolkit';
import { weekdayOf } from './time.js';

/**
 * GTFS → DuckDB. A feed is a zip of CSV files; we load the columns we use into typed,
 * cleaned tables once per feed version and query that file afterwards.
 *
 * Why DuckDB rather than querying the CSVs each time: TTC's stop_times.txt is 285 MB
 * (3.3 M rows). Parsing it per request would take seconds. Loaded once into a columnar
 * file sorted by stop, a "next departures" query takes milliseconds. DuckDB is already a
 * Porter dependency (opendata's SQL sandbox), so this costs nothing extra, and it works on
 * every Node version we support (node:sqlite would need ≥ 22.13).
 *
 * Real-feed quirks handled while loading:
 * - UTF-8 byte-order marks on headers (GO): stripped by DuckDB's CSV reader.
 * - Padded or unpadded times like " 4:30:00" (HSR) and hours ≥ 24 (all of them).
 * - Optional files: GRT and GO have no calendar.txt and use calendar_dates.txt alone.
 * - Optional columns in any order (TTC puts trip_id first in trips.txt).
 * - Empty strings mean "not given", so they become NULL.
 */

export const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'feed_info.txt',
] as const;

const REQUIRED = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];

type Kind = 'text' | 'int' | 'float' | 'time';
/** [output column, GTFS column, kind]. Output names are short; GTFS names are long. */
type Spec = [string, string, Kind][];

const TABLES: Record<string, { file: string; cols: Spec }> = {
  agency: {
    file: 'agency.txt',
    cols: [
      ['agency_id', 'agency_id', 'text'],
      ['name', 'agency_name', 'text'],
      ['timezone', 'agency_timezone', 'text'],
    ],
  },
  stops: {
    file: 'stops.txt',
    cols: [
      ['stop_id', 'stop_id', 'text'],
      ['code', 'stop_code', 'text'],
      ['name', 'stop_name', 'text'],
      ['lat', 'stop_lat', 'float'],
      ['lon', 'stop_lon', 'float'],
      ['location_type', 'location_type', 'int'],
      ['parent', 'parent_station', 'text'],
      ['wheelchair', 'wheelchair_boarding', 'int'],
      ['platform', 'platform_code', 'text'],
    ],
  },
  routes: {
    file: 'routes.txt',
    cols: [
      ['route_id', 'route_id', 'text'],
      ['short_name', 'route_short_name', 'text'],
      ['long_name', 'route_long_name', 'text'],
      ['type', 'route_type', 'int'],
      ['color', 'route_color', 'text'],
    ],
  },
  trips: {
    file: 'trips.txt',
    cols: [
      ['trip_id', 'trip_id', 'text'],
      ['route_id', 'route_id', 'text'],
      ['service_id', 'service_id', 'text'],
      ['headsign', 'trip_headsign', 'text'],
      ['short_name', 'trip_short_name', 'text'],
      ['direction_id', 'direction_id', 'int'],
    ],
  },
  stop_times_raw: {
    file: 'stop_times.txt',
    cols: [
      ['trip_id', 'trip_id', 'text'],
      ['arr', 'arrival_time', 'time'],
      ['dep', 'departure_time', 'time'],
      ['stop_id', 'stop_id', 'text'],
      ['seq', 'stop_sequence', 'int'],
      ['stop_headsign', 'stop_headsign', 'text'],
      ['pickup', 'pickup_type', 'int'],
      ['dropoff', 'drop_off_type', 'int'],
    ],
  },
  calendar: {
    file: 'calendar.txt',
    cols: [
      ['service_id', 'service_id', 'text'],
      ['d0', 'monday', 'int'],
      ['d1', 'tuesday', 'int'],
      ['d2', 'wednesday', 'int'],
      ['d3', 'thursday', 'int'],
      ['d4', 'friday', 'int'],
      ['d5', 'saturday', 'int'],
      ['d6', 'sunday', 'int'],
      ['start_date', 'start_date', 'text'],
      ['end_date', 'end_date', 'text'],
    ],
  },
  calendar_dates: {
    file: 'calendar_dates.txt',
    cols: [
      ['service_id', 'service_id', 'text'],
      ['date', 'date', 'text'],
      ['exception_type', 'exception_type', 'int'],
    ],
  },
  feed_info: {
    file: 'feed_info.txt',
    cols: [
      ['start_date', 'feed_start_date', 'text'],
      ['end_date', 'feed_end_date', 'text'],
      ['version', 'feed_version', 'text'],
    ],
  },
};

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function expr(src: string | null, kind: Kind): string {
  if (src === null) {
    return kind === 'text' ? 'NULL::VARCHAR' : kind === 'float' ? 'NULL::DOUBLE' : 'NULL::INTEGER';
  }
  const v = `nullif(trim(${quoteIdent(src)}), '')`;
  switch (kind) {
    case 'text':
      return v;
    case 'int':
      return `TRY_CAST(${v} AS INTEGER)`;
    case 'float':
      return `TRY_CAST(${v} AS DOUBLE)`;
    case 'time':
      // "H:MM:SS" or "HH:MM:SS", hours may exceed 23 → seconds after service-day start.
      return `(TRY_CAST(split_part(${v}, ':', 1) AS INTEGER) * 3600 + TRY_CAST(split_part(${v}, ':', 2) AS INTEGER) * 60 + TRY_CAST(split_part(${v}, ':', 3) AS INTEGER))`;
  }
}

/**
 * Loads the extracted GTFS files in `srcDir` into a new DuckDB file at `dbPath`.
 * Builds into a temp file and renames, so a crash never leaves a half-built database
 * that a later run would trust.
 */
export async function buildFeedDb(
  srcDir: string,
  dbPath: string,
  info: { sourceUrl: string; sha256: string },
): Promise<void> {
  for (const f of REQUIRED) {
    if (!existsSync(join(srcDir, f))) {
      throw new PorterError(`The GTFS feed is missing ${f}.`, {
        hint: 'The publisher may have posted an incomplete feed. Try again later.',
      });
    }
  }
  const tmp = `${dbPath}.${process.pid}.building`;
  await rm(tmp, { force: true });
  const instance = await DuckDBInstance.create(tmp, {
    threads: '2',
    memory_limit: '1GB',
    preserve_insertion_order: 'false',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const conn = await instance.connect();
  try {
    for (const [table, { file, cols }] of Object.entries(TABLES)) {
      const path = join(srcDir, file);
      if (!existsSync(path)) {
        // Optional file absent: an empty table with the right columns keeps queries simple.
        const defs = cols.map(([out, , kind]) => `${out} ${sqlType(kind)}`).join(', ');
        await conn.run(`CREATE TABLE ${table} (${defs})`);
        continue;
      }
      const reader = `read_csv(${quoteLit(path)}, header = true, all_varchar = true, quote = '"', escape = '"', strict_mode = false, null_padding = true)`;
      const header = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${reader}`))
        .getRowObjectsJson()
        .map((r) => String(r.column_name));
      // Match columns case-insensitively and ignoring stray spaces.
      const byName = new Map(header.map((h) => [h.trim().toLowerCase(), h]));
      const select = cols
        .map(([out, src, kind]) => `${expr(byName.get(src) ?? null, kind)} AS ${out}`)
        .join(', ');
      await conn.run(`CREATE TABLE ${table} AS SELECT ${select} FROM ${reader}`);
    }

    // Final stop_times: fill a missing arrival from departure and vice versa, mark each
    // trip's first and last stop (you can't board at the terminus), and sort by stop so
    // DuckDB's per-block min/max (zone maps) skip most of the table for one stop's query.
    await conn.run(`
      CREATE TABLE stop_times AS
      SELECT trip_id, stop_id, seq, coalesce(arr, dep) AS arr, coalesce(dep, arr) AS dep,
             stop_headsign, coalesce(pickup, 0) AS pickup, coalesce(dropoff, 0) AS dropoff,
             seq = min(seq) OVER w AS is_first, seq = max(seq) OVER w AS is_last
      FROM stop_times_raw
      WHERE trip_id IS NOT NULL AND stop_id IS NOT NULL AND seq IS NOT NULL
      WINDOW w AS (PARTITION BY trip_id)
      ORDER BY stop_id, dep`);
    await conn.run('DROP TABLE stop_times_raw');

    // Which routes serve each stop: used to label stops ("King / Victoria — routes 7, 8").
    await conn.run(`
      CREATE TABLE stop_routes AS
      SELECT st.stop_id, array_sort(list_distinct(list(t.route_id))) AS route_ids
      FROM stop_times st JOIN trips t USING (trip_id)
      GROUP BY st.stop_id`);

    const stats = (
      await conn.runAndReadAll(`
        SELECT (SELECT max(dep) FROM stop_times)::INTEGER AS max_secs,
               (SELECT count(*) FROM stop_times)::INTEGER AS stop_times,
               (SELECT count(*) FROM trips)::INTEGER AS trips,
               (SELECT min(d) FROM (SELECT start_date AS d FROM calendar UNION ALL SELECT date FROM calendar_dates WHERE exception_type = 1)) AS svc_start,
               (SELECT max(d) FROM (SELECT end_date AS d FROM calendar UNION ALL SELECT date FROM calendar_dates WHERE exception_type = 1)) AS svc_end`)
    ).getRowObjectsJson()[0]!;
    if (!stats.stop_times) {
      throw new PorterError('The GTFS feed has no usable stop times.', {
        hint: 'The publisher may have posted an incomplete feed. Try again later.',
      });
    }
    const meta = {
      source_url: info.sourceUrl,
      sha256: info.sha256,
      built_at: new Date().toISOString(),
      max_secs: String(stats.max_secs),
      service_start: String(stats.svc_start ?? ''),
      service_end: String(stats.svc_end ?? ''),
    };
    await conn.run('CREATE TABLE meta (key VARCHAR, value VARCHAR)');
    for (const [k, v] of Object.entries(meta)) {
      await conn.run('INSERT INTO meta VALUES ($k, $v)', { k, v });
    }
    await conn.run('CHECKPOINT');
  } catch (err) {
    conn.closeSync();
    instance.closeSync();
    await rm(tmp, { force: true });
    await rm(`${tmp}.wal`, { force: true });
    if (err instanceof PorterError) throw err;
    throw new PorterError('The GTFS feed could not be loaded.', {
      hint: 'The feed may be malformed or mid-update. Try again later.',
      cause: err,
    });
  }
  conn.closeSync();
  instance.closeSync();
  await rename(tmp, dbPath);
}

function sqlType(kind: Kind): string {
  return kind === 'text' ? 'VARCHAR' : kind === 'float' ? 'DOUBLE' : 'INTEGER';
}

// ---------------------------------------------------------------------------------------

export interface Stop {
  stopId: string;
  code: string | null;
  name: string;
  lat: number | null;
  lon: number | null;
  /** 0 stop/platform, 1 station, 2 entrance, 3 generic node, 4 boarding area */
  locationType: number;
  parent: string | null;
  wheelchair: number | null;
  platform: string | null;
  routeIds: string[];
}

export interface Route {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  /** GTFS route_type: 0 tram/streetcar, 1 subway, 2 rail, 3 bus, … */
  type: number | null;
  color: string | null;
}

export interface FeedMeta {
  agencyName: string;
  timezone: string;
  version: string | null;
  /** First and last dates the feed has any service, `YYYYMMDD`. */
  serviceStart: string;
  serviceEnd: string;
  /** Largest departure time in seconds; > 86 400 means trips run past midnight. */
  maxSecs: number;
  sha256: string;
  builtAt: string;
  sourceUrl: string;
}

export interface DepartureRow {
  tripId: string;
  stopId: string;
  seq: number;
  dep: number;
  headsign: string | null;
  routeId: string;
  directionId: number | null;
  tripShortName: string | null;
}

export interface TripOptionRow {
  tripId: string;
  routeId: string;
  headsign: string | null;
  fromStopId: string;
  fromSeq: number;
  dep: number;
  toStopId: string;
  toSeq: number;
  arr: number;
}

/**
 * A built feed, opened read-only. Stops and routes are small (TTC: 12k stops) and are
 * held in memory for name matching. Schedules stay in DuckDB.
 */
export class FeedDb {
  readonly stops = new Map<string, Stop>();
  readonly children = new Map<string, string[]>();
  readonly routes = new Map<string, Route>();
  private readonly servicesCache = new Map<string, string[]>();

  private constructor(
    private readonly instance: DuckDBInstance,
    readonly meta: FeedMeta,
  ) {}

  static async open(dbPath: string): Promise<FeedDb> {
    const instance = await DuckDBInstance.create(dbPath, {
      access_mode: 'READ_ONLY',
      threads: '2',
      memory_limit: '512MB',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    });
    const conn = await instance.connect();
    try {
      const kv = Object.fromEntries(
        (await conn.runAndReadAll('SELECT key, value FROM meta'))
          .getRowObjectsJson()
          .map((r) => [String(r.key), String(r.value)]),
      );
      const agency = (
        await conn.runAndReadAll('SELECT name, timezone FROM agency LIMIT 1')
      ).getRowObjectsJson()[0];
      const fi = (
        await conn.runAndReadAll('SELECT version FROM feed_info LIMIT 1')
      ).getRowObjectsJson()[0];
      const meta: FeedMeta = {
        agencyName: String(agency?.name ?? ''),
        timezone: String(agency?.timezone ?? 'America/Toronto'),
        version: fi?.version ? String(fi.version) : null,
        serviceStart: kv.service_start ?? '',
        serviceEnd: kv.service_end ?? '',
        maxSecs: Number(kv.max_secs ?? 0),
        sha256: kv.sha256 ?? '',
        builtAt: kv.built_at ?? '',
        sourceUrl: kv.source_url ?? '',
      };
      const db = new FeedDb(instance, meta);

      const routeIdsByStop = new Map<string, string[]>();
      for (const r of (
        await conn.runAndReadAll('SELECT stop_id, route_ids FROM stop_routes')
      ).getRowObjectsJson()) {
        routeIdsByStop.set(String(r.stop_id), (r.route_ids as string[]) ?? []);
      }
      for (const r of (await conn.runAndReadAll('SELECT * FROM stops')).getRowObjectsJson()) {
        const s: Stop = {
          stopId: String(r.stop_id),
          code: r.code == null ? null : String(r.code),
          name: String(r.name ?? r.stop_id),
          lat: r.lat == null ? null : Number(r.lat),
          lon: r.lon == null ? null : Number(r.lon),
          locationType: Number(r.location_type ?? 0),
          parent: r.parent == null ? null : String(r.parent),
          wheelchair: r.wheelchair == null ? null : Number(r.wheelchair),
          platform: r.platform == null ? null : String(r.platform),
          routeIds: routeIdsByStop.get(String(r.stop_id)) ?? [],
        };
        db.stops.set(s.stopId, s);
        if (s.parent) db.children.set(s.parent, [...(db.children.get(s.parent) ?? []), s.stopId]);
      }
      // A station's routes are the union of its platforms' routes.
      for (const [parent, kids] of db.children) {
        const st = db.stops.get(parent);
        if (st && st.routeIds.length === 0) {
          st.routeIds = [...new Set(kids.flatMap((k) => db.stops.get(k)?.routeIds ?? []))].sort();
        }
      }
      for (const r of (await conn.runAndReadAll('SELECT * FROM routes')).getRowObjectsJson()) {
        db.routes.set(String(r.route_id), {
          routeId: String(r.route_id),
          shortName: r.short_name == null ? null : String(r.short_name),
          longName: r.long_name == null ? null : String(r.long_name),
          type: r.type == null ? null : Number(r.type),
          color: r.color == null ? null : String(r.color),
        });
      }
      return db;
    } catch (err) {
      instance.closeSync();
      throw err;
    } finally {
      conn.closeSync();
    }
  }

  close(): void {
    this.instance.closeSync();
  }

  private async query(sql: string, params: Record<string, DuckDBValue>) {
    const conn: DuckDBConnection = await this.instance.connect();
    try {
      return (await conn.runAndReadAll(sql, params)).getRowObjectsJson();
    } finally {
      conn.closeSync();
    }
  }

  /**
   * Service IDs running on `date` (GTFS "service day"):
   * calendar.txt weekly pattern within its date range, plus calendar_dates.txt additions
   * (exception_type 1), minus its removals (exception_type 2, e.g. holidays).
   */
  async servicesOn(date: string): Promise<string[]> {
    const hit = this.servicesCache.get(date);
    if (hit) return hit;
    const day = `d${weekdayOf(date)}`; // d0 … d6, from our own table, never user input
    const rows = await this.query(
      `(SELECT service_id FROM calendar WHERE ${day} = 1 AND $date BETWEEN start_date AND end_date
        UNION
        SELECT service_id FROM calendar_dates WHERE date = $date AND exception_type = 1)
       EXCEPT
       SELECT service_id FROM calendar_dates WHERE date = $date AND exception_type = 2`,
      { date },
    );
    const ids = rows.map((r) => String(r.service_id)).sort();
    this.servicesCache.set(date, ids);
    return ids;
  }

  /** Departures from any of `stopIds` on one service day, between two offsets in seconds. */
  async departures(o: {
    stopIds: string[];
    services: string[];
    fromSecs: number;
    toSecs: number;
    routeIds?: string[];
    limit: number;
  }): Promise<DepartureRow[]> {
    if (o.services.length === 0) return [];
    const rows = await this.query(
      `SELECT st.trip_id, st.stop_id, st.seq, st.dep, coalesce(st.stop_headsign, t.headsign) AS headsign,
              t.route_id, t.direction_id, t.short_name
       FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id
       WHERE list_contains($stops, st.stop_id) AND st.dep BETWEEN $from AND $to
         AND list_contains($svc, t.service_id) AND st.pickup <> 1 AND NOT st.is_last
         ${o.routeIds ? 'AND list_contains($routes, t.route_id)' : ''}
       ORDER BY st.dep, t.route_id LIMIT $limit`,
      {
        stops: listValue(o.stopIds),
        svc: listValue(o.services),
        from: o.fromSecs,
        to: o.toSecs,
        limit: o.limit,
        ...(o.routeIds ? { routes: listValue(o.routeIds) } : {}),
      },
    );
    return rows.map((r) => ({
      tripId: String(r.trip_id),
      stopId: String(r.stop_id),
      seq: Number(r.seq),
      dep: Number(r.dep),
      headsign: r.headsign == null ? null : String(r.headsign),
      routeId: String(r.route_id),
      directionId: r.direction_id == null ? null : Number(r.direction_id),
      tripShortName: r.short_name == null ? null : String(r.short_name),
    }));
  }

  /** Direct trips (no transfer) that call at a `from` stop and later at a `to` stop. */
  async directTrips(o: {
    fromIds: string[];
    toIds: string[];
    services: string[];
    fromSecs: number;
    toSecs: number;
    limit: number;
  }): Promise<TripOptionRow[]> {
    if (o.services.length === 0) return [];
    const rows = await this.query(
      `SELECT a.trip_id, t.route_id, coalesce(a.stop_headsign, t.headsign) AS headsign,
              a.stop_id AS from_stop, a.seq AS from_seq, a.dep,
              b.stop_id AS to_stop, b.seq AS to_seq, b.arr
       FROM stop_times a
       JOIN trips t ON t.trip_id = a.trip_id
       JOIN stop_times b ON b.trip_id = a.trip_id AND b.seq > a.seq
       WHERE list_contains($from_ids, a.stop_id) AND list_contains($to_ids, b.stop_id)
         AND a.dep BETWEEN $from AND $to AND list_contains($svc, t.service_id)
         AND a.pickup <> 1 AND b.dropoff <> 1
       -- A loop route can pass a stop twice; keep the shortest ride per trip.
       QUALIFY row_number() OVER (PARTITION BY a.trip_id ORDER BY b.arr - a.dep, a.dep) = 1
       ORDER BY b.arr, a.dep LIMIT $limit`,
      {
        from_ids: listValue(o.fromIds),
        to_ids: listValue(o.toIds),
        svc: listValue(o.services),
        from: o.fromSecs,
        to: o.toSecs,
        limit: o.limit,
      },
    );
    return rows.map((r) => ({
      tripId: String(r.trip_id),
      routeId: String(r.route_id),
      headsign: r.headsign == null ? null : String(r.headsign),
      fromStopId: String(r.from_stop),
      fromSeq: Number(r.from_seq),
      dep: Number(r.dep),
      toStopId: String(r.to_stop),
      toSeq: Number(r.to_seq),
      arr: Number(r.arr),
    }));
  }

  /** Per direction: headsigns with trip counts, and the stop pattern of the longest trip of the busiest headsign. */
  async routePatterns(routeId: string): Promise<
    {
      directionId: number | null;
      headsigns: { headsign: string | null; trips: number }[];
      stopIds: string[];
    }[]
  > {
    const counts = await this.query(
      `SELECT t.direction_id, t.headsign, count(*)::INTEGER AS n
       FROM trips t WHERE t.route_id = $r GROUP BY t.direction_id, t.headsign ORDER BY n DESC`,
      { r: routeId },
    );
    const lengths = await this.query(
      `SELECT t.direction_id, t.headsign, st.trip_id, count(*)::INTEGER AS n
       FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id
       WHERE t.route_id = $r GROUP BY t.direction_id, t.headsign, st.trip_id
       QUALIFY row_number() OVER (PARTITION BY t.direction_id, t.headsign ORDER BY n DESC, st.trip_id) = 1`,
      { r: routeId },
    );
    const dirs = [
      ...new Set(counts.map((c) => (c.direction_id == null ? null : Number(c.direction_id)))),
    ];
    const out = [];
    for (const d of dirs) {
      const hs = counts
        .filter((c) => (c.direction_id == null ? null : Number(c.direction_id)) === d)
        .map((c) => ({
          headsign: c.headsign == null ? null : String(c.headsign),
          trips: Number(c.n),
        }));
      const top = hs[0]?.headsign ?? null;
      const rep = lengths.find(
        (l) =>
          (l.direction_id == null ? null : Number(l.direction_id)) === d &&
          (l.headsign == null ? null : String(l.headsign)) === top,
      );
      const stopIds = rep
        ? (
            await this.query('SELECT stop_id FROM stop_times WHERE trip_id = $t ORDER BY seq', {
              t: String(rep.trip_id),
            })
          ).map((r) => String(r.stop_id))
        : [];
      out.push({ directionId: d, headsigns: hs, stopIds });
    }
    return out;
  }

  /** Trips per direction on a service day, with first and last departure from the origin. */
  async routeDay(
    routeId: string,
    services: string[],
  ): Promise<{ directionId: number | null; trips: number; first: number; last: number }[]> {
    if (services.length === 0) return [];
    const rows = await this.query(
      `SELECT t.direction_id, count(*)::INTEGER AS n, min(st.dep) AS first, max(st.dep) AS last
       FROM trips t JOIN stop_times st ON st.trip_id = t.trip_id AND st.is_first
       WHERE t.route_id = $r AND list_contains($svc, t.service_id)
       GROUP BY 1 ORDER BY 1`,
      { r: routeId, svc: listValue(services) },
    );
    return rows.map((r) => ({
      directionId: r.direction_id == null ? null : Number(r.direction_id),
      trips: Number(r.n),
      first: Number(r.first),
      last: Number(r.last),
    }));
  }
}
