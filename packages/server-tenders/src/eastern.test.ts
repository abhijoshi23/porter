import { describe, expect, it } from 'vitest';
import { describeEastern, easternToEpoch, formatEastern } from './eastern.js';

describe('easternToEpoch', () => {
  it('reads summer times as EDT (UTC−4), not the dictionary’s fixed UTC−5', () => {
    expect(easternToEpoch('2026-07-14T14:00:00')).toBe(Date.parse('2026-07-14T18:00:00Z'));
  });

  it('reads winter times as EST (UTC−5)', () => {
    expect(easternToEpoch('2026-01-20T14:00:00')).toBe(Date.parse('2026-01-20T19:00:00Z'));
  });

  it('takes the first instant in the fall-back overlap', () => {
    expect(easternToEpoch('2026-11-01T01:30:00')).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });

  it('reads a bare date as the end of that day', () => {
    expect(formatEastern(easternToEpoch('2026-11-20')!)).toBe('2026-11-20T23:59:59-05:00');
  });

  it('rejects junk', () => {
    expect(easternToEpoch('')).toBeNull();
    expect(easternToEpoch('2026-13-01')).toBeNull();
    expect(easternToEpoch('soon')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats with the right offset on each side of DST', () => {
    expect(formatEastern(Date.parse('2026-07-14T18:00:00Z'))).toBe('2026-07-14T14:00:00-04:00');
    expect(describeEastern(Date.parse('2026-11-20T19:00:00Z'))).toBe('Fri 2026-11-20 14:00 ET');
  });
});
