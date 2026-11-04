import { describe, expect, it } from 'vitest';
import { matchByName, normalizeName } from './books.js';

describe('name matching', () => {
  it('normalizes apostrophes, accents and ampersands', () => {
    expect(normalizeName('Amy’s Bird Sanctuary')).toBe('amys bird sanctuary');
    expect(normalizeName('Café Côté & Fils')).toBe('cafe cote and fils');
  });

  it('ranks exact, then prefix, then all-words matches', () => {
    const list = ['Smith Ltd', 'Smith', 'Jane Smith Consulting', 'Smithers'];
    const got = matchByName(list, 'smith', (s) => [s]);
    expect(got[0]).toBe('Smith');
    expect(got.slice(1, 3).sort()).toEqual(['Smith Ltd', 'Smithers']);
    expect(got).toContain('Jane Smith Consulting');
    expect(matchByName(list, 'jane consult', (s) => [s])).toEqual(['Jane Smith Consulting']);
    expect(matchByName(list, 'nobody', (s) => [s])).toEqual([]);
  });
});
