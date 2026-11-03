import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadCache, HttpClient, loadConfig, silentLogger } from '@abhijoshi23/porter-toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from './config.js';
import { historyUrls, NEW_URL, OPEN_URL, TenderStore } from './store.js';
import { FY_2025, FY_2026, NEW_FILE, NOW, OPEN_FILE, tenderCsv } from './testing/fixtures.js';

const [FY26, FY25] = historyUrls(NOW, 2) as [string, string];

function setup(files: Record<string, () => Response>, env: Record<string, string> = {}) {
  const requests: string[] = [];
  let now = NOW;
  const http = new HttpClient({
    userAgent: 'test',
    log: silentLogger,
    fetch: async (input, init) => {
      const url = new Request(input, init).url;
      requests.push(url);
      const f = files[url];
      if (!f) throw new Error(`unexpected request ${url}`);
      return f();
    },
  });
  const config = loadConfig(configSchema, {
    PORTER_CACHE_DIR: mkdtempSync(join(tmpdir(), 'porter-tenders-store-')),
    LOG_LEVEL: 'silent',
    ...env,
  });
  const downloads = new DownloadCache({ dir: config.PORTER_CACHE_DIR, http, log: silentLogger });
  const store = new TenderStore({ config, downloads, log: silentLogger, now: () => now });
  return { store, requests, advance: (ms: number) => (now += ms) };
}

const csv = (fx: Parameters<typeof tenderCsv>[0]) => () => new Response(tenderCsv(fx));
const ALL = {
  [OPEN_URL]: csv(OPEN_FILE),
  [NEW_URL]: csv(NEW_FILE),
  [FY26]: csv(FY_2026),
  [FY25]: csv(FY_2025),
};

describe('historyUrls', () => {
  it('names the current and previous federal fiscal years (April to March)', () => {
    expect(historyUrls(NOW, 2).map((u) => u.split('/').pop())).toEqual([
      '2026-2027-TenderNotice-AvisAppelOffres.csv',
      '2025-2026-TenderNotice-AvisAppelOffres.csv',
    ]);
    expect(historyUrls(Date.parse('2026-03-31T12:00:00Z'), 1)[0]).toContain('2025-2026');
  });
});

describe('TenderStore', () => {
  afterEach(() => vi.useRealTimers());

  it('merges open and new notices, keeping the later amendment', async () => {
    const { store } = setup(ALL);
    const s = await store.open();
    expect(s.notices).toHaveLength(OPEN_FILE.length + 1);
    expect(s.byId.get('cb-100-00000001')!.amendment).toBe(3);
    expect(s.bySolicitation.get('w0001-26')).toHaveLength(2);
  });

  it('loads history only when asked, from both fiscal years', async () => {
    const { store, requests } = setup(ALL);
    await store.open();
    expect(requests.some((u) => u.includes('TenderNotice-Avis'))).toBe(false);
    const h = await store.history();
    expect(h!.notices.map((n) => n.id).sort()).toEqual([
      'cb-111-00000012',
      'cb-222-00000013',
      'cb-333-00000014',
    ]);
  });

  it('serves the previous snapshot when a refresh fails', async () => {
    let broken = false;
    const { store, advance } = setup({
      ...ALL,
      [OPEN_URL]: () =>
        broken ? new Response('<html>maintenance</html>') : new Response(tenderCsv(OPEN_FILE)),
    });
    const first = await store.open();
    broken = true;
    advance(7 * 3600_000);
    // DownloadCache checks freshness against the real clock: move it too, so the file is
    // really downloaded again and fails validation.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 7 * 3600_000 });
    const again = await store.open();
    expect(again).toBe(first);
  });

  it('reuses the parsed snapshot when no file changed', async () => {
    const { store, requests, advance } = setup(ALL);
    const first = await store.open();
    advance(7 * 3600_000); // store TTL passes; the files on disk are still fresh
    expect(await store.open()).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it('rejects an error page on first load, retryably', async () => {
    const { store } = setup({
      ...ALL,
      [OPEN_URL]: () => new Response('<html>Service unavailable</html>'),
    });
    await expect(store.open()).rejects.toMatchObject({ retryable: true });
  });

  it('accepts an empty new-notices file', async () => {
    const { store } = setup({ ...ALL, [NEW_URL]: () => new Response('') });
    expect((await store.open()).notices).toHaveLength(OPEN_FILE.length);
  });

  it('skips history when disabled', async () => {
    const { store } = setup(ALL, { PORTER_TENDERS_HISTORY_YEARS: '0' });
    expect(await store.history()).toBeNull();
  });
});
