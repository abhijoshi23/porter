import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DownloadCache,
  HttpClient,
  loadConfig,
  silentLogger,
  type FetchFn,
} from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { AGENCIES } from './agencies.js';
import { configSchema } from './config.js';
import { FeedStore } from './feed-store.js';
import { feedZip, TESTVILLE } from './testing/fixture-feed.js';

function setup(o: {
  fetch: FetchFn;
  env?: Record<string, string>;
  dir?: string;
  now?: () => number;
}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'porter-store-'));
  const config = loadConfig(configSchema, { PORTER_CACHE_DIR: dir, LOG_LEVEL: 'silent', ...o.env });
  const http = new HttpClient({ userAgent: 't', log: silentLogger, fetch: o.fetch });
  const downloads = new DownloadCache({ dir, http, log: silentLogger });
  return {
    dir,
    store: new FeedStore({
      config,
      http,
      downloads,
      log: silentLogger,
      ...(o.now ? { now: o.now } : {}),
    }),
  };
}

const zip = feedZip(TESTVILLE);
function countingFetch(body: () => Buffer = () => zip, delayMs = 0) {
  const calls: string[] = [];
  const fetch: FetchFn = async (input) => {
    calls.push(String(input));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(new Uint8Array(body()), { headers: { 'content-type': 'application/zip' } });
  };
  return { calls, fetch };
}

describe('FeedStore', () => {
  it('builds once, then reuses the database across restarts without the network', async () => {
    const a = countingFetch();
    const first = setup({ fetch: a.fetch });
    const db = await first.store.get(AGENCIES.grt);
    expect(db.meta.agencyName).toBe('Testville Transit');
    expect(first.store.status('grt').state).toBe('ready');
    first.store.close();

    const b = countingFetch();
    const second = setup({ fetch: b.fetch, dir: first.dir });
    expect((await second.store.get(AGENCIES.grt)).meta.version).toBe('TV-2026-11');
    expect(b.calls).toEqual([]); // reopened from the pointer file
    second.store.close();
  });

  it('shares one build between concurrent calls', async () => {
    const f = countingFetch();
    const { store } = setup({ fetch: f.fetch });
    const [x, y] = await Promise.all([store.get(AGENCIES.grt), store.get(AGENCIES.grt)]);
    expect(x).toBe(y);
    expect(f.calls).toHaveLength(1);
    store.close();
  });

  it('answers "still preparing" instead of hanging, and finishes in the background', async () => {
    const f = countingFetch(() => zip, 300);
    const { store } = setup({ fetch: f.fetch, env: { PORTER_TRANSIT_BUILD_WAIT_MS: '20' } });
    await expect(store.get(AGENCIES.grt)).rejects.toMatchObject({
      message: expect.stringContaining('still being downloaded'),
      retryable: true,
    });
    expect(store.status('grt').state).toBe('preparing');
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.status('grt').state).toBe('ready');
    store.close();
  });

  it('after the refresh interval, rebuilds only if the feed changed, and removes the old database', async () => {
    let t = Date.parse('2026-11-02T13:00:00Z');
    let body = zip;
    const f = countingFetch(() => body);
    const { store, dir } = setup({
      fetch: f.fetch,
      now: () => t,
      env: { PORTER_TRANSIT_REFRESH_HOURS: '1' },
    });
    const db1 = await store.get(AGENCIES.grt);

    // Same bytes re-published: no rebuild.
    t += 2 * 3600_000;
    await store.get(AGENCIES.grt); // serves current, refreshes in the background
    await new Promise((r) => setTimeout(r, 300));
    expect(await store.get(AGENCIES.grt)).toBe(db1);

    // A new version: rebuilt and swapped in.
    body = feedZip({
      ...TESTVILLE,
      'feed_info.txt': TESTVILLE['feed_info.txt']!.replace('TV-2026-11', 'TV-2026-12'),
    });
    t += 2 * 3600_000;
    await store.get(AGENCIES.grt);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await store.get(AGENCIES.grt)).meta.version).toBe('TV-2026-12');
    const dbs = readdirSync(join(dir, 'transit')).filter((x) => x.endsWith('.duckdb'));
    expect(dbs).toHaveLength(1);
    store.close();
  });

  it('reports a broken download as failed, drops it, and recovers on the next call', async () => {
    let bad = true;
    const f = countingFetch(() => (bad ? Buffer.from('<html>maintenance</html>') : zip));
    const { store } = setup({ fetch: f.fetch });
    await expect(store.get(AGENCIES.grt)).rejects.toThrow(/not a valid ZIP/);
    expect(store.status('grt').state).toBe('failed');
    bad = false;
    // The bad download was dropped from the cache, so the retry fetches again and succeeds.
    await expect(store.get(AGENCIES.grt)).resolves.toBeDefined();
    expect(f.calls).toHaveLength(2);
    store.close();
  });
});
