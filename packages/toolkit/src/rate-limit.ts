/**
 * Token bucket: holds up to `burst` tokens and refills at `perSecond` tokens per second.
 * `take()` resolves once a token is available. Callers queue (FIFO) rather than fail, so a
 * model that fans out ten calls at once gets politely spaced requests instead of
 * upstream 429s.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (perSecond <= 0 || burst < 1) throw new RangeError('perSecond must be > 0 and burst >= 1');
    this.tokens = burst;
    this.last = now();
  }

  take(): Promise<void> {
    // Chain onto the previous waiter so callers are served in arrival order.
    const turn = this.queue.then(() => this.acquire());
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
    }
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
  }
}

/** One bucket per upstream host, created on first use. */
export class HostRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaults: { perSecond: number; burst: number },
    private readonly overrides: Record<string, { perSecond: number; burst: number }> = {},
  ) {}

  take(host: string): Promise<void> {
    let bucket = this.buckets.get(host);
    if (!bucket) {
      const { perSecond, burst } = this.overrides[host] ?? this.defaults;
      bucket = new TokenBucket(perSecond, burst);
      this.buckets.set(host, bucket);
    }
    return bucket.take();
  }
}
