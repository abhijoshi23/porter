import { readFile } from 'node:fs/promises';
import {
  externalText,
  InvalidInputError,
  MemoryCache,
  NotFoundError,
  PorterError,
  type DownloadCache,
  type HttpClient,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const DAY = 24 * 60 * 60_000;

export const STATCAN_LICENCE = {
  name: 'Statistics Canada Open Licence',
  url: 'https://www.statcan.gc.ca/en/terms-conditions/open-licence',
};

// --- formatting helpers -------------------------------------------------------------

/** 14100459 → "14-10-0459-01", the table number people (and citations) use. */
export function tableNumber(productId: number): string {
  const s = String(productId).padStart(8, '0');
  return `${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 8)}-01`;
}

/** Accepts 14100459, "14100459", "14-10-0459-01" or "1410045901". */
export function parseProductId(input: string | number): number {
  const digits = String(input).replace(/[^0-9]/g, '');
  const pid = digits.length === 10 ? digits.slice(0, 8) : digits;
  if (!/^\d{8}$/.test(pid)) {
    throw new InvalidInputError(`"${input}" is not a valid StatCan table ID.`, {
      hint: 'Use an 8-digit productId like 14100459 or a table number like 14-10-0459-01 (from statcan_find_table).',
    });
  }
  return Number(pid);
}

export function citation(productId: number, title: string) {
  const id10 = `${String(productId).padStart(8, '0')}01`;
  return {
    text: `Statistics Canada. Table ${tableNumber(productId)} ${title}. DOI: https://doi.org/10.25318/${id10}-eng`,
    tableUrl: `https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${id10}`,
    licence: STATCAN_LICENCE,
  };
}

// --- WDS schemas (only fields we read) ----------------------------------------------

const cubeLite = z
  .object({
    productId: z.number(),
    cubeTitleEn: z.string(),
    cubeStartDate: z.string().nullish(),
    cubeEndDate: z.string().nullish(),
    frequencyCode: z.number().nullish(),
    archived: z.string().nullish(),
    releaseTime: z.string().nullish(),
  })
  .loose();
type CubeLite = z.infer<typeof cubeLite>;

const member = z
  .object({
    memberId: z.number(),
    parentMemberId: z.number().nullish(),
    memberNameEn: z.string(),
    terminated: z.number().nullish(),
    memberUomCode: z.number().nullish(),
  })
  .loose();
const dimension = z
  .object({
    dimensionPositionId: z.number(),
    dimensionNameEn: z.string(),
    hasUom: z.boolean().nullish(),
    member: z.array(member),
  })
  .loose();
const cubeMeta = z
  .object({
    productId: z.union([z.string(), z.number()]).transform(Number),
    cubeTitleEn: z.string(),
    cubeStartDate: z.string().nullish(),
    cubeEndDate: z.string().nullish(),
    frequencyCode: z.number().nullish(),
    releaseTime: z.string().nullish(),
    archiveStatusCode: z.string().nullish(),
    dimension: z.array(dimension),
    footnote: z.array(z.object({ footnotesEn: z.string().nullish() }).loose()).default([]),
  })
  .loose();
export type CubeMeta = z.infer<typeof cubeMeta>;
type Dimension = z.infer<typeof dimension>;
type Member = z.infer<typeof member>;

const codeSets = z.object({
  object: z
    .object({
      scalar: z.array(
        z
          .object({ scalarFactorCode: z.number(), scalarFactorDescEn: z.string().nullish() })
          .loose(),
      ),
      frequency: z.array(
        z.object({ frequencyCode: z.number(), frequencyDescEn: z.string().nullish() }).loose(),
      ),
      symbol: z.array(
        z
          .object({
            symbolCode: z.coerce.number(),
            symbolRepresentationEn: z.string().nullish(),
            symbolDescEn: z.string().nullish(),
          })
          .loose(),
      ),
      status: z.array(
        z
          .object({
            statusCode: z.coerce.number(),
            statusRepresentationEn: z.string().nullish(),
            statusDescEn: z.string().nullish(),
          })
          .loose(),
      ),
      uom: z.array(
        z.object({ memberUomCode: z.number(), memberUomEn: z.string().nullish() }).loose(),
      ),
    })
    .loose(),
});
type CodeSets = z.infer<typeof codeSets>['object'];

const seriesInfo = z.array(
  z.object({
    status: z.string(),
    object: z
      .object({
        responseStatusCode: z.number(),
        vectorId: z.number().nullish(),
        SeriesTitleEn: z.string().nullish(),
        scalarFactorCode: z.number().nullish(),
        memberUomCode: z.number().nullish(),
        frequencyCode: z.number().nullish(),
        terminated: z.number().nullish(),
      })
      .loose(),
  }),
);

const dataPoint = z
  .object({
    refPer: z.string(),
    value: z.number().nullish(),
    scalarFactorCode: z.number().nullish(),
    symbolCode: z.number().nullish(),
    statusCode: z.number().nullish(),
    releaseTime: z.string().nullish(),
  })
  .loose();
const vectorData = z.array(
  z.object({
    status: z.string(),
    object: z
      .object({ vectorDataPoint: z.array(dataPoint).default([]) })
      .loose()
      .nullish(),
  }),
);

// --- name matching ------------------------------------------------------------------

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[–—-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type MemberMatch =
  | {
      kind: 'exact' | 'unique';
      member: Member;
      /** Other members that also contain the words. */ similar: Member[];
    }
  | { kind: 'ambiguous'; candidates: Member[] }
  | { kind: 'none' };

/**
 * Resolves a human name ("Waterloo", "unemployment rate") to one dimension member.
 * Order: exact normalized match, then exact match ignoring a trailing province
 * ("Hamilton" = "Hamilton, Ontario"), then the members whose names contain every query
 * word. Several matches mean ambiguous, and we report the candidates instead of guessing.
 * That is the Waterloo (city) vs Waterloo (region) vs Kitchener-Cambridge-Waterloo (CMA) trap.
 */
export function matchMember(members: readonly Member[], query: string): MemberMatch {
  // Escape hatch when several members share a name (three CSDs all called "Waterloo"):
  // error messages list "id:<n>", which the model can pass back verbatim.
  const byId = /^\s*id:(\d+)\s*$/i.exec(query);
  if (byId) {
    const hit = members.find((m) => m.memberId === Number(byId[1]));
    return hit ? { kind: 'exact', member: hit, similar: [] } : { kind: 'none' };
  }
  const q = normalize(query);
  if (!q) return { kind: 'none' };
  const live = members.filter((m) => !m.terminated);
  const pool = live.length ? live : members;

  const words = q.split(' ');
  const contains = pool.filter((m) => {
    const name = ` ${normalize(m.memberNameEn)} `;
    return words.every((w) => name.includes(` ${w} `));
  });
  const others = (picked: Member) => contains.filter((m) => m !== picked);

  const exact = pool.filter((m) => normalize(m.memberNameEn) === q);
  if (exact.length === 1) return { kind: 'exact', member: exact[0]!, similar: others(exact[0]!) };

  const base = (name: string) => normalize(name.split(',')[0]!);
  const exactBase = pool.filter((m) => base(m.memberNameEn) === q);
  if (exactBase.length === 1)
    return { kind: 'exact', member: exactBase[0]!, similar: others(exactBase[0]!) };
  // Several places share the name (city and region). Offer every member containing it,
  // so the metro area (CMA) shows up as an option too.
  if (exactBase.length > 1)
    return { kind: 'ambiguous', candidates: contains.length ? contains : exactBase };

  if (contains.length === 1) return { kind: 'unique', member: contains[0]!, similar: [] };
  if (contains.length > 1) return { kind: 'ambiguous', candidates: contains };
  return { kind: 'none' };
}

/** Members picked automatically when a dimension isn't specified: the obvious "all" option. */
const DEFAULTABLE =
  /^(total|all |both sexes|total, all|estimate$|seasonally adjusted$|canada$|persons$)/i;

export function isGeographyDimension(d: Dimension): boolean {
  return /geograph/i.test(d.dimensionNameEn);
}

// --- client -------------------------------------------------------------------------

export interface TableHit {
  productId: number;
  tableNumber: string;
  title: string;
  frequency: string;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

export interface SeriesPoint {
  period: string;
  value: number | null;
  /** StatCan status flag, e.g. { code: "F", meaning: "too unreliable to be published" }. */
  status?: { code: string; meaning: string };
  /** e.g. "p" (preliminary) or "r" (revised). */
  symbol?: { code: string; meaning: string };
}

export class StatCanClient {
  private readonly metaCache = new MemoryCache<CubeMeta>({ max: 100, ttlMs: 6 * 60 * 60_000 });
  private readonly codesCache = new MemoryCache<CodeSets>({ max: 1, ttlMs: DAY });
  private cubes: { at: number; list: CubeLite[] } | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly downloads: DownloadCache,
  ) {}

  /** The full table list (~8,000 tables, ~5 MB) is cached on disk for a day and searched locally. */
  private async cubeList(): Promise<CubeLite[]> {
    if (this.cubes && Date.now() - this.cubes.at < DAY) return this.cubes.list;
    const file = await this.downloads.get(`${WDS}/getAllCubesListLite`, {
      ttlMs: DAY,
      maxBytes: 50 * 1_048_576,
      ext: '.json',
    });
    const parsed = z.array(cubeLite).safeParse(JSON.parse(await readFile(file.path, 'utf8')));
    if (!parsed.success)
      throw new PorterError('Statistics Canada returned the table list in an unexpected format.');
    this.cubes = { at: Date.now(), list: parsed.data };
    return parsed.data;
  }

  async codes(): Promise<CodeSets> {
    return this.codesCache.getOrLoad(
      'codes',
      async () => (await this.http.getJson(`${WDS}/getCodeSets`, codeSets)).object,
    );
  }

  async frequencyName(code: number | null | undefined): Promise<string> {
    if (code === null || code === undefined) return 'unknown';
    return (
      (await this.codes()).frequency.find((f) => f.frequencyCode === code)?.frequencyDescEn ??
      'unknown'
    );
  }

  /**
   * Keyword search over table titles. Scoring: words matched in the title, a bonus for
   * phrase matches, active tables strongly preferred over archived ones, and recency as
   * the tiebreak. Simple, explainable, and good enough with the model refining queries.
   */
  async findTables(
    query: string,
    o: { includeArchived: boolean; limit: number },
  ): Promise<TableHit[]> {
    const q = normalize(query);
    const words = q.split(' ').filter((w) => w.length > 1);
    if (!words.length) throw new InvalidInputError('Search query is empty.');
    const list = await this.cubeList();
    const scored = list
      .filter((c) => o.includeArchived || c.archived !== '1')
      .map((c) => {
        const title = ` ${normalize(c.cubeTitleEn)} `;
        let score = 0;
        for (const w of words) if (title.includes(` ${w}`)) score += 1;
        if (score === 0) return null;
        if (title.includes(q)) score += 2;
        if (c.archived === '1') score -= 3;
        if (/\binactive\b/.test(title)) score -= 1;
        return { c, score };
      })
      .filter((x): x is { c: CubeLite; score: number } => x !== null)
      .sort(
        (a, b) => b.score - a.score || (b.c.cubeEndDate ?? '').localeCompare(a.c.cubeEndDate ?? ''),
      )
      .slice(0, o.limit);
    const codes = await this.codes();
    return scored.map(({ c }) => ({
      productId: c.productId,
      tableNumber: tableNumber(c.productId),
      title: c.cubeTitleEn,
      frequency:
        codes.frequency.find((f) => f.frequencyCode === c.frequencyCode)?.frequencyDescEn ??
        'unknown',
      startDate: c.cubeStartDate?.slice(0, 10) ?? null,
      endDate: c.cubeEndDate?.slice(0, 10) ?? null,
      active: c.archived !== '1',
    }));
  }

  async metadata(productId: number): Promise<CubeMeta> {
    return this.metaCache.getOrLoad(String(productId), async () => {
      const body = await this.http.request(`${WDS}/getCubeMetadata`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify([{ productId }]),
      });
      const parsed = z
        .array(z.object({ status: z.string(), object: z.unknown() }))
        .safeParse(await body.json());
      const first = parsed.success ? parsed.data[0] : undefined;
      const meta = first?.status === 'SUCCESS' ? cubeMeta.safeParse(first.object) : null;
      if (!meta?.success) {
        throw new NotFoundError(`StatCan table ${tableNumber(productId)} was not found.`, {
          hint: 'Use statcan_find_table to search for a current table.',
        });
      }
      return meta.data;
    });
  }

  /**
   * Resolves the user's names for each dimension to member IDs, then builds the WDS
   * coordinate: member IDs in dimension order, padded with zeros to 10 positions
   * ("29.5.1.1.0.0.0.0.0.0").
   */
  resolveCoordinate(
    meta: CubeMeta,
    geography: string | undefined,
    selections: Record<string, string>,
  ): { coordinate: string; resolved: { dimension: string; member: string; how: string }[] } {
    const remaining = new Map(
      Object.entries(selections).map(([k, v]) => [normalize(k), { key: k, value: v }]),
    );
    const resolved: { dimension: string; member: string; how: string }[] = [];
    const ids: number[] = [];

    for (const dim of [...meta.dimension].sort(
      (a, b) => a.dimensionPositionId - b.dimensionPositionId,
    )) {
      const key = normalize(dim.dimensionNameEn);
      const geo = isGeographyDimension(dim);
      let wanted = remaining.get(key)?.value;
      remaining.delete(key);
      if (wanted === undefined && geo) wanted = geography;

      let chosen: Member | undefined;
      let how: string;
      if (wanted !== undefined) {
        const m = matchMember(dim.member, wanted);
        if (m.kind === 'ambiguous') {
          throw new InvalidInputError(
            `"${wanted}" matches several ${dim.dimensionNameEn} options.`,
            {
              hint: `Pick one exactly (pass the name, or id:<n> for duplicates): ${listNames(m.candidates, 25, dim.member, geo)}. (E.g. a city, its region and its census metropolitan area are different geographies.)`,
            },
          );
        }
        if (m.kind === 'none') {
          throw new InvalidInputError(
            `"${wanted}" is not an option for "${dim.dimensionNameEn}" in this table.`,
            {
              hint: `Options: ${listNames(dim.member, 25, dim.member, geo)}.`,
            },
          );
        }
        chosen = m.member;
        how = m.kind === 'exact' ? 'matched' : `matched "${wanted}"`;
        if (m.similar.length) {
          // Surface near-misses so the model can tell the user, e.g. that the city was
          // used and not the metro area.
          how += `; also available: ${listNames(m.similar, 5, dim.member, geo)}`;
        }
      } else if (dim.member.length === 1) {
        chosen = dim.member[0];
        how = 'only option';
      } else {
        const first = dim.member[0];
        if (first && DEFAULTABLE.test(first.memberNameEn)) {
          chosen = first;
          how = 'default';
        } else {
          throw new InvalidInputError(`Choose a value for "${dim.dimensionNameEn}".`, {
            hint: `Pass members: { "${dim.dimensionNameEn}": "<one of: ${listNames(dim.member, 25, dim.member, geo)}>" }${geo ? ' or use the geography argument' : ''}.`,
          });
        }
      }
      ids.push(chosen!.memberId);
      resolved.push({
        dimension: dim.dimensionNameEn,
        member: memberLabel(chosen!, dim.member, geo),
        how,
      });
    }

    if (remaining.size) {
      const unknown = [...remaining.values()].map((r) => `"${r.key}"`).join(', ');
      throw new InvalidInputError(`Unknown dimension(s) ${unknown} for this table.`, {
        hint: `Dimensions are: ${meta.dimension.map((d) => d.dimensionNameEn).join(', ')}.`,
      });
    }
    while (ids.length < 10) ids.push(0);
    return { coordinate: ids.join('.'), resolved };
  }

  async series(
    meta: CubeMeta,
    coordinate: string,
    range: { start: string; end: string },
  ): Promise<{
    vectorId: number;
    title: string;
    unit: string;
    scalarFactor: string;
    points: SeriesPoint[];
  }> {
    const infoRes = await this.http.request(`${WDS}/getSeriesInfoFromCubePidCoord`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify([{ productId: meta.productId, coordinate }]),
    });
    const info = seriesInfo.safeParse(await infoRes.json());
    const obj = info.success ? info.data[0]?.object : undefined;
    if (!obj || obj.responseStatusCode !== 0 || !obj.vectorId) {
      throw new NotFoundError('This table has no series for that combination of members.', {
        hint: 'Some combinations are not published. Call statcan_get_table to check the options, or change one selection.',
      });
    }

    const url = new URL(`${WDS}/getDataFromVectorByReferencePeriodRange`);
    // WDS expects the vector IDs as a quoted, comma-separated list.
    url.searchParams.set('vectorIds', `"${obj.vectorId}"`);
    url.searchParams.set('startRefPeriod', range.start);
    url.searchParams.set('endReferencePeriod', range.end);
    const data = await this.http.getJson(url, vectorData);
    const raw = data[0]?.status === 'SUCCESS' ? (data[0].object?.vectorDataPoint ?? []) : [];

    const codes = await this.codes();
    const statusOf = (code: number | null | undefined) => {
      if (!code) return undefined;
      const s = codes.status.find((x) => x.statusCode === code);
      return s
        ? { code: s.statusRepresentationEn ?? String(code), meaning: s.statusDescEn ?? 'unknown' }
        : undefined;
    };
    const symbolOf = (code: number | null | undefined) => {
      if (!code) return undefined;
      const s = codes.symbol.find((x) => x.symbolCode === code);
      return s
        ? { code: s.symbolRepresentationEn ?? String(code), meaning: s.symbolDescEn ?? 'unknown' }
        : undefined;
    };

    const points: SeriesPoint[] = raw.map((p) => {
      const status = statusOf(p.statusCode);
      const symbol = symbolOf(p.symbolCode);
      // Suppressed or unreliable values ("x", "F", "..") must not be presented as real
      // numbers. WDS sometimes still sends a value alongside an "F" flag.
      const suppressed = status && /^(x|F|\.\.|\.\.\.)$/.test(status.code);
      return {
        period: p.refPer,
        value: suppressed ? null : (p.value ?? null),
        ...(status ? { status } : {}),
        ...(symbol ? { symbol } : {}),
      };
    });

    return {
      vectorId: obj.vectorId,
      title: obj.SeriesTitleEn ?? '',
      unit: codes.uom.find((u) => u.memberUomCode === obj.memberUomCode)?.memberUomEn ?? 'unknown',
      scalarFactor:
        codes.scalar.find((s) => s.scalarFactorCode === (obj.scalarFactorCode ?? 0))
          ?.scalarFactorDescEn ?? 'units',
      points,
    };
  }

  footnotes(meta: CubeMeta, max = 3): string[] {
    return meta.footnote
      .slice(0, max)
      .map((f) => externalText(f.footnotesEn, 300))
      .filter(Boolean);
  }
}

