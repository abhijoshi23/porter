import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import {
  citation,
  matchMember,
  memberLabel,
  normalize,
  parseProductId,
  StatCanClient,
  tableNumber,
  type CubeMeta,
} from './statcan.js';
import { toRefDate } from './tools.js';

const m = (memberId: number, memberNameEn: string, terminated = 0, parentMemberId?: number) => ({
  memberId,
  memberNameEn,
  terminated,
  parentMemberId,
});

describe('identifiers and citations', () => {
  it('formats and parses table numbers', () => {
    expect(tableNumber(14100459)).toBe('14-10-0459-01');
    expect(parseProductId('14-10-0459-01')).toBe(14100459);
    expect(parseProductId(14100459)).toBe(14100459);
    expect(parseProductId('1410045901')).toBe(14100459);
    expect(() => parseProductId('abc')).toThrow(InvalidInputError);
  });

  it('builds a DOI citation with the StatCan licence', () => {
    const c = citation(14100459, 'Labour force characteristics');
    expect(c.text).toBe(
      'Statistics Canada. Table 14-10-0459-01 Labour force characteristics. DOI: https://doi.org/10.25318/1410045901-eng',
    );
    expect(c.tableUrl).toContain('pid=1410045901');
    expect(c.licence.name).toBe('Statistics Canada Open Licence');
  });
});

describe('matchMember: the Waterloo problem', () => {
  // Geography members as they appear across StatCan tables at different levels.
  const geos = [
    m(1, 'Canada'),
    m(2, 'Ontario'),
    m(10, 'Waterloo, Ontario'), // the city (census subdivision)
    m(11, 'Waterloo, Regional municipality, Ontario'), // the region (census division)
    m(12, 'Kitchener-Cambridge-Waterloo, Ontario'), // the metro area (CMA)
    m(20, 'Hamilton, Ontario'),
    m(21, 'Toronto, Ontario'),
    m(22, 'Oshawa, Ontario', 1), // terminated member is ignored
  ];

  it('prefers an exact match on the place name before the province', () => {
    expect(matchMember(geos, 'Hamilton')).toMatchObject({
      kind: 'exact',
      member: { memberId: 20 },
    });
  });

  it('treats a bare "Waterloo" as ambiguous (city vs region vs CMA) and offers all three', () => {
    const r = matchMember(geos, 'Waterloo');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.memberId)).toEqual([10, 11, 12]);
  });

  it('an exact full name wins, but near-misses are reported', () => {
    const r = matchMember(geos, 'Waterloo, Ontario');
    expect(r).toMatchObject({ kind: 'exact', member: { memberId: 10 } });
    if (r.kind === 'exact') expect(r.similar.map((c) => c.memberId)).toEqual([11, 12]);
  });

  it('matches the CMA by its full name, with any dash style', () => {
    expect(matchMember(geos, 'Kitchener–Cambridge–Waterloo')).toMatchObject({
      member: { memberId: 12 },
    });
  });

  it('reports ambiguity instead of guessing when only partial words match', () => {
    const r = matchMember(geos, 'Ontario');
    expect(r).toMatchObject({ kind: 'exact', member: { memberId: 2 } });
    const partial = matchMember(geos, 'regional');
    expect(partial).toMatchObject({ kind: 'unique', member: { memberId: 11 } });
  });

  it('a CMA-only table resolves "Waterloo" to the one CMA that contains it', () => {
    const cmaOnly = [
      m(1, 'Canada'),
      m(29, 'Kitchener-Cambridge-Waterloo, Ontario'),
      m(30, 'Toronto, Ontario'),
    ];
    expect(matchMember(cmaOnly, 'waterloo')).toMatchObject({
      kind: 'unique',
      member: { memberId: 29 },
    });
  });

  it('ignores terminated members and handles accents', () => {
    expect(matchMember(geos, 'Oshawa').kind).toBe('none');
    expect(normalize('Montréal–Québec')).toBe('montreal quebec');
  });
});

