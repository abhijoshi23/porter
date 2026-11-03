import { describe, expect, it } from 'vitest';
import { csvRecords } from './csv.js';
import { multi, safeUrl, toNotice, type Notice } from './notices.js';
import { IT, INJECTION, SNOW, tenderCsv } from './testing/fixtures.js';

const parse = (...fx: Parameters<typeof tenderCsv>[0]): Notice[] =>
  csvRecords(tenderCsv(fx)).map(toNotice) as Notice[];

describe('toNotice', () => {
  it('maps the bilingual columns to one record', () => {
    const [n] = parse(IT);
    expect(n).toMatchObject({
      id: 'cb-100-00000001',
      solicitationNumber: 'IT-2026-001',
      status: 'open',
      amendment: 2,
      amendedOn: '2026-10-30',
      categories: ['services'],
      tradeAgreements: [
        'Canadian Free Trade Agreement (CFTA)',
        'World Trade Organization Agreement on Government Procurement (WTO GPA)',
      ],
      regionsOfDelivery: ['National Capital Region (NCR)'],
      unspsc: [
        { code: '80101507', description: 'Information technology consultation services' },
        { code: '81111500', description: 'Software or hardware engineering' },
      ],
    });
    // 14:00 Eastern on 2026-11-20 is EST (UTC−5).
    expect(n!.closesAt).toBe(Date.parse('2026-11-20T19:00:00Z'));
  });

  it('builds the CanadaBuys page URL for cb- notices, which have none in the file', () => {
    expect(parse(IT)[0]!.url).toBe(
      'https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-100-00000001',
    );
    expect(parse(SNOW)[0]!.url).toBe(
      'https://www.merx.com/public/solicitations/2/abstract?language=EN',
    );
  });

  it('drops non-http links', () => {
    expect(parse(IT)[0]!.attachments).toEqual(['https://example.gc.ca/rfp.pdf']);
    // A javascript: URL is dropped; a cb- notice then falls back to its CanadaBuys page.
    expect(parse(INJECTION)[0]!.url).toMatch(/^https:\/\/canadabuys\.canada\.ca\//);
    expect(safeUrl('/relative/path')).toBeNull();
  });

  it('sanitizes the searchable text', () => {
    const plain = parse(INJECTION)[0]!.plain;
    expect(plain).not.toContain('<!--');
    expect(plain).not.toContain('\u202E');
    expect(plain).not.toMatch(/^## /m);
  });
});

describe('multi', () => {
  it('splits starred multi-value cells', () => {
    expect(multi('*GD\n*SRV')).toEqual(['GD', 'SRV']);
    expect(multi('')).toEqual([]);
  });
});
