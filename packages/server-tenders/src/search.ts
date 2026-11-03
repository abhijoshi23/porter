import type { Category, Notice } from './notices.js';

/**
 * Local full-text search over a few thousand notices. The whole corpus is ~5 k documents,
 * so an in-memory BM25 index builds in well under a second and needs no database or
 * native module (which keeps this server a plain-JS `.mcpb` bundle; see decisions log).
 *
 * Two things make it work for how people actually ask:
 * - **Field weights.** A word in the title says more than one in paragraph six.
 * - **Topics.** "IT consulting" rarely appears verbatim; notices are coded with UNSPSC
 *   commodity codes instead (80101507 "Information technology consultation services").
 *   TOPICS maps everyday phrases to code prefixes, and a notice coded under a matched
 *   prefix gets a boost even if its text uses other words.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in into is it its of on or our that the their ' +
    'this to was we will with within any all may can not no other such than these those ' +
    'tender tenders notice notices opportunity opportunities contract contracts canada government federal'
  ).split(' '),
);

/** Lowercase, strip accents, so "Québec" matches "Quebec". */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Light plural folding: "services" → "service", "facilities" → "facility". */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export interface Topic {
  id: string;
  label: string;
  /** Tested against the normalized query. */
  pattern: RegExp;
  /** UNSPSC code prefixes (segment, family or class). */
  unspsc: string[];
  categories?: Category[];
  /** Dropped when a more specific topic also matches ("IT consulting" is IT, not management consulting). */
  generic?: boolean;
}

/** Families verified against descriptions in the CanadaBuys files (2026-11-03). */
export const TOPICS: Topic[] = [
  {
    id: 'it',
    label: 'IT and software',
    // "IT" is matched case-sensitively in topicsFor(), so "is it open" doesn't count.
    pattern:
      /\b(information technology|software|cloud|cyber ?security|computer|informatics|saas|data analytics|devops|network)\b/,
    unspsc: ['4321', '4322', '4323', '8111', '8116', '801015', '8016'],
  },
  {
    id: 'consulting',
    label: 'Management consulting',
    pattern: /\b(consult\w*|advisory|project management)\b/,
    unspsc: ['8010'],
    generic: true,
  },
  {
    id: 'engineering',
    label: 'Engineering and architecture',
    pattern: /\b(engineer\w*|architect\w*)\b/,
    unspsc: ['8110'],
  },
  {
    id: 'construction',
    label: 'Construction',
    pattern: /\b(construction|renovation|contractors?|roofing|paving|hvac|electrical work)\b/,
    unspsc: ['7211', '7212', '7214', '7215'],
    categories: ['construction'],
  },
  {
    id: 'facilities',
    label: 'Building maintenance',
    pattern:
      /\b(facility|building|property) maintenance\b|\bsnow (removal|clearing)\b|\blandscaping\b/,
    unspsc: ['7210'],
  },
  {
    id: 'cleaning',
    label: 'Cleaning',
    pattern: /\b(cleaning|janitorial|custodial)\b/,
    unspsc: ['7611'],
  },
  {
    id: 'waste',
    label: 'Waste and recycling',
    pattern: /\b(waste|recycling|garbage)\b/,
    unspsc: ['7612'],
  },
  {
    id: 'environment',
    label: 'Environmental services',
    pattern: /\b(environment\w*|remediation|contaminat\w*|ecolog\w*)\b/,
    unspsc: ['7710', '7711'],
  },
  {
    id: 'training',
    label: 'Training',
    pattern: /\b(training|courses?|instruction|education)\b/,
    unspsc: ['8610', '8611'],
  },
  {
    id: 'translation',
    label: 'Translation and writing',
    pattern: /\b(translat\w*|interpret\w*|technical writing|editing)\b/,
    unspsc: ['8211'],
  },
  {
    id: 'security-services',
    label: 'Security services and equipment',
    pattern:
      /\b(security guards?|guard services|commissionaires?|alarm monitoring|cctv|surveillance|access control)\b/,
    unspsc: ['9212', '4617'],
  },
  {
    id: 'furniture',
    label: 'Furniture',
    pattern: /\b(furniture|chairs?|desks?|seating|workstations?)\b/,
    unspsc: ['5610', '5611'],
  },
  {
    id: 'vehicles',
    label: 'Vehicles and fleet',
    pattern: /\b(vehicles?|trucks?|fleet|cars?)\b/,
    unspsc: ['2510', '7818'],
  },
  {
    id: 'marine',
    label: 'Marine vessels',
    pattern: /\b(marine|vessels?|boats?|ships?)\b/,
    unspsc: ['2511', '7818'],
  },
  {
    id: 'staffing',
    label: 'Staffing and HR',
    pattern: /\b(staffing|temporary help|recruit\w*|human resources)\b/,
    unspsc: ['8011'],
  },
  {
    id: 'legal',
    label: 'Legal',
    pattern: /\b(legal|lawyers?|arbitration|mediation)\b/,
    unspsc: ['8012'],
  },
  {
    id: 'communications',
    label: 'Marketing, events and engagement',
    pattern: /\b(marketing|communications?|public relations|events?|engagement|focus groups?)\b/,
    unspsc: ['8014', '8017'],
  },
  {
    id: 'health',
    label: 'Health services and medical supplies',
    pattern: /\b(health|medical|nursing|clinical)\b/,
    unspsc: ['8510', '42'],
  },
  {
    id: 'food',
    label: 'Catering and food',
    pattern: /\b(catering|food services?|cafeteria|meals?)\b/,
    unspsc: ['9010'],
  },
  {
    id: 'printing',
    label: 'Printing',
    pattern: /\b(printing|print)\b/,
    unspsc: ['8212'],
  },
  {
    id: 'research',
    label: 'Research, surveys and statistics',
    pattern: /\b(research|surveys?|statistic\w*|economic\w*)\b/,
    unspsc: ['8112', '8113'],
  },
  {
    id: 'real-estate',
    label: 'Real estate and leasing',
    pattern: /\b(lease|leasing|office space|real estate)\b/,
    unspsc: ['8013'],
  },
  {
    id: 'lab',
    label: 'Laboratory equipment',
    pattern: /\b(lab|laboratory)\b/,
    unspsc: ['4110', '4111'],
  },
];

