import { mkdtemp, readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DownloadCache } from './download-cache.js';
import { InvalidInputError } from './errors.js';
import { HttpClient, type FetchFn } from './http.js';
import { silentLogger } from './logger.js';

async function setup(fetch: FetchFn) {
  const dir = await mkdtemp(join(tmpdir(), 'porter-dl-'));
  const http = new HttpClient({
    userAgent: 't',
    log: silentLogger,
    fetch,
    rateLimit: { perSecond: 1000, burst: 1000 },
  });
  return { dir, cache: new DownloadCache({ dir, http, log: silentLogger }) };
}

describe('DownloadCache', () => {
  it('downloads once, then serves from disk while fresh', async () => {
    const fetch = vi.fn<FetchFn>(
      async () => new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv' } }),
    );
    const { cache } = await setup(fetch);
    const [a, b] = await Promise.all([
      cache.get('https://x.test/f.csv', { ttlMs: 60_000, maxBytes: 1000, ext: '.csv' }),
      cache.get('https://x.test/f.csv', { ttlMs: 60_000, maxBytes: 1000, ext: '.csv' }),
    ]);
    expect(a.path).toBe(b.path);
    expect(await readFile(a.path, 'utf8')).toBe('a,b\n1,2\n');
    await cache.get('https://x.test/f.csv', { ttlMs: 60_000, maxBytes: 1000, ext: '.csv' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('re-downloads after the TTL', async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response('x'));
    const { cache } = await setup(fetch);
    await cache.get('https://x.test/f', { ttlMs: 0, maxBytes: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    await cache.get('https://x.test/f', { ttlMs: 0, maxBytes: 1000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects oversize files by Content-Length without reading them', async () => {
    const { cache } = await setup(
      async () => new Response('x'.repeat(10), { headers: { 'content-length': '5000' } }),
    );
    await expect(
      cache.get('https://x.test/big', { ttlMs: 1, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('enforces the cap while streaming and leaves no partial file behind', async () => {
    const { cache, dir } = await setup(async () => new Response('x'.repeat(5000)));
    await expect(cache.get('https://x.test/big', { ttlMs: 1, maxBytes: 100 })).rejects.toThrow(
      /too large/,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});
