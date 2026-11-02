import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PorterError,
  type DownloadCache,
  type HttpClient,
  type Logger,
} from '@abhijoshi23/porter-toolkit';
import type { Agency, AgencyId } from './agencies.js';
import type { TransitConfig } from './config.js';
import { buildFeedDb, FeedDb, GTFS_FILES } from './feed-db.js';
import { extractFiles } from './zip.js';

interface Pointer {
  file: string;
  sha256: string;
  checkedAt: number;
}

/**
 * Keeps one built schedule database per agency, and keeps it current.
 *
 * Lifecycle of a feed:
 * 1. **Download** the zip through DownloadCache (on disk, refreshed every
 *    PORTER_TRANSIT_REFRESH_HOURS).
 * 2. **Hash** it. If the SHA-256 matches the database we already have, stop: agencies
 *    re-publish identical files often, and rebuilding TTC costs a few seconds of CPU.
 * 3. **Extract and build** into `transit/<agency>-<sha>.duckdb`, then write a small
 *    pointer file naming the current database. A restart reopens the pointer instead of
 *    rebuilding.
 * 4. **Swap** the open database. The old one is closed a minute later, so queries already
 *    running on it can finish.
 *
 * A first use can take a while (TTC is a ~70 MB download). Tool calls wait up to
 * PORTER_TRANSIT_BUILD_WAIT_MS, then return a retryable "still preparing" error while the
 * work continues in the background. That beats a client-side timeout, which would tell
 * the model nothing.
 */
export class FeedStore {
  private readonly open = new Map<AgencyId, { db: FeedDb; checkedAt: number }>();
  private readonly pending = new Map<AgencyId, Promise<FeedDb>>();
  private readonly lastError = new Map<AgencyId, { at: number; error: unknown }>();
  private readonly dir: string;

