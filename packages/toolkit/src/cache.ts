import { LRUCache } from 'lru-cache';

/**
 * In-memory LRU cache with per-entry TTL and single-flight loading. If a model fires
 * three identical `get_dataset` calls in parallel, only one upstream request happens.
 * The persistent SQLite cache for large downloads (GTFS, StatCan) arrives in Milestone 2.
 */
export class MemoryCache<V extends object | string | number | boolean> {
  private readonly lru: LRUCache<string, V>;
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(opts: { max: number; ttlMs: number }) {
    this.lru = new LRUCache<string, V>({ max: opts.max, ttl: opts.ttlMs });
  }

  get(key: string): V | undefined {
    return this.lru.get(key);
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.lru.set(key, value, ttlMs === undefined ? undefined : { ttl: ttlMs });
  }

  async getOrLoad(key: string, load: () => Promise<V>, ttlMs?: number): Promise<V> {
    const hit = this.lru.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
