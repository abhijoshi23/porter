import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, serverFactory, silentLogger, type FetchFn } from '@abhijoshi23/porter-toolkit';
import { connectTestClient, ERAS, type TestClient } from '@abhijoshi23/porter-toolkit/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, createTendersServer } from '../src/server.js';
import { historyUrls, NEW_URL, OPEN_URL } from '../src/store.js';
import { FY_2025, FY_2026, NEW_FILE, NOW, OPEN_FILE, tenderCsv } from '../src/testing/fixtures.js';

const [FY26, FY25] = historyUrls(NOW, 2);
const FILES: Record<string, string> = {
  [OPEN_URL]: tenderCsv(OPEN_FILE),
  [NEW_URL]: tenderCsv(NEW_FILE),
  [FY26!]: tenderCsv(FY_2026),
  [FY25!]: tenderCsv(FY_2025),
};
const fetchFixture: FetchFn = async (input, init) => {
  const url = new Request(input, init).url;
  const body = FILES[url];
  if (body === undefined) throw new Error(`unexpected request in test: ${url}`);
  return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
};

const cacheDir = mkdtempSync(join(tmpdir(), 'porter-tenders-it-'));
function factory() {
  const config = loadConfig(configSchema, { PORTER_CACHE_DIR: cacheDir, LOG_LEVEL: 'silent' });
  return serverFactory(
    createTendersServer({ config, log: silentLogger, fetch: fetchFixture, now: () => NOW }),
    silentLogger,
  );
}

type Result = { structuredContent?: unknown; content: unknown; isError?: boolean };
const text = (r: Result) => (r.content as { text: string }[])[0]!.text;
const summaryLine = (r: Result) => text(r).split('\n\n')[0]!;

interface Item {
  id: string;
  title: string;
  status: string;
  kind: string;
  closes: string | null;
  daysLeft: number | null;
  nationalDelivery?: boolean;
  matched?: { terms: string[]; topics: string[] };
}
interface Search {
  total: number;
  results: Item[];
  interpretation: { topics: { id: string }[]; region?: string };
  notes: string[];
  source: { licence: { name: string } };
}

