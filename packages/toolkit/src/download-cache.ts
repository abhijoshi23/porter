import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InvalidInputError } from './errors.js';
import type { HttpClient } from './http.js';
import type { Logger } from './logger.js';

interface Meta {
  url: string;
  fetchedAt: number;
  bytes: number;
  contentType: string | null;
}

export interface CachedFile {
  path: string;
  bytes: number;
  fetchedAt: Date;
  contentType: string | null;
}

/** `$XDG_CACHE_HOME/porter` or `~/.cache/porter`. */
export function defaultCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'porter');
}

/**
 * Persistent on-disk cache for large downloads (CSV resources, GTFS zips, StatCan
 * lists). Files are keyed by URL hash, so they survive restarts. A stdio server is
 * respawned every time Claude Desktop starts, and re-downloading a 12 MB feed each
 * time would be slow and rude to the publisher.
 *
 * - Downloads stream to disk with a byte cap, so a huge file cannot fill memory or disk.
 * - Writes go to a temp file and are renamed into place (atomic), so a crash never leaves
 *   a half-written file that looks valid.
 * - Concurrent requests for the same URL share one download (single-flight).
 */
export class DownloadCache {
  private readonly inflight = new Map<string, Promise<CachedFile>>();

  constructor(private readonly opts: { dir: string; http: HttpClient; log: Logger }) {}

  async get(
    url: string,
    o: { ttlMs: number; maxBytes: number; ext?: string; timeoutMs?: number },
  ): Promise<CachedFile> {
    const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
    const path = join(this.opts.dir, `${key}${o.ext ?? ''}`);
    const fresh = await this.readFresh(path, o.ttlMs);
    if (fresh) return fresh;

    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.download(url, path, o).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async readFresh(path: string, ttlMs: number): Promise<CachedFile | null> {
    try {
      const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as Meta;
      if (Date.now() - meta.fetchedAt > ttlMs) return null;
      await stat(path);
      return {
        path,
        bytes: meta.bytes,
        fetchedAt: new Date(meta.fetchedAt),
        contentType: meta.contentType,
      };
    } catch {
      return null;
    }
  }

  private async download(
    url: string,
    path: string,
    o: { maxBytes: number; timeoutMs?: number },
  ): Promise<CachedFile> {
    await mkdir(this.opts.dir, { recursive: true });
    const res = await this.opts.http.request(url, { timeoutMs: o.timeoutMs ?? 120_000 });
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (declared > o.maxBytes) {
      await res.body?.cancel();
      throw tooLarge(declared, o.maxBytes);
    }

    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const out = createWriteStream(tmp);
    let bytes = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          // Servers can omit or lie about Content-Length, so enforce the cap while streaming.
          if (bytes > o.maxBytes) throw tooLarge(bytes, o.maxBytes);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      const meta: Meta = {
        url,
        fetchedAt: Date.now(),
        bytes,
        contentType: res.headers.get('content-type'),
      };
      await rename(tmp, path);
      await writeFile(`${path}.meta.json`, JSON.stringify(meta));
      this.opts.log.info({ url, bytes }, 'downloaded to cache');
      return { path, bytes, fetchedAt: new Date(meta.fetchedAt), contentType: meta.contentType };
    } catch (err) {
      out.destroy();
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

function tooLarge(bytes: number, max: number): InvalidInputError {
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  return new InvalidInputError(
    `The file is too large to download (${mb(bytes)}+; limit ${mb(max)}).`,
    {
      hint: 'Pick a smaller resource (e.g. a filtered or annual extract), or ask the user to raise PORTER_MAX_DOWNLOAD_MB.',
    },
  );
}