  constructor(
    private readonly o: {
      config: TransitConfig;
      http: HttpClient;
      downloads: DownloadCache;
      log: Logger;
      now?: () => number;
    },
  ) {
    this.dir = join(o.config.PORTER_CACHE_DIR, 'transit');
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get refreshMs(): number {
    return this.o.config.PORTER_TRANSIT_REFRESH_HOURS * 3600_000;
  }

  /** What list_agencies reports, without triggering a download. */
  status(id: AgencyId): {
    state: 'ready' | 'preparing' | 'not_loaded' | 'failed';
    db?: FeedDb;
    error?: string;
  } {
    const cur = this.open.get(id);
    if (cur) return { state: 'ready', db: cur.db };
    if (this.pending.has(id)) return { state: 'preparing' };
    const err = this.lastError.get(id);
    if (err) return { state: 'failed', error: String((err.error as Error)?.message ?? err.error) };
    return { state: 'not_loaded' };
  }

  /** The agency's schedule database, downloading and building it on first use. */
  async get(agency: Agency): Promise<FeedDb> {
    const cur = this.open.get(agency.id);
    if (cur) {
      if (this.now() - cur.checkedAt > this.refreshMs && !this.pending.has(agency.id)) {
        // Serve the current feed now; refresh behind the scenes.
        void this.load(agency).catch(() => undefined);
      }
      return cur.db;
    }

    const work = this.load(agency);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.o.config.PORTER_TRANSIT_BUILD_WAIT_MS);
    });
    try {
      const r = await Promise.race([work, timeout]);
      if (r === 'timeout') {
        // Keep the background work from becoming an unhandled rejection.
        work.catch(() => undefined);
        throw new PorterError(
          `The ${agency.name} schedule is still being downloaded and prepared for first use.`,
          {
            hint: 'This happens once per feed version and takes up to a minute or two for large feeds such as TTC. Tell the user, then try the same call again shortly.',
            retryable: true,
          },
        );
      }
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Single-flight wrapper around refresh(). */
  private load(agency: Agency): Promise<FeedDb> {
    const inflight = this.pending.get(agency.id);
    if (inflight) return inflight;
    const p = this.refresh(agency)
      .then((db) => {
        this.lastError.delete(agency.id);
        return db;
      })
      .catch((error: unknown) => {
        this.lastError.set(agency.id, { at: this.now(), error });
        this.o.log.warn({ agency: agency.id, err: String(error) }, 'feed load failed');
        throw error;
      })
      .finally(() => this.pending.delete(agency.id));
    this.pending.set(agency.id, p);
    return p;
  }

  private async refresh(agency: Agency): Promise<FeedDb> {
    await mkdir(this.dir, { recursive: true });
    const pointerPath = join(this.dir, `${agency.id}.json`);
    const pointer = await readPointer(pointerPath);

    // Fast path on restart: a database from a recent check is reused without touching the network.
    if (!this.open.has(agency.id) && pointer && this.now() - pointer.checkedAt <= this.refreshMs) {
      try {
        const db = await FeedDb.open(join(this.dir, pointer.file));
        this.open.set(agency.id, { db, checkedAt: pointer.checkedAt });
        return db;
      } catch (err) {
        this.o.log.warn(
          { agency: agency.id, err: String(err) },
          'cached feed unreadable; rebuilding',
        );
      }
    }

    const url =
      typeof agency.staticUrl === 'string' ? agency.staticUrl : await agency.staticUrl(this.o.http);
    const zip = await this.o.downloads.get(url, {
      // Reaching this point with a pointer means we've decided to re-check upstream, so a
      // cached zip must not answer for it. With no pointer (first run, or the database was
      // deleted), a recently downloaded zip is fine to rebuild from.
      ttlMs: pointer ? 0 : this.refreshMs,
      maxBytes: this.o.config.PORTER_TRANSIT_MAX_DOWNLOAD_MB * 1_048_576,
      ext: '.zip',
      timeoutMs: 300_000,
    });
    const sha256 = await hashFile(zip.path);
    const checkedAt = this.now();

    if (pointer?.sha256 === sha256) {
      const cur = this.open.get(agency.id);
      if (cur) {
        cur.checkedAt = checkedAt;
        await writePointer(pointerPath, { ...pointer, checkedAt });
        return cur.db;
      }
      try {
        const db = await FeedDb.open(join(this.dir, pointer.file));
        this.open.set(agency.id, { db, checkedAt });
        await writePointer(pointerPath, { ...pointer, checkedAt });
        return db;
      } catch {
        // Fall through and rebuild.
      }
    }

    const file = `${agency.id}-${sha256.slice(0, 16)}.duckdb`;
    const work = await mkdtemp(join(this.dir, `${agency.id}-src-`));
    const started = this.now();
    try {
      const found = await extractFiles(
        zip.path,
        GTFS_FILES,
        work,
        this.o.config.PORTER_TRANSIT_MAX_UNZIPPED_MB * 1_048_576,
      );
      this.o.log.info({ agency: agency.id, files: found.length }, 'feed extracted');
      await buildFeedDb(work, join(this.dir, file), { sourceUrl: url, sha256 });
    } catch (err) {
      // Don't keep a bad download (e.g. a maintenance page served as 200) for a whole TTL.
      await this.o.downloads.invalidate(url, '.zip');
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    const db = await FeedDb.open(join(this.dir, file));
    this.o.log.info(
      { agency: agency.id, ms: this.now() - started, version: db.meta.version },
      'feed built',
    );

    const old = this.open.get(agency.id);
    this.open.set(agency.id, { db, checkedAt });
    await writePointer(pointerPath, { file, sha256, checkedAt });
    if (old) setTimeout(() => old.db.close(), 60_000).unref();
    await this.removeOld(agency.id, file);
    return db;
  }

  /** Deletes superseded databases for an agency. */
  private async removeOld(id: AgencyId, keep: string): Promise<void> {
    for (const f of await readdir(this.dir)) {
      if (f.startsWith(`${id}-`) && f.endsWith('.duckdb') && f !== keep) {
        await rm(join(this.dir, f), { force: true }).catch(() => undefined);
      }
    }
  }

  close(): void {
    for (const { db } of this.open.values()) db.close();
    this.open.clear();
  }
}

async function readPointer(path: string): Promise<Pointer | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Pointer;
  } catch {
    return null;
  }
}

/** Temp file + rename, so a crash mid-write never leaves a truncated pointer. */
async function writePointer(path: string, p: Pointer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(p));
  await rename(tmp, path);
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
