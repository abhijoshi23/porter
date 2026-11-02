import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { PorterError } from '@abhijoshi23/porter-toolkit';

/**
 * A minimal ZIP reader for GTFS feeds, built on node:zlib (no dependency).
 *
 * Layout of a ZIP file, read back to front:
 *
 *   [local header + data] … [central directory entries] [end of central directory]
 *
 * The end-of-central-directory record (EOCD) sits in the last 22 bytes plus an optional
 * comment of up to 64 KiB, so we scan backwards for its signature. It points at the
 * central directory, which lists every entry with its sizes, CRC and the offset of its
 * local header. The local header repeats the name and has its own "extra" field whose
 * length can differ from the central copy, so the data offset must come from the local
 * header, not the central one.
 *
 * Safety, because the archive comes from the internet:
 * - **No zip slip.** Only entries we ask for by name are extracted, and each is written
 *   to `outDir/<requested name>`. The archive's own path (which could be `../../x`) is
 *   never used as a destination.
 * - **No zip bombs.** Inflated output is counted while streaming and aborted past
 *   `maxBytes`. The declared size isn't trusted.
 * - **Integrity.** The CRC-32 of the output is checked against the directory.
 * - Encrypted entries, multi-disk archives and ZIP64 are rejected (no GTFS feed needs them).
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function bad(msg: string): PorterError {
  return new PorterError(`The feed archive is not a valid ZIP file: ${msg}.`, {
    hint: 'The publisher may be mid-update. Try again later.',
  });
}

/** Reads the central directory. */
export async function listEntries(zipPath: string): Promise<ZipEntry[]> {
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw bad('end of central directory not found');
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw bad('multi-disk archives are not supported');
    }
    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    // 0xFFFF / 0xFFFFFFFF mean "see the ZIP64 record": only needed past 4 GiB or 65 535 files.
    if (count === 0xffff || cenOffset === 0xffffffff) throw bad('ZIP64 is not supported');
    if (cenOffset + cenSize > size) throw bad('central directory out of range');

    const cen = Buffer.alloc(cenSize);
    await fh.read(cen, 0, cenSize, cenOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cenSize || cen.readUInt32LE(p) !== CEN_SIG)
        throw bad('corrupt central directory');
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      entries.push({
        flags: cen.readUInt16LE(p + 8),
        method: cen.readUInt16LE(p + 10),
        crc: cen.readUInt32LE(p + 16),
        compressedSize: cen.readUInt32LE(p + 20),
        size: cen.readUInt32LE(p + 24),
        localOffset: cen.readUInt32LE(p + 42),
        name: cen.toString('utf8', p + 46, p + 46 + nameLen),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Extracts the named files (matched by base name, so `gtfs/stops.txt` counts as
 * `stops.txt`) into `outDir`. Returns the names found. Missing names are simply absent.
 */
export async function extractFiles(
  zipPath: string,
  names: readonly string[],
  outDir: string,
  maxBytes: number,
): Promise<string[]> {
  const entries = await listEntries(zipPath);
  const found: string[] = [];
  let total = 0;
  for (const want of names) {
    const matches = entries.filter((e) => basename(e.name) === want && !e.name.endsWith('/'));
    // Mac-made zips add "__MACOSX/._stops.txt"; its base name keeps the "._", so it never matches.
    if (matches.length === 0) continue;
    if (matches.length > 1) throw bad(`more than one ${want}`);
    const e = matches[0]!;
    if (e.flags & 0x1) throw bad(`${want} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw bad(`${want} uses compression method ${e.method}`);
    total += await extractEntry(zipPath, e, join(outDir, want), maxBytes - total);
    found.push(want);
  }
  return found;
}

async function extractEntry(
  zipPath: string,
  e: ZipEntry,
  dest: string,
  budget: number,
): Promise<number> {
  const fh = await open(zipPath, 'r');
  let dataStart: number;
  try {
    const loc = Buffer.alloc(30);
    await fh.read(loc, 0, 30, e.localOffset);
    if (loc.readUInt32LE(0) !== LOC_SIG) throw bad(`bad local header for ${e.name}`);
    dataStart = e.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  } finally {
    await fh.close();
  }

  let written = 0;
  let crc = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.byteLength;
      if (written > budget) {
        cb(
          new PorterError('The feed is larger than the configured limit once unzipped.', {
            hint: 'Raise PORTER_TRANSIT_MAX_UNZIPPED_MB if this feed is legitimately large.',
          }),
        );
        return;
      }
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const out = createWriteStream(dest);
  if (e.compressedSize === 0) {
    // createReadStream({ end: start - 1 }) would read to EOF, so don't read at all.
    await pipeline(Readable.from([]), out);
  } else {
    const src = createReadStream(zipPath, {
      start: dataStart,
      end: dataStart + e.compressedSize - 1,
    });
    if (e.method === 8) await pipeline(src, createInflateRaw(), guard, out);
    else await pipeline(src, guard, out);
  }
  if (crc >>> 0 !== e.crc >>> 0) throw bad(`checksum mismatch in ${e.name}`);
  return written;
}
