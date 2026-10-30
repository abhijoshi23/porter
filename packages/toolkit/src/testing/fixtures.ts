import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchFn } from '../http.js';

interface Fixture {
  request: { method: string; url: string };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    encoding: 'utf8' | 'base64';
  };
}

export interface FixtureFetchOptions {
  /** Directory holding `*.json` fixtures, usually `<package>/test/fixtures/http`. */
  dir: string;
  /**
   * `replay` (default) serves only recorded responses, and a missing fixture is an error
   * so tests never hit the network by accident. `record` performs real requests and saves
   * them. Set `PORTER_FIXTURES=record` to re-record.
   */
  mode?: 'replay' | 'record';
}

const TEXTUAL = /^(application\/(json|.*\+json|xml|csv)|text\/)/;

/**
 * A `fetch` replacement that records and replays HTTP exchanges as readable JSON files.
 * Pass it as `HttpClient({ fetch })`. Fixtures are committed, so tests are deterministic
 * and work offline in CI. Small enough that reviewers can see exactly what upstream data
 * a test relies on.
 */
export function createFixtureFetch(opts: FixtureFetchOptions): FetchFn {
  const mode = opts.mode ?? (process.env.PORTER_FIXTURES === 'record' ? 'record' : 'replay');

  return async (input, init) => {
    const req = new Request(input, init);
    const body = init?.body ? String(init.body) : '';
    const file = join(opts.dir, fixtureName(req.method, req.url, body));

    if (mode === 'replay') {
      let fixture: Fixture;
      try {
        fixture = JSON.parse(await readFile(file, 'utf8')) as Fixture;
      } catch {
        throw new Error(
          `No HTTP fixture for ${req.method} ${req.url} (expected ${file}). Re-run with PORTER_FIXTURES=record.`,
        );
      }
      const { status, headers, body: b, encoding } = fixture.response;
      return new Response(status === 204 ? null : Buffer.from(b, encoding), { status, headers });
    }

    const res = await fetch(req);
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    const encoding = TEXTUAL.test(contentType) ? 'utf8' : 'base64';
    const fixture: Fixture = {
      request: { method: req.method, url: req.url },
      response: {
        status: res.status,
        // Keep only headers our code reads, so fixtures don't capture cookies or tracking IDs.
        headers: pick(res.headers, ['content-type', 'retry-after', 'last-modified', 'etag']),
        body: bytes.toString(encoding),
        encoding,
      },
    };
    await mkdir(opts.dir, { recursive: true });
    await writeFile(file, JSON.stringify(fixture, null, 2) + '\n');
    return new Response(res.status === 204 ? null : bytes, {
      status: res.status,
      headers: res.headers,
    });
  };
}

function fixtureName(method: string, url: string, body: string): string {
  const u = new URL(url);
  const hash = createHash('sha256').update(`${method} ${url}\n${body}`).digest('hex').slice(0, 12);
  const slug = `${u.host}${u.pathname}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${method.toLowerCase()}-${slug}-${hash}.json`;
}

function pick(headers: Headers, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = headers.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}