describe.each(ERAS)('porter-tenders over the %s protocol', (era) => {
  let t: TestClient;
  afterEach(async () => t?.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    t ??= await connectTestClient(factory(), era);
    return (await t.client.callTool({ name, arguments: args })) as Result;
  };
  const search = async (args: Record<string, unknown>) =>
    (await call('search_tenders', args)).structuredContent as Search;

  it('advertises 3 read-only tools and the tender_scan prompt', async () => {
    t = await connectTestClient(factory(), era);
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name)).toEqual([
      'search_tenders',
      'get_tender',
      'summarize_tender_fit',
    ]);
    expect(tools.every((x) => x.annotations?.readOnlyHint === true)).toBe(true);
    const { prompts } = await t.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['tender_scan']);
  });

  it('finds IT consulting in Ontario, counting the NCR as Ontario', async () => {
    t = await connectTestClient(factory(), era);
    const s = await search({ query: 'IT consulting', region: 'Ontario' });
    expect(s.results[0]).toMatchObject({ id: 'cb-100-00000001', status: 'open', kind: 'bid' });
    expect(s.results[0]!.matched!.topics).toEqual(['it']);
    expect(s.interpretation).toMatchObject({ topics: [{ id: 'it' }], region: 'ontario' });
    expect(s.source.licence.name).toBe('Open Government Licence – Canada');
  });

  it('browses by closing time, leaving out a notice whose closing time has passed', async () => {
    t = await connectTestClient(factory(), era);
    const s = await search({ closesWithinDays: 8 });
    expect(s.results.map((r) => r.id)).toEqual(['cb-500-00000005', 'MX-200000000002']);
    expect(s.results[0]).toMatchObject({ kind: 'information', daysLeft: 1.2 });
  });

  it('lists local notices before Canada-wide ones for a region', async () => {
    t = await connectTestClient(factory(), era);
    const s = await search({ region: 'ON', limit: 25 });
    const firstNational = s.results.findIndex((r) => r.nationalDelivery);
    expect(firstNational).toBeGreaterThan(0);
    expect(s.results.slice(firstNational).every((r) => r.nationalDelivery)).toBe(true);
    expect(s.notes.join(' ')).toMatch(/Canada-wide/);
  });

  it('filters by buyer acronym', async () => {
    t = await connectTestClient(factory(), era);
    const s = await search({ buyer: 'DND' });
    expect(s.results.map((r) => r.id).sort()).toEqual([
      'MX-200000000002',
      'cb-800-00000008',
      'cb-800-00000009',
    ]);
  });

  it('searches closed and cancelled notices across fiscal years', async () => {
    t = await connectTestClient(factory(), era);
    const s = await search({ status: 'closed', limit: 25 });
    expect(s.results.map((r) => [r.id, r.status])).toEqual([
      ['cb-900-00000010', 'closed'], // closed this morning, still "Open" in the file
      ['cb-111-00000012', 'closed'],
      ['cb-222-00000013', 'cancelled'],
      ['cb-333-00000014', 'closed'],
    ]);
  });

  it('gets a notice with the newer amendment from the new-notices file', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'cb-100-00000001' });
    expect(r.structuredContent).toMatchObject({
      amendments: { count: 3, lastAmended: '2026-11-03' },
      closes: '2026-11-27T14:00:00-05:00',
      closesAsPublished: '2026-11-27T14:00:00',
      documents: ['https://example.gc.ca/rfp.pdf'],
      url: 'https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-100-00000001',
    });
    expect(summaryLine(r)).toBe(
      'Open: closes Fri 2026-11-27 14:00 ET (24 day(s) left). Amended 3 time(s).',
    );
  });

  it('reads summer closing times as EDT', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'cb-700-00000007' });
    expect(r.structuredContent).toMatchObject({ closes: '2027-06-15T14:00:00-04:00' });
  });

  it('finds an already-closed notice by solicitation number and says it is closed', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'TR-2026-01' });
    expect(r.isError).toBeFalsy();
    expect(summaryLine(r)).toBe('Closed Tue 2026-09-15 14:00 ET; bids are no longer accepted.');
    expect(r.structuredContent).toMatchObject({ status: 'closed', daysLeft: null });
  });

  it('asks which notice when a solicitation number is shared', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'W0001-26' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('cb-800-00000008');
    expect(text(r)).toContain('cb-800-00000009');
  });

  it('reports an unknown id with a hint', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'cb-0-0' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No tender notice "cb-0-0"[\s\S]*Hint:/);
  });

  it('keeps injected instructions out of the summary and strips their disguises', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('get_tender', { id: 'cb-600-00000006' });
    const d = r.structuredContent as { title: string; description: string };
    expect(d.title).toBe('Janitorial services Ottawa offices');
    expect(d.description).not.toMatch(/<!--|\u202E|## SYSTEM/);
    expect(summaryLine(r)).not.toMatch(/ignore|guaranteed|evil/i);
    const fit = await call('summarize_tender_fit', { id: 'cb-600-00000006' });
    expect(summaryLine(fit)).not.toMatch(/ignore|guaranteed|evil/i);
  });

  it('summarizes bid fit with evidence and profile checks', async () => {
    t = await connectTestClient(factory(), era);
    const r = await call('summarize_tender_fit', {
      id: 'MX-200000000002',
      profile: { clearance: 'none', indigenousBusiness: false },
    });
    expect(summaryLine(r)).toBe(
      'Open: closes Tue 2026-11-10 14:00 ET (7 day(s) left). Security: none. Set aside for Indigenous businesses. Mandatory site visit. Profile checks: 1 blocker(s).',
    );
    expect(r.structuredContent).toMatchObject({
      setAside: { type: 'set_aside' },
      siteVisit: { mandatory: true },
      checks: expect.arrayContaining([
        expect.objectContaining({ check: 'set-aside', result: 'blocker' }),
      ]),
    });
  });
});