/**
 * A member's display name with enough context to tell look-alikes apart, built from
 * the table's own hierarchy:
 *   city   → "Waterloo (in Waterloo, Ontario) [id:2868]"
 *   region → "Waterloo (in Ontario; contains 7 sub-areas) [id:2864]"
 * Ancestors already spelled out in the name ("Hamilton, Ontario") are not repeated, and
 * "Canada" is omitted. Members whose names collide also get their id, so the model can
 * select one exactly with id:<n>.
 */
export function memberLabel(m: Member, all: readonly Member[], geography = true): string {
  const dupe = all.filter((x) => x.memberNameEn === m.memberNameEn).length > 1;
  // Hierarchy context only helps for places; for other dimensions it's noise.
  if (!geography) return dupe ? `${m.memberNameEn} [id:${m.memberId}]` : m.memberNameEn;
  const byId = new Map(all.map((x) => [x.memberId, x]));
  const ownParts = new Set(m.memberNameEn.split(',').slice(1).map(normalize));
  const path: string[] = [];
  let cur = m.parentMemberId ? byId.get(m.parentMemberId) : undefined;
  while (cur && path.length < 3) {
    const n = normalize(cur.memberNameEn);
    if (n !== 'canada' && !ownParts.has(n)) path.push(cur.memberNameEn);
    cur = cur.parentMemberId ? byId.get(cur.parentMemberId) : undefined;
  }
  const children = all.filter((x) => x.parentMemberId === m.memberId).length;
  const context = [
    path.length ? `in ${path.join(', ')}` : '',
    children ? `contains ${children} sub-area${children === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  let label = context ? `${m.memberNameEn} (${context})` : m.memberNameEn;
  if (dupe) label += ` [id:${m.memberId}]`;
  return label;
}

function listNames(
  members: readonly Member[],
  max = 25,
  all: readonly Member[] = members,
  geography = false,
): string {
  const names = members.slice(0, max).map((m) => `"${memberLabel(m, all, geography)}"`);
  return members.length > max
    ? `${names.join(', ')}, … (${members.length - max} more)`
    : names.join(', ');
}
