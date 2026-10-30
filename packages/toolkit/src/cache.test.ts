import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './cache.js';

describe('MemoryCache', () => {
  it('dedupes concurrent loads (single flight)', async () => {
    const cache = new MemoryCache<string>({ max: 10, ttlMs: 60_000 });
    const load = vi.fn(async () => 'value');
    const results = await Promise.all([1, 2, 3].map(() => cache.getOrLoad('k', load)));
    expect(results).toEqual(['value', 'value', 'value']);
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not cache failures', async () => {
    const cache = new MemoryCache<string>({ max: 10, ttlMs: 60_000 });
    await expect(cache.getOrLoad('k', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(cache.getOrLoad('k', async () => 'ok')).resolves.toBe('ok');
  });
});