describe('resolveCoordinate', () => {
  const meta = {
    productId: 14100459,
    cubeTitleEn: 'Labour force characteristics by CMA',
    footnote: [],
    dimension: [
      {
        dimensionPositionId: 1,
        dimensionNameEn: 'Geography',
        member: [
          m(1, 'Canada'),
          m(29, 'Kitchener-Cambridge-Waterloo, Ontario'),
          m(20, 'Hamilton, Ontario'),
        ],
      },
      {
        dimensionPositionId: 2,
        dimensionNameEn: 'Labour force characteristics',
        member: [m(1, 'Population'), m(4, 'Unemployment'), m(5, 'Unemployment rate')],
      },
      {
        dimensionPositionId: 3,
        dimensionNameEn: 'Statistics',
        member: [m(1, 'Estimate'), m(2, 'Standard error of estimate')],
      },
      {
        dimensionPositionId: 4,
        dimensionNameEn: 'Data type',
        member: [m(1, 'Seasonally adjusted'), m(2, 'Unadjusted')],
      },
    ],
  } as unknown as CubeMeta;
  const client = new StatCanClient({} as never, {} as never);

  it('builds a padded coordinate and reports defaults transparently', () => {
    const r = client.resolveCoordinate(meta, 'Kitchener-Cambridge-Waterloo', {
      'labour force characteristics': 'unemployment rate',
    });
    expect(r.coordinate).toBe('29.5.1.1.0.0.0.0.0.0');
    expect(r.resolved).toEqual([
      { dimension: 'Geography', member: 'Kitchener-Cambridge-Waterloo, Ontario', how: 'matched' },
      { dimension: 'Labour force characteristics', member: 'Unemployment rate', how: 'matched' },
      { dimension: 'Statistics', member: 'Estimate', how: 'default' },
      { dimension: 'Data type', member: 'Seasonally adjusted', how: 'default' },
    ]);
  });

  it('demands a choice when no sensible default exists, listing the options', () => {
    expect(() => client.resolveCoordinate(meta, 'Hamilton', {})).toThrow(
      /Choose a value for "Labour force characteristics"/,
    );
    try {
      client.resolveCoordinate(meta, 'Hamilton', {});
    } catch (e) {
      expect((e as InvalidInputError).hint).toContain('"Unemployment rate"');
    }
  });

  it('rejects unknown dimension names', () => {
    expect(() =>
      client.resolveCoordinate(meta, 'Hamilton', {
        'Labour force characteristics': 'Unemployment rate',
        Sex: 'Males',
      }),
    ).toThrow(/Unknown dimension/);
  });

  it('explains when "Unemployment" is ambiguous with "Unemployment rate"', () => {
    // "unemployment" is an exact member, so it wins; "rate" alone is unique.
    expect(
      client.resolveCoordinate(meta, 'Hamilton', { 'Labour force characteristics': 'rate' })
        .coordinate,
    ).toBe('20.5.1.1.0.0.0.0.0.0');
    expect(
      client.resolveCoordinate(meta, 'Hamilton', { 'Labour force characteristics': 'unemployment' })
        .coordinate,
    ).toBe('20.4.1.1.0.0.0.0.0.0');
  });
});

describe('toRefDate', () => {
  it('expands partial dates to period edges', () => {
    expect(toRefDate('2019', 'start')).toBe('2019-01-01');
    expect(toRefDate('2019', 'end')).toBe('2019-12-31');
    expect(toRefDate('2024-02', 'end')).toBe('2024-02-29');
    expect(toRefDate('2024-02-10', 'start')).toBe('2024-02-10');
    expect(() => toRefDate('last year', 'start')).toThrow(InvalidInputError);
  });
});

describe('look-alike members (as in census table 98-10-0002)', () => {
  // Real shape: several CSDs named exactly "Waterloo", told apart only by their parent.
  const csds = [
    m(1, 'Canada'),
    m(24, 'Quebec', 0, 1),
    m(35, 'Ontario', 0, 1),
    m(12, 'Nova Scotia', 0, 1),
    m(100, 'Waterloo', 0, 24),
    m(200, 'Waterloo', 0, 35),
    m(300, 'Waterloo', 0, 12),
  ];

  it('labels duplicates with their ancestry and id', () => {
    expect(memberLabel(csds[5]!, csds)).toBe('Waterloo (in Ontario) [id:200]');
    expect(memberLabel(csds[2]!, csds)).toBe('Ontario (contains 1 sub-area)'); // "Canada" is implied
    expect(memberLabel(csds[5]!, csds, false)).toBe('Waterloo [id:200]'); // non-geography: no hierarchy
  });

  it('tells a city from the region of the same name', () => {
    const geo = [
      m(1, 'Canada'),
      m(35, 'Ontario', 0, 1),
      m(2864, 'Waterloo', 0, 35), // the region (census division)
      m(2865, 'Kitchener', 0, 2864),
      m(2868, 'Waterloo', 0, 2864), // the city
      m(500, 'Hamilton, Ontario', 0, 35),
    ];
    expect(memberLabel(geo[2]!, geo)).toBe('Waterloo (in Ontario; contains 2 sub-areas) [id:2864]');
    expect(memberLabel(geo[4]!, geo)).toBe('Waterloo (in Waterloo, Ontario) [id:2868]');
    expect(memberLabel(geo[5]!, geo)).toBe('Hamilton, Ontario'); // province already in the name
  });

  it('reports the duplicates as ambiguous, then accepts id:<n>', () => {
    expect(matchMember(csds, 'Waterloo').kind).toBe('ambiguous');
    expect(matchMember(csds, 'id:200')).toMatchObject({ kind: 'exact', member: { memberId: 200 } });
    expect(matchMember(csds, 'id:999').kind).toBe('none');
  });

  it('the ambiguity error tells the model exactly what to pass back', () => {
    const client = new StatCanClient({} as never, {} as never);
    const meta = {
      productId: 98100002,
      cubeTitleEn: 'Population and dwelling counts',
      footnote: [],
      dimension: [{ dimensionPositionId: 1, dimensionNameEn: 'Geography', member: csds }],
    } as unknown as CubeMeta;
    let hint = '';
    try {
      client.resolveCoordinate(meta, 'Waterloo', {});
    } catch (e) {
      hint = (e as InvalidInputError).hint ?? '';
    }
    expect(hint).toContain('"Waterloo (in Ontario) [id:200]"');
    expect(hint).toContain('"Waterloo (in Quebec) [id:100]"');
    expect(client.resolveCoordinate(meta, 'id:200', {}).resolved[0]!.member).toBe(
      'Waterloo (in Ontario) [id:200]',
    );
  });
});

