import { describe, expect, it } from 'vitest';
import { csvRecords } from './csv.js';
import { checkProfile, extractFit, kindOf, security, sentences, setAside } from './fit.js';
import { toNotice, type Notice } from './notices.js';
import { ACAN, FURNITURE, INJECTION, IT, RFI, SNOW, tenderCsv } from './testing/fixtures.js';

const one = (fx: Parameters<typeof tenderCsv>[0][number]) =>
  toNotice(csvRecords(tenderCsv([fx]))[0]!) as Notice;

describe('kindOf', () => {
  it('tells bids from qualifications, RFIs and advance award notices', () => {
    expect(kindOf(one(IT))).toBe('bid');
    expect(kindOf(one(FURNITURE))).toBe('qualification');
    expect(kindOf(one(RFI))).toBe('information');
    expect(kindOf(one(ACAN))).toBe('advance_award');
  });
});

describe('extractFit', () => {
  it('reads security, mandatory criteria, questions and submission from the IT notice', () => {
    const f = extractFit(one(IT));
    expect(f.security).toMatchObject({ level: 'secret', organizationClearance: true });
    expect(f.security.evidence[0]).toContain('SECRET clearance');
    expect(f.mandatoryRequirements.join(' ')).toContain('5 years of experience with Azure');
    expect(f.questionsDeadline[0]).toContain('no later than 10 calendar days');
    expect(f.submission[0]).toContain('electronically');
    expect(f.setAside.type).toBe('not_set_aside');
  });

  it('reads a set-aside, no security and a mandatory site visit from the snow notice', () => {
    const f = extractFit(one(SNOW));
    expect(f.security.level).toBe('none');
    expect(f.setAside.type).toBe('set_aside');
    expect(f.setAside.evidence[0]).toContain('government’s Procurement Strategy');
    expect(f.siteVisit).toMatchObject({ mentioned: true, mandatory: true });
  });

  it('treats "may be set aside" boilerplate as possible, not as a set-aside', () => {
    expect(extractFit(one(FURNITURE)).setAside.type).toBe('possible');
  });

  it('says not_stated when the notice is silent', () => {
    expect(extractFit(one(ACAN)).security.level).toBe('not_stated');
  });

  it('quotes no markup, hidden comments or bidi characters back', () => {
    const all = sentences(one(INJECTION).description).join('\n');
    expect(all).not.toMatch(/<!--|\u202E|^## /m);
  });
});

describe('security', () => {
  it.each([
    ['Personnel must hold a valid Top Secret clearance.', 'top_secret'],
    ['Security Level: Reliability and Secret', 'secret'],
    ['Reliability Status is required for all resources.', 'reliability'],
    [
      'There are security requirements associated with this requirement.',
      'required_level_not_stated',
    ],
    ['(No Security Requirements)', 'none'],
    ['Streams 1-5 (with and without security requirements)', 'not_stated'],
  ])('%s → %s', (text, level) => {
    expect(security([text]).level).toBe(level);
  });
});

describe('setAside', () => {
  it.each([
    ['This procurement has been set-aside under the PSIB.', 'set_aside'],
    [
      'CONDITIONAL SET-ASIDE: This procurement has been conditionally set aside under PSIB.',
      'conditional',
    ],
    [
      'However, if two or more Indigenous businesses submit a bid, then the procurement is set aside under PSIB.',
      'conditional',
    ],
    ['Tenders may be set aside for Indigenous businesses in accordance with PSIB.', 'possible'],
    [
      'This procurement is not subject to any set-asides for Indigenous Suppliers.',
      'not_set_aside',
    ],
    ['Nothing about it.', 'none_stated'],
  ])('%s → %s', (text, type) => {
    expect(setAside([text]).type).toBe(type);
  });
});

describe('checkProfile', () => {
  it('blocks on clearance and set-aside, and finds capability keywords', () => {
    const n = one(SNOW);
    const fit = extractFit(n);
    const checks = checkProfile(n, fit, 'open', 7, {
      clearance: 'none',
      indigenousBusiness: false,
      keywords: ['ice', 'landscaping'],
    });
    expect(checks).toEqual([
      { check: 'deadline', result: 'ok', detail: 'Open, with time to respond.' },
      expect.objectContaining({ check: 'security clearance', result: 'ok' }),
      expect.objectContaining({ check: 'set-aside', result: 'blocker' }),
      { check: 'capabilities', result: 'ok', detail: 'Notice mentions: ice.' },
    ]);
  });

  it('flags a closed notice and a clearance gap', () => {
    const n = one(IT);
    const checks = checkProfile(n, extractFit(n), 'closed', null, { clearance: 'reliability' });
    expect(checks.map((c) => [c.check, c.result])).toEqual([
      ['deadline', 'blocker'],
      ['security clearance', 'blocker'],
    ]);
    expect(checks[1]!.detail).toContain('organization clearance');
  });

  it('warns that an advance award notice is not an open competition', () => {
    const n = one(ACAN);
    const checks = checkProfile(n, extractFit(n), 'open', 9, {});
    expect(checks[1]).toMatchObject({ check: 'opportunity type', result: 'warning' });
  });
});
