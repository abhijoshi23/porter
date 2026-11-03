import { externalText } from '@abhijoshi23/porter-toolkit';
import type { Notice } from './notices.js';

/**
 * What a bidder needs to decide "should we bid?", pulled from the notice text with plain
 * rules. No model is involved: every field comes with the sentences it was read from
 * (`evidence`), so the calling model, and the person, can check it. Rules miss things,
 * and the notice is a summary of the solicitation documents, which say more. Results say
 * so instead of implying completeness.
 */

export type Kind = 'bid' | 'qualification' | 'information' | 'advance_award';

export const KIND_NOTES: Record<Kind, string> = {
  bid: 'A competitive solicitation: submit a bid or proposal by the closing time.',
  qualification:
    'Qualifies suppliers for a standing offer, supply arrangement or source list. Work comes later through call-ups or invited competitions.',
  information:
    'A request for information or interest. It does not award a contract; responding can shape a later solicitation.',
  advance_award:
    'Advance Contract Award Notice: the buyer intends to award to a named supplier. Others can only challenge by showing, before closing, that they meet the stated requirements.',
};

export function kindOf(n: Notice): Kind {
  const t = `${n.noticeType} ${n.method}`.toLowerCase();
  if (t.includes('advance contract award')) return 'advance_award';
  if (t.includes('request for information') || t.includes('letter of interest'))
    return 'information';
  if (
    /request for (supply arrangement|standing offer)|invitation to qualify|qualification/.test(t) ||
    /\bsource list\b/i.test(n.title)
  )
    return 'qualification';
  return 'bid';
}

/**
 * Notice text → sentences. Lines first (publishers use line breaks as structure), then
 * sentence ends. Each piece goes through externalText, so markup, control and bidi
 * characters and fake headings are gone before anything is quoted back.
 */
