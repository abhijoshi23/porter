import { describe, expect, it } from 'vitest';
import { isNational, regionMatcher } from './regions.js';

describe('regionMatcher', () => {
  it('reads Ontario as including the NCR and Ontario cities', () => {
    const on = regionMatcher('ON');
    expect(on.label).toBe('ontario');
    expect(on.local(['Ontario (except NCR)'])).toBe(true);
    expect(on.local(['National Capital Region (NCR)'])).toBe(true);
    expect(on.local(['Petawawa'])).toBe(true);
    expect(on.local(['Quebec (except NCR)'])).toBe(false);
  });

  it('reads Ottawa as the NCR, and accents don’t matter', () => {
    expect(regionMatcher('Ottawa').local(['Gatineau'])).toBe(true);
    expect(regionMatcher('Québec').local(['Montréal'])).toBe(true);
  });

  it('falls back to substring matching for other places', () => {
    expect(regionMatcher('Halifax').local(['Halifax'])).toBe(true);
    expect(regionMatcher('Halifax').local(['Nova Scotia'])).toBe(false);
  });

  it('knows Canada-wide delivery', () => {
    expect(isNational(['Canada'])).toBe(true);
    expect(isNational(['World'])).toBe(false);
  });
});
