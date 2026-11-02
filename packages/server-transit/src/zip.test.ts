import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeZip } from './testing/zip-writer.js';
import { extractFiles, listEntries } from './zip.js';

function setup(zip: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'porter-zip-'));
  const path = join(dir, 'feed.zip');
  writeFileSync(path, zip);
  const out = join(dir, 'out');
  return { path, out, dir };
}

describe('zip reader', () => {
  it('extracts stored and deflated entries, including ones in a subfolder', async () => {
    const { path, dir } = setup(
      makeZip(
        [
          { name: 'stops.txt', data: 'stop_id\n1\n', deflate: false },
          { name: 'google_transit/routes.txt', data: 'route_id\nA\n'.repeat(100) },
          { name: 'empty.txt', data: '' },
        ],
        'a trailing archive comment',
      ),
    );
    expect((await listEntries(path)).map((e) => e.name)).toHaveLength(3);
    const found = await extractFiles(
      path,
      ['stops.txt', 'routes.txt', 'empty.txt', 'nope.txt'],
      dir,
      1e6,
    );
    expect(found).toEqual(['stops.txt', 'routes.txt', 'empty.txt']);
    expect(readFileSync(join(dir, 'stops.txt'), 'utf8')).toBe('stop_id\n1\n');
    expect(readFileSync(join(dir, 'routes.txt'), 'utf8')).toBe('route_id\nA\n'.repeat(100));
    expect(readFileSync(join(dir, 'empty.txt'), 'utf8')).toBe('');
  });

  it('never writes outside the output dir (zip slip)', async () => {
    const { path, dir } = setup(makeZip([{ name: '../../evil/stops.txt', data: 'x' }]));
    await extractFiles(path, ['stops.txt'], dir, 1e6);
    // Written as <dir>/stops.txt, whatever path the archive claimed.
    expect(readdirSync(dir).sort()).toEqual(['feed.zip', 'stops.txt']);
    expect(existsSync(join(dir, '..', '..', 'evil'))).toBe(false);
  });

  it('stops a zip bomb at the byte budget, whatever the header claims', async () => {
    // 50 MB of zeros compresses to ~50 KB.
    const { path, dir } = setup(makeZip([{ name: 'stop_times.txt', data: Buffer.alloc(50e6) }]));
    await expect(extractFiles(path, ['stop_times.txt'], dir, 1e6)).rejects.toThrow(
      /larger than the configured limit/,
    );
  });

  it('detects corruption and rejects non-zips', async () => {
    const corrupt = setup(makeZip([{ name: 'stops.txt', data: 'stop_id\n1\n', badCrc: true }]));
    await expect(extractFiles(corrupt.path, ['stops.txt'], corrupt.dir, 1e6)).rejects.toThrow(
      /checksum mismatch/,
    );
    const html = setup(Buffer.from('<html>Service unavailable</html>'));
    await expect(listEntries(html.path)).rejects.toThrow(/not a valid ZIP/);
  });

  it('ignores macOS resource-fork entries', async () => {
    const { path, dir } = setup(
      makeZip([
        { name: '__MACOSX/._stops.txt', data: 'junk' },
        { name: 'stops.txt', data: 'stop_id\n' },
      ]),
    );
    await extractFiles(path, ['stops.txt'], dir, 1e6);
    expect(readFileSync(join(dir, 'stops.txt'), 'utf8')).toBe('stop_id\n');
  });

  it('reads real feeds (GRT-sized archive written by a real zip tool)', async () => {
    // Cross-check against the system's zip CLI so we aren't only testing our own writer.
    const { execFileSync } = await import('node:child_process');
    const { dir } = setup(Buffer.alloc(0));
    writeFileSync(join(dir, 'agency.txt'), 'agency_name\nX\n');
    execFileSync('zip', ['-q', '-j', join(dir, 'real.zip'), join(dir, 'agency.txt')]);
    const out = mkdtempSync(join(tmpdir(), 'porter-zip-out-'));
    expect(await extractFiles(join(dir, 'real.zip'), ['agency.txt'], out, 1e6)).toEqual([
      'agency.txt',
    ]);
    expect(readFileSync(join(out, 'agency.txt'), 'utf8')).toBe('agency_name\nX\n');
  });
});
