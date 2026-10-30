import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit.js';

/** Fake clock: `sleep` advances time instantly, so tests are fast and deterministic. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
}

describe('TokenBucket', () => {
  it('allows a burst immediately, then spaces requests at the refill rate', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 3, clock.now, clock.sleep);
    for (let i = 0; i < 3; i++) await bucket.take();
    expect(clock.elapsed()).toBe(0);
    await bucket.take();
    expect(clock.elapsed()).toBe(500);
    await bucket.take();
    expect(clock.elapsed()).toBe(1000);
  });

  it('serves concurrent callers in arrival order', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(10, 1, clock.now, clock.sleep);
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => bucket.take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('rejects nonsense configuration', () => {
    expect(() => new TokenBucket(0, 1)).toThrow(RangeError);
  });
});
