import { readFile } from 'node:fs/promises';
import { PorterError, type DownloadCache, type Logger } from '@abhijoshi23/porter-toolkit';
import type { TendersConfig } from './config.js';
import { csvRecords } from './csv.js';
import { easternDate } from './eastern.js';
import { REQUIRED_COLUMNS, toNotice, type Notice } from './notices.js';
import { SearchIndex } from './search.js';

const BASE = 'https://canadabuys.canada.ca/opendata/pub';
export const OPEN_URL = `${BASE}/openTenderNotice-ouvertAvisAppelOffres.csv`;
export const NEW_URL = `${BASE}/newTenderNotice-nouvelAvisAppelOffres.csv`;
export const DATASET_URL =
  'https://open.canada.ca/data/en/dataset/6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2';
export const LICENCE = {
  name: 'Open Government Licence – Canada',
  url: 'https://open.canada.ca/en/open-government-licence-canada',
};

/**
 * Fiscal-year files of all notices published that year (closed, cancelled and open).
 * The federal fiscal year starts April 1, so on 2026-11-03 the current one is 2026-2027.
 */
export function historyUrls(nowMs: number, years: number): string[] {
  const [y, m] = easternDate(nowMs).split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return Array.from(
    { length: years },
    (_, i) => `${BASE}/${start - i}-${start - i + 1}-TenderNotice-AvisAppelOffres.csv`,
  );
}

export interface Snapshot {
  notices: Notice[];
  byId: Map<string, Notice>;
  bySolicitation: Map<string, Notice[]>;
  index: SearchIndex;
  /** When the oldest of the files behind this snapshot was downloaded. */
  fetchedAt: Date;
  files: string[];
  /** Download times of the files behind it: unchanged stamp, nothing to re-parse. */
  stamp: string;
}

function snapshot(notices: Notice[], fetchedAt: Date, files: string[], stamp: string): Snapshot {
  const byId = new Map<string, Notice>();
  const bySolicitation = new Map<string, Notice[]>();
  for (const n of notices) {
    byId.set(n.id.toLowerCase(), n);
    if (n.solicitationNumber) {
      const k = n.solicitationNumber.toLowerCase();
      bySolicitation.set(k, [...(bySolicitation.get(k) ?? []), n]);
    }
  }
  return {
    notices,
    byId,
    bySolicitation,
    index: new SearchIndex(notices),
    fetchedAt,
    files,
    stamp,
  };
}

/** Keeps the later amendment when the same notice appears in two files. */
function merge(lists: Notice[][]): Notice[] {
  const out = new Map<string, Notice>();
  for (const list of lists) {
    for (const n of list) {
      const prev = out.get(n.id);
      if (!prev || n.amendment > prev.amendment) out.set(n.id, n);
    }
  }
  return [...out.values()];
}

/**
 * Loads CanadaBuys CSVs into memory. Two snapshots:
 * - **open**: open notices plus today's new ones, refreshed every few hours.
 * - **history**: the fiscal-year files, loaded only when someone asks about a closed
 *   notice or searches closed ones, then refreshed daily.
 *
 * Refreshes are single-flight. If a refresh fails while an older snapshot exists, the
 * older one keeps serving (with its real `fetchedAt`), and the next call retries.
 */
export class TenderStore {
  private openSnap: Snapshot | null = null;
  private historySnap: Snapshot | null = null;
  private openLoad: Promise<Snapshot> | null = null;
  private historyLoad: Promise<Snapshot> | null = null;
  private openCheckedAt = 0;
  private historyCheckedAt = 0;

  constructor(
    private readonly o: {
      config: TendersConfig;
      downloads: DownloadCache;
      log: Logger;
      now: () => number;
    },
  ) {}

  get historyEnabled(): boolean {
    return this.o.config.PORTER_TENDERS_HISTORY_YEARS > 0;
  }

  async open(): Promise<Snapshot> {
    const ttl = this.o.config.PORTER_TENDERS_REFRESH_HOURS * 3600_000;
    if (this.openSnap && this.o.now() - this.openCheckedAt < ttl) return this.openSnap;
    this.openLoad ??= this.refresh([OPEN_URL, NEW_URL], ttl, this.openSnap)
      .then((s) => (this.openSnap = s))
      .finally(() => {
        this.openCheckedAt = this.o.now();
        this.openLoad = null;
      });
    return this.openLoad;
  }

  async history(): Promise<Snapshot | null> {
    if (!this.historyEnabled) return null;
    const ttl = 24 * 3600_000;
    if (this.historySnap && this.o.now() - this.historyCheckedAt < ttl) return this.historySnap;
    const urls = historyUrls(this.o.now(), this.o.config.PORTER_TENDERS_HISTORY_YEARS);
    this.historyLoad ??= this.refresh(urls, ttl, this.historySnap)
      .then((s) => (this.historySnap = s))
      .finally(() => {
        this.historyCheckedAt = this.o.now();
        this.historyLoad = null;
      });
    return this.historyLoad;
  }

  private async refresh(
    urls: string[],
    ttlMs: number,
    previous: Snapshot | null,
  ): Promise<Snapshot> {
    try {
      const files = await Promise.all(
        urls.map((url) =>
          this.o.downloads.get(url, {
            ttlMs,
            maxBytes: this.o.config.PORTER_TENDERS_MAX_DOWNLOAD_MB * 1_048_576,
            ext: '.csv',
          }),
        ),
      );
      const stamp = files.map((f) => f.fetchedAt.getTime()).join(',');
      if (previous?.stamp === stamp) return previous;
      const lists = await Promise.all(files.map((f, i) => this.parse(urls[i]!, f.path)));
      const fetchedAt = new Date(Math.min(...files.map((f) => f.fetchedAt.getTime())));
      return snapshot(merge(lists), fetchedAt, urls, stamp);
    } catch (err) {
      if (!previous) throw err;
      this.o.log.warn({ err, urls }, 'tender refresh failed; serving the previous snapshot');
      return previous;
    }
  }

  private async parse(url: string, path: string): Promise<Notice[]> {
    const records = csvRecords(await readFile(path, 'utf8'));
    const header = records[0] ? Object.keys(records[0]) : [];
    const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    // The new-notices file is legitimately empty some mornings; the others never are.
    if (missing.length && !(url === NEW_URL && records.length === 0)) {
      await this.o.downloads.invalidate(url, '.csv');
      throw new PorterError('CanadaBuys returned a file that is not the tender-notice CSV.', {
        hint: 'The site may be mid-update or showing an error page. Try again in a few minutes.',
        retryable: true,
      });
    }
    const notices = records.map(toNotice).filter((n): n is Notice => !!n);
    this.o.log.info({ url, notices: notices.length }, 'tender file loaded');
    return notices;
  }
}
