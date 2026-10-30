import type * as z from 'zod/v4';
import { PorterError, UpstreamError, UpstreamTimeoutError } from './errors.js';
import type { Logger } from './logger.js';
import { HostRateLimiter } from './rate-limit.js';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Identify ourselves to public-data hosts, which is polite and helps them contact us. */
  userAgent: string;
  log: Logger;
  timeoutMs?: number;
  /** Retries after the first attempt, for GET/HEAD only. */
  retries?: number;
  rateLimit?: { perSecond: number; burst: number };
  rateLimitOverrides?: Record<string, { perSecond: number; burst: number }>;
  /** Injected in tests (fixture replay). Defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Injected in tests so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 8_000;

/**
 * A fetch wrapper for upstream APIs: per-host rate limit, then timeout, then retry with
 * jittered exponential backoff (honouring `Retry-After`), then typed errors that
 * `defineTool` turns into model-readable results.
 */
export class HttpClient {
  private readonly limiter: HostRateLimiter;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new HostRateLimiter(
      opts.rateLimit ?? { perSecond: 5, burst: 10 },
      opts.rateLimitOverrides,
    );
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
  }

  async request(url: string | URL, ro: RequestOptions = {}): Promise<Response> {
    const u = new URL(url);
    const method = (ro.method ?? 'GET').toUpperCase();
    // Only retry requests that are safe to repeat. Writes go through explicit confirmation instead.
    const maxAttempts = method === 'GET' || method === 'HEAD' ? this.retries + 1 : 1;
    const timeoutMs = ro.timeoutMs ?? this.timeoutMs;

    for (let attempt = 1; ; attempt++) {
      await this.limiter.take(u.host);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ro.signal ? AbortSignal.any([ro.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchFn(u, {
          method,
          headers: { 'user-agent': this.opts.userAgent, ...ro.headers },
          ...(ro.body === undefined ? {} : { body: ro.body }),
          signal,
        });
      } catch (err) {
        if (ro.signal?.aborted) throw err; // the caller cancelled, so don't retry
        const failure = timeout.aborted
          ? new UpstreamTimeoutError(u.host, timeoutMs, err)
          : new PorterError(`Could not reach ${u.host}.`, {
              hint: 'Network error. Retry shortly.',
              retryable: true,
              cause: err,
            });
        if (attempt >= maxAttempts) throw failure;
        await this.backoff(attempt, null, u, String(err));
        continue;
      }

      if (res.ok) return res;
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
        await res.body?.cancel();
        await this.backoff(attempt, res.headers.get('retry-after'), u, `HTTP ${res.status}`);
        continue;
      }
      await res.body?.cancel();
      throw new UpstreamError(u.host, res.status);
    }
  }

  /** GET JSON and validate its shape. Upstream drift becomes a clear error instead of `undefined` deep inside a handler. */
  async getJson<S extends z.ZodType>(
    url: string | URL,
    schema: S,
    ro?: RequestOptions,
  ): Promise<z.output<S>> {
    const res = await this.request(url, {
      ...ro,
      headers: { accept: 'application/json', ...ro?.headers },
    });
    const host = new URL(url).host;
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new PorterError(`${host} returned invalid JSON.`, { retryable: true, cause: err });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.opts.log.error(
        { host, issues: parsed.error.issues.slice(0, 5) },
        'upstream schema mismatch',
      );
      throw new PorterError(`${host} returned data in an unexpected format.`, {
        hint: 'The upstream API may have changed. Tell the user this source is temporarily unavailable.',
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async getText(url: string | URL, ro?: RequestOptions): Promise<string> {
    return (await this.request(url, ro)).text();
  }

  async getBytes(url: string | URL, ro?: RequestOptions): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(url, ro)).arrayBuffer());
  }

  private async backoff(
    attempt: number,
    retryAfter: string | null,
    u: URL,
    reason: string,
  ): Promise<void> {
    // "Full jitter": a random delay in [0, base * 2^attempt). This spreads retries out so
    // many clients don't hammer a recovering upstream at the same moment.
    let delay = Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    const ra = retryAfter ? parseRetryAfter(retryAfter) : null;
    if (ra !== null) delay = Math.min(MAX_DELAY_MS, ra);
    this.opts.log.debug(
      { host: u.host, attempt, delay: Math.round(delay), reason },
      'retrying upstream request',
    );
    await this.sleep(delay);
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string, now = Date.now()): number | null {
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
