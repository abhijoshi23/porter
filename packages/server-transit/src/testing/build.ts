import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFeedDb, FeedDb, GTFS_FILES } from '../feed-db.js';
import { extractFiles } from '../zip.js';
import { feedZip } from './fixture-feed.js';

/** Zips a fixture, extracts and builds it exactly as production does, and opens it. */
export async function buildFixture(files: Record<string, string>, folder = ''): Promise<FeedDb> {
  const dir = mkdtempSync(join(tmpdir(), 'porter-transit-'));
  writeFileSync(join(dir, 'feed.zip'), feedZip(files, folder));
  await extractFiles(join(dir, 'feed.zip'), GTFS_FILES, dir, 1e8);
  await buildFeedDb(dir, join(dir, 'feed.duckdb'), { sourceUrl: 'test', sha256: 'test' });
  return FeedDb.open(join(dir, 'feed.duckdb'));
}
