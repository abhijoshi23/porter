import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import {
  citation,
  matchMember,
  normalize,
  parseProductId,
  StatCanClient,
  tableNumber,
  type CubeMeta,
} from './statcan.js';
import { toRefDate } from './tools.js';

const m = (memberId: number, memberNameEn: string, terminated = 0) => ({
  memberId,
  memberNameEn,
  terminated,
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