export function topicsFor(query: string): Topic[] {
  const q = normalize(query);
  const all = TOPICS.filter((t) => t.pattern.test(q) || (t.id === 'it' && /\bIT\b/.test(query)));
  return all.some((t) => !t.generic) ? all.filter((t) => !t.generic) : all;
}

function topicMatch(n: Notice, t: Topic): boolean {
  return (
    n.unspsc.some((c) => t.unspsc.some((p) => c.code.startsWith(p))) ||
    !!t.categories?.some((c) => n.categories.includes(c))
  );
}

const WEIGHTS = { title: 3, codes: 2, buyer: 1, body: 1 } as const;
const K1 = 1.2;
const B = 0.75;
/** Added per matched topic; comparable to a strong single-term text match. */
const TOPIC_BOOST = 3;

interface Doc {
  notice: Notice;
  tf: Map<string, number>;
  len: number;
}

export interface Hit {
  notice: Notice;
  score: number;
  matchedTerms: string[];
  matchedTopics: string[];
}

export class SearchIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(notices: readonly Notice[]) {
    this.docs = notices.map((notice) => {
      const tf = new Map<string, number>();
      let len = 0;
      const add = (text: string, w: number) => {
        for (const t of tokens(text)) {
          tf.set(t, (tf.get(t) ?? 0) + w);
          len += w;
        }
      };
      add(notice.title, WEIGHTS.title);
      add([...notice.unspsc, ...notice.gsin].map((c) => c.description).join(' '), WEIGHTS.codes);
      add([notice.buyer, ...notice.endUsers].join(' '), WEIGHTS.buyer);
      add(notice.plain, WEIGHTS.body);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { notice, tf, len };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * Ranked hits for `query` among notices passing `filter`. With no query, every passing
   * notice is returned with score 0 (callers sort by date). Terms are OR-ed, then scaled
   * by the share of query terms matched, so a notice matching both "snow" and "removal"
   * beats one that says "removal" forty times.
   */
  search(query: string, filter: (n: Notice) => boolean = () => true): Hit[] {
    const terms = [...new Set(tokens(query))];
    const topics = topicsFor(query);
    const N = this.docs.length;
    const hits: Hit[] = [];
    for (const d of this.docs) {
      if (!filter(d.notice)) continue;
      if (!terms.length && !topics.length) {
        hits.push({ notice: d.notice, score: 0, matchedTerms: [], matchedTopics: [] });
        continue;
      }
      let score = 0;
      const matchedTerms: string[] = [];
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / this.avgLen));
        matchedTerms.push(t);
      }
      if (terms.length > 1) score *= matchedTerms.length / terms.length;
      const matchedTopics = topics.filter((t) => topicMatch(d.notice, t)).map((t) => t.id);
      score += TOPIC_BOOST * matchedTopics.length;
      if (score > 0) hits.push({ notice: d.notice, score, matchedTerms, matchedTopics });
    }
    return hits.sort((a, b) => b.score - a.score);
  }
}