describe('census tables (no vectors)', () => {
  it('reads by coordinate when getSeriesInfo answers vectorId 0', async () => {
    const urls: string[] = [];
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    const http = {
      request: async (url: string) => {
        urls.push(url);
        if (url.endsWith('/getSeriesInfoFromCubePidCoord')) {
          return json([
            {
              status: 'SUCCESS',
              object: {
                responseStatusCode: 0,
                vectorId: 0,
                SeriesTitleEn: 'Waterloo;Population, 2021',
                memberUomCode: 0,
              },
            },
          ]);
        }
        if (url.endsWith('/getDataFromCubePidCoordAndLatestNPeriods')) {
          return json([
            {
              status: 'SUCCESS',
              object: {
                vectorId: 0,
                vectorDataPoint: [
                  { refPer: '2021-01-01', value: 121436, statusCode: 0, symbolCode: 0 },
                ],
              },
            },
          ]);
        }
        throw new Error(`unexpected ${url}`);
      },
      getJson: async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith('/getCodeSets'))
          return {
            status: 'SUCCESS',
            object: { scalar: [], frequency: [], symbol: [], status: [], uom: [] },
          };
        throw new Error(`vector endpoint must not be used for census tables: ${url}`);
      },
    };
    const client = new StatCanClient(http as never, {} as never);
    const meta = {
      productId: 98100002,
      cubeTitleEn: 'Population',
      footnote: [],
      dimension: [],
    } as unknown as CubeMeta;
    const s = await client.series(meta, '2868.1.0.0.0.0.0.0.0.0', {
      start: '2016-01-01',
      end: '2026-11-02',
    });
    expect(s.vectorId).toBeNull();
    expect(s.points).toEqual([{ period: '2021-01-01', value: 121436 }]);
    expect(urls.some((u) => u.includes('getDataFromVector'))).toBe(false);
  });
});

describe('option labels are accepted back verbatim', () => {
  const geo = [
    m(1, 'Canada'),
    m(35, 'Ontario', 0, 1),
    m(2864, 'Waterloo', 0, 35),
    m(2868, 'Waterloo', 0, 2864),
    m(500, 'Waterloo (CY), Ontario', 0, 35),
  ];
  it('by the [id:n] suffix', () => {
    expect(matchMember(geo, 'Waterloo (in Waterloo, Ontario) [id:2868]')).toMatchObject({
      member: { memberId: 2868 },
    });
  });
  it('by stripping the "(in …)" context, even when it contains parentheses', () => {
    // Real label from table 17-10-0155-01, which Haiku passed back during the evals.
    expect(
      matchMember(
        geo,
        'Waterloo (CY), Ontario (in Census subdivisions with 5,000-plus population, Ontario)',
      ),
    ).toMatchObject({ kind: 'exact', member: { memberId: 500 } });
    expect(matchMember(geo, 'Ontario (contains 2 sub-areas)')).toMatchObject({
      member: { memberId: 35 },
    });
  });
});

describe('fewer round trips (found by evals)', () => {
  const csds = [
    m(1, 'Canada'),
    m(24, 'Quebec', 0, 1),
    m(35, 'Ontario', 0, 1),
    m(2864, 'Waterloo', 0, 35),
    m(2868, 'Waterloo', 0, 2864),
    m(1327, 'Waterloo', 0, 24),
  ];
  const meta = {
    productId: 98100002,
    cubeTitleEn: 'Population and dwelling counts',
    footnote: [],
    dimension: [
      { dimensionPositionId: 1, dimensionNameEn: 'Geographic name', member: csds },
      {
        dimensionPositionId: 2,
        dimensionNameEn: 'Population and dwelling counts (13)',
        member: [m(1, 'Population, 2021'), m(2, 'Population, 2016')],
      },
    ],
  } as unknown as CubeMeta;
  const client = new StatCanClient({} as never, {} as never);

  it('reports an ambiguous place and a missing member in one error', () => {
    let e: InvalidInputError | undefined;
    try {
      client.resolveCoordinate(meta, 'Waterloo', {});
    } catch (err) {
      e = err as InvalidInputError;
    }
    expect(e!.message).toContain('matches several Geographic name options');
    expect(e!.message).toContain('Choose a value for "Population and dwelling counts (13)"');
    expect(e!.hint).toContain('[id:2868]');
    expect(e!.hint).toContain('"Population, 2021"');
  });

  it('uses the "(in …)" context of a label without its id', () => {
    const r = client.resolveCoordinate(meta, 'Waterloo (in Waterloo, Ontario)', {
      'Population and dwelling counts (13)': 'Population, 2021',
    });
    expect(r.coordinate).toBe('2868.1.0.0.0.0.0.0.0.0');
  });
});
