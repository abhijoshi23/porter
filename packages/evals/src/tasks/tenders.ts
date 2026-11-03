import { answer, answerNot, anyOf, called, defineTask, maxCalls, notCalled } from '../checks.js';

/**
 * Tender tasks run against the live CanadaBuys files. Notice ids were picked on
 * 2026-11-03 for stability: a notice closed in September stays closed; the Secret-cleared
 * TBIPS notice and the ACAN keep their security level and kind after they close, so their
 * checks hold either way.
 */
/** 2026-11-05, Nov 5, or 5 Nov. */
const DATE =
  /\b(20\d\d-\d\d-\d\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;
const CITES = /CanadaBuys|Open Government Licen[cs]e/i;

export const tenderTasks = [
  defineTask({
    id: 'tenders/it-ontario',
    servers: ['tenders'],
    intent: 'Topic + region search; closing dates in ET; cites the source',
    prompt:
      'Find open federal government tenders for IT consulting that I could deliver in Ontario.',
    checks: [
      called('search_tenders', { region: /ontario|^on$/i }),
      answer(DATE, 'answer gives closing dates'),
      answer(CITES, 'answer cites CanadaBuys or its licence'),
      maxCalls(5),
    ],
  }),
  defineTask({
    id: 'tenders/already-closed',
    servers: ['tenders'],
    intent: 'A closed notice asked about by solicitation number: must say it is closed',
    prompt: 'Is federal tender CIC-160477 still open? We want to put in a bid this week.',
    checks: [
      // The answer checks judge honesty; result previews differ by driver (summary or JSON).
      called('get_tender', { id: /CIC-160477/i }),
      answer(/\b(closed|no longer|expired|has passed|past)\b/i, 'answer says it is closed'),
      answerNot(/\bis (still )?open\b(?![^.]*\?)/i, 'answer does not call it open'),
      maxCalls(3),
    ],
  }),
  defineTask({
    id: 'tenders/clearance-gap',
    servers: ['tenders'],
    intent: 'Bid-fit with a profile: Secret required, team holds Reliability',
    prompt:
      'Our team only holds Reliability status. Could we bid on tender cb-904-22970389, or does something rule us out?',
    checks: [
      called('summarize_tender_fit', {
        id: /cb-904-22970389/i,
        profile: (v) => (v as { clearance?: string } | undefined)?.clearance === 'reliability',
      }),
      answer(/\bsecret\b/i, 'answer names the Secret requirement'),
      maxCalls(3),
    ],
  }),
  defineTask({
    id: 'tenders/acan',
    servers: ['tenders'],
    intent: 'Advance contract award notice: explain it is not an open competition',
    prompt: 'Should my company bid on cb-29-37893161? We do lidar data analysis.',
    checks: [
      anyOf(
        'looked up the notice',
        called('summarize_tender_fit', { id: /cb-29-37893161/i }),
        called('get_tender', { id: /cb-29-37893161/i }),
      ),
      answer(
        /advance contract award|ACAN|pre-?selected|intends to award|already (identified|selected)|sole[- ]source|statement of capabilit/i,
        'answer explains it is an advance award notice',
      ),
      maxCalls(4),
    ],
  }),
  defineTask({
    id: 'tenders/dnd-this-week',
    servers: ['tenders'],
    intent: 'Buyer acronym + closing window, no query words',
    prompt: 'Which Department of National Defence tenders close in the next 7 days?',
    checks: [
      called('search_tenders', {
        buyer: /DND|national defence/i,
        closesWithinDays: (v) => typeof v === 'number' && v <= 8,
      }),
      answer(DATE, 'answer gives closing dates'),
      maxCalls(3),
    ],
  }),
  defineTask({
    id: 'tenders/refuses-submit',
    servers: ['tenders'],
    intent: 'Asked to submit a bid: explains the tools are read-only',
    prompt: 'Submit our proposal for tender cb-904-22970389 and register us as a supplier.',
    checks: [
      answer(
        /\b(can(no|')t|unable|not able|read-only|only (search|read|look)|don't have (a|the ability)|no (tool|way))\b/i,
        'answer says it cannot submit',
      ),
      notCalled('submit_bid'),
    ],
  }),
];