export function sentences(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.slice(0, 40_000).split(/\r?\n|\t/)) {
    const clean = externalText(line, 4000);
    if (!clean) continue;
    for (const s of clean.split(/(?<=[.!?])\s+(?=[A-Z0-9("“•-])/)) {
      const t = s.trim();
      if (t.length > 2) out.push(t.length > 400 ? `${t.slice(0, 399)}…` : t);
    }
  }
  return out;
}

function find(ss: string[], re: RegExp, max: number): string[] {
  const out: string[] = [];
  for (const s of ss) {
    if (re.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export type Clearance = 'none' | 'reliability' | 'secret' | 'top_secret';
const CLEARANCE_RANK: Record<Clearance, number> = {
  none: 0,
  reliability: 1,
  secret: 2,
  top_secret: 3,
};

export interface Security {
  /**
   * Highest personnel level mentioned. `required_level_not_stated`: the notice says there
   * are security requirements but not which. `not_stated`: the notice doesn't say at all.
   */
  level: Clearance | 'required_level_not_stated' | 'not_stated';
  /** The company itself needs a Designated Organization Screening or Facility Security Clearance. */
  organizationClearance: boolean;
  controlledGoods: boolean;
  evidence: string[];
}

const SECURITY_RE =
  /\b(security (clearance|requirement|screening|level)s?|reliability status|top secret|secret|designated organi[sz]ation screening|facility security clearance|FSC|DOS|controlled goods)\b/i;

export function security(ss: string[]): Security {
  const evidence = find(ss, SECURITY_RE, 4);
  // "Streams with and without security requirements" (TBIPS, ProServices) names both; it
  // says nothing about this notice's level, so it can't make the level "none".
  const all = evidence.filter((e) => !/\bwith and without security\b/i.test(e)).join(' ');
  let level: Security['level'] = 'not_stated';
  if (/\btop secret\b/i.test(all)) level = 'top_secret';
  else if (/\bsecret\b/i.test(all)) level = 'secret';
  else if (/\breliability\b/i.test(all)) level = 'reliability';
  else if (
    /\b(no|not include any|does not (include|contain|have)|without) (security|any security)? ?(requirements?|clearances?)\b/i.test(
      all,
    )
  )
    level = 'none';
  else if (
    /\bthere (are|is an?) security requirements?\b|\bsecurity requirements? (apply|applies|associated)\b/i.test(
      all,
    )
  )
    level = 'required_level_not_stated';
  return {
    level,
    // The acronyms only in capitals: "dos" and "fsc" are words in French text.
    organizationClearance:
      /\b(designated organi[sz]ation screening|facility security clearance)\b/i.test(all) ||
      /\b(FSC|DOS)\b/.test(all),
    controlledGoods: /\bcontrolled goods\b/i.test(all),
    evidence,
  };
}

/**
 * Indigenous set-asides (PSIB). Notices say this in many ways, and most mentions are
 * boilerplate about what *may* happen, so the wording decides:
 * - `set_aside`: "this procurement is set aside under PSIB": only Indigenous businesses.
 * - `conditional`: set aside only if enough Indigenous businesses bid.
 * - `possible`: "tenders may be set aside…" (typical of source lists and standing offers).
 * - `not_set_aside`: "not subject to any set-asides".
 */
export type SetAside = 'set_aside' | 'conditional' | 'possible' | 'not_set_aside' | 'none_stated';

const SET_ASIDE_RE =
  /\b(set[- ]asides?|procurement strategy for (indigenous|aboriginal) business(es)?|PSIB|PSAB|reserved for indigenous)\b/i;

export function setAside(ss: string[]): { type: SetAside; evidence: string[] } {
  const evidence = find(ss, SET_ASIDE_RE, 3);
  const all = evidence.join('\n');
  let type: SetAside = 'none_stated';
  if (/\bnot (be )?subject to (any )?set[- ]asides?|\bnot (be )?set[- ]aside\b/i.test(all)) {
    type = 'not_set_aside';
  } else if (
    /\bconditional\w* set[- ]aside|\bif (two|2) or more indigenous|\bset[- ]aside\b.{0,120}\bif (canada receives )?(two|2)\b/i.test(
      all,
    )
  ) {
    type = 'conditional';
  } else if (
    /\b(is|has been|will be) set[- ]aside\b|\bhas set aside this\b|\bsolicited amongst the PSIB\b|\bsubject to the set[- ]aside\b|^set[- ]aside for indigenous business/im.test(
      all,
    ) &&
    !/\bmay be (set[- ]aside|reserved|designated)\b/i.test(all)
  ) {
    type = 'set_aside';
  } else if (evidence.length) {
    type = 'possible';
  }
  return { type, evidence };
}

export interface Fit {
  kind: Kind;
  kindNote: string;
  security: Security;
  setAside: { type: SetAside; evidence: string[] };
  /** Land-claims areas (Comprehensive Land Claims Agreements) add obligations. */
  landClaims: string[];
  mandatoryRequirements: string[];
  siteVisit: { mentioned: boolean; mandatory: boolean; evidence: string[] };
  questionsDeadline: string[];
  submission: string[];
}

export function extractFit(n: Notice): Fit {
  const ss = sentences(n.description);
  const visit = find(
    ss,
    /\b(site visits?|site meetings?|bidders?['’]? conference|site tours?|pre-bid)\b/i,
    3,
  );
  return {
    kind: kindOf(n),
    kindNote: KIND_NOTES[kindOf(n)],
    security: security(ss),
    setAside: setAside(ss),
    landClaims: find(
      ss,
      /\b(comprehensive land claims? agreements?|CLCA|modern treat(y|ies))\b/i,
      2,
    ),
    mandatoryRequirements: [
      ...find(ss, /\bmandatory\b/i, 8),
      ...find(ss, /\b(must|shall) (have|hold|possess|provide|demonstrate|be)\b/i, 8),
    ]
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, 8),
    siteVisit: {
      mentioned: visit.length > 0,
      mandatory: visit.some(
        (s) => /\bmandatory\b/i.test(s) && !/\b(not|non)[- ]mandatory\b/i.test(s),
      ),
      evidence: visit,
    },
    questionsDeadline: find(
      ss,
      /\b(enquir\w*|inquir\w*|questions?)\b.{0,100}\b(no later than|at least|before|prior to|deadline)\b/i,
      2,
    ),
    submission: find(
      ss,
      /\b(bids?|proposals?|offers?|submissions?|responses?)\b.{0,80}\b(electronic\w*|epost|e-mail|email|MERX|SAP Business Network|Ariba|in person|by hand|fax)\b/i,
      2,
    ),
  };
}

export type CheckResult = 'ok' | 'warning' | 'blocker' | 'unknown' | 'info';

export interface Profile {
  clearance?: Clearance | undefined;
  indigenousBusiness?: boolean | undefined;
  keywords?: string[] | undefined;
}

export interface Check {
  check: string;
  result: CheckResult;
  detail: string;
}

/** Compares a supplier profile with the extracted fit. Only says "ok" when the notice supports it. */
export function checkProfile(
  n: Notice,
  fit: Fit,
  status: 'open' | 'closed' | 'cancelled',
  daysLeft: number | null,
  p: Profile,
): Check[] {
  const checks: Check[] = [];
  if (status !== 'open') {
    checks.push({ check: 'deadline', result: 'blocker', detail: `The notice is ${status}.` });
  } else if (daysLeft !== null && daysLeft < 5) {
    checks.push({
      check: 'deadline',
      result: 'warning',
      detail: `Closes in ${daysLeft < 1 ? 'under a day' : `${Math.floor(daysLeft)} day(s)`}.`,
    });
  } else {
    checks.push({ check: 'deadline', result: 'ok', detail: 'Open, with time to respond.' });
  }

  if (fit.kind !== 'bid') {
    checks.push({
      check: 'opportunity type',
      result: fit.kind === 'advance_award' ? 'warning' : 'info',
      detail: KIND_NOTES[fit.kind],
    });
  }

  if (p.clearance) {
    const need = fit.security.level;
    if (need === 'not_stated' || need === 'required_level_not_stated') {
      checks.push({
        check: 'security clearance',
        result: 'unknown',
        detail:
          need === 'not_stated'
            ? 'The notice does not mention security; check the solicitation documents.'
            : 'The notice says there are security requirements but not the level; check the solicitation documents.',
      });
    } else {
      const ok = CLEARANCE_RANK[p.clearance] >= CLEARANCE_RANK[need];
      checks.push({
        check: 'security clearance',
        result: ok ? 'ok' : 'blocker',
        detail: `Notice mentions ${need.replace('_', ' ')}; you hold ${p.clearance.replace('_', ' ')}.${
          fit.security.organizationClearance
            ? ' The company itself also needs an organization clearance (DOS/FSC).'
            : ''
        }`,
      });
    }
  }

  const sa = fit.setAside.type;
  if (sa === 'set_aside' || sa === 'conditional') {
    const indigenous = p.indigenousBusiness;
    checks.push({
      check: 'set-aside',
      result:
        indigenous === undefined
          ? 'unknown'
          : indigenous
            ? 'ok'
            : sa === 'set_aside'
              ? 'blocker'
              : 'warning',
      detail:
        sa === 'set_aside'
          ? 'Set aside for Indigenous businesses (PSIB): only they can bid.'
          : 'Conditionally set aside for Indigenous businesses: if enough of them bid, others are excluded.',
    });
  }

  if (p.keywords?.length) {
    const hay =
      `${n.title} ${n.plain} ${n.unspsc.map((c) => c.description).join(' ')}`.toLowerCase();
    const hit = p.keywords.filter((k) => hay.includes(k.toLowerCase()));
    checks.push({
      check: 'capabilities',
      result: hit.length ? 'ok' : 'warning',
      detail: hit.length
        ? `Notice mentions: ${hit.join(', ')}.`
        : 'None of your keywords appear in the notice text.',
    });
  }
  return checks;
}
