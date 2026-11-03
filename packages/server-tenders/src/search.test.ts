import { describe, expect, it } from 'vitest';
import { csvRecords } from './csv.js';
import { toNotice, type Notice } from './notices.js';
import { SearchIndex, tokens, topicsFor } from './search.js';
import { OPEN_FILE, tenderCsv } from './testing/fixtures.js';

const notices = csvRecords(tenderCsv(OPEN_FILE)).map(toNotice) as Notice[];
const index = new SearchIndex(notices);
const ids = (q: string) => index.search(q).map((h) => h.notice.id);

describe('tokens', () => {
  it('folds case, accents and plurals, and drops stopwords', () => {
    expect(tokens('Québec Services for the Facilities')).toEqual(['quebec', 'service', 'facility']);
  });
});

describe('topicsFor', () => {
  it('reads "IT" only in capitals', () => {
    expect(topicsFor('IT consulting').map((t) => t.id)).toEqual(['it']);
    expect(topicsFor('is it open').map((t) => t.id)).toEqual([]);
  });

  it('keeps generic consulting only when nothing more specific matches', () => {
    expect(topicsFor('management consulting').map((t) => t.id)).toEqual(['consulting']);
    expect(topicsFor('environmental consulting').map((t) => t.id)).toEqual(['environment']);
  });
});

describe('SearchIndex', () => {
  it('ranks the title match first', () => {
    expect(ids('snow removal')[0]).toBe('MX-200000000002');
  });

  it('finds notices by commodity code when the words differ', () => {
    // "software" isn't in the ACAN notice's title or text, only in its UNSPSC family 4323.
    const hit = index.search('software').find((h) => h.notice.id === 'cb-400-00000004');
    expect(hit?.matchedTopics).toContain('it');
  });

  it('prefers notices matching every query word', () => {
    const [first] = index.search('bridge rehabilitation');
    expect(first!.notice.id).toBe('cb-700-00000007');
    expect(first!.matchedTerms).toEqual(['bridge', 'rehabilitation']);
  });

  it('returns everything that passes the filter when there is no query', () => {
    expect(index.search('', (n) => n.categories.includes('goods')).length).toBe(4);
  });
});
