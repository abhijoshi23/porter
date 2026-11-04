import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { PorterError, UpstreamError, UpstreamTimeoutError } from './errors.js';
import { HttpClient, parseRetryAfter, type FetchFn } from './http.js';
import { silentLogger } from './logger.js';

function client(fetch: FetchFn, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const http = new HttpClient({
    userAgent: 'porter-test',
    log: silentLogger,
    fetch,
    sleep,
    rateLimit: { perSecond: 1000, burst: 1000 },
    ...extra,
  });
  return { http, sleep };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('HttpClient', () => {
  it('sends a User-Agent and validates JSON', async () => {
    const fetch = vi.fn<FetchFn>(async () => json({ ok: true }));
    const { http } = client(fetch);
    await expect(
      http.getJson('https://api.test/x', z.object({ ok: z.boolean() })),
    ).resolves.toEqual({ ok: true });
    const init = fetch.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['user-agent']).toBe('porter-test');
  });

  it('retries 503 then succeeds', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ n: 1 }));
    const { http, sleep } = client(fetch);
    await expect(http.getJson('https://api.test/x', z.object({ n: z.number() }))).resolves.toEqual({
      n: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('honours Retry-After on 429', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(json({}));
    const { http, sleep } = client(fetch);
    await http.request('https://api.test/x');
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('gives up after the retry budget with a typed, retryable error', async () => {
    const fetch = vi.fn<FetchFn>(async () => json({}, 502));
    const { http } = client(fetch, { retries: 2 });
    const err = await http.request('https://api.test/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ status: 502, host: 'api.test', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry 404, and gives an actionable hint', async () => {
    const fetch = vi.fn<FetchFn>(async () => json({}, 404));
    const { http } = client(fetch);
    const err = (await http
      .request('https://api.test/x')
      .catch((e: unknown) => e)) as UpstreamError;
    expect(fetch).toHaveBeenCalledOnce();
    expect(err.hint).toMatch(/search again/);
  });

  it('hands back error responses when asked, after retrying', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ Fault: { type: 'ValidationFault' } }, 400));
    const { http } = client(fetch);
    const res = await http.request('https://api.test/x', { returnErrors: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ Fault: { type: 'ValidationFault' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never retries non-idempotent methods', async () => {
    const fetch = vi.fn<FetchFn>(async () => json({}, 503));
    const { http } = client(fetch);
    await expect(
      http.request('https://api.test/x', { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('turns a hung upstream into a timeout error', async () => {
    const fetch: FetchFn = (_u, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
      );
    const { http } = client(fetch, { timeoutMs: 20, retries: 0 });
    await expect(http.request('https://slow.test/x')).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('reports upstream schema drift clearly', async () => {
    const { http } = client(async () => json({ unexpected: 1 }));
    await expect(
      http.getJson('https://api.test/x', z.object({ result: z.array(z.string()) })),
    ).rejects.toThrow(/unexpected format/);
  });

  it('does not retry when the caller aborts', async () => {
    const ac = new AbortController();
    const fetch = vi.fn<FetchFn>(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const { http } = client(fetch);
    const err = await http
      .request('https://api.test/x', { signal: ac.signal })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PorterError);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('parseRetryAfter', () => {
  it('handles seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')),
    ).toBe(5000);
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
