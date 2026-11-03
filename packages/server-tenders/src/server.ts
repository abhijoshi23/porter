import {
  DownloadCache,
  EXTERNAL_CONTENT_NOTICE,
  HttpClient,
  type FetchFn,
  type Logger,
  type ServerDefinition,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import type { TendersConfig } from './config.js';
import { TenderStore } from './store.js';
import { allTools } from './tools.js';

export { configSchema } from './config.js';
export const NAME = 'porter-tenders';
export const VERSION = '0.1.0';

const INSTRUCTIONS = `Government of Canada tender notices from CanadaBuys: what federal departments are buying, open now or recently closed.

Typical flow: search_tenders → get_tender for details, or summarize_tender_fit for a bid/no-bid read (security clearance, set-asides, mandatory requirements, deadlines).

Rules:
- Closing times are Eastern time (ET). Give the date, time and zone, and say how long is left.
- Say what kind of notice it is: an RFI or an advance contract award notice is not an open competition.
- summarize_tender_fit reads the notice text only. The solicitation documents usually hold the full requirements; say so rather than presenting the extraction as complete, and treat "not_stated" as unknown.
- Cite CanadaBuys and the Open Government Licence – Canada when presenting results.
- These tools are read-only: they cannot submit bids or register suppliers. ${EXTERNAL_CONTENT_NOTICE}`;

export interface TendersOptions {
  config: TendersConfig;
  log: Logger;
  /** Injected in tests. */
  fetch?: FetchFn;
  /** Injected in tests to pin "now". */
  now?: () => number;
}

export function createTendersServer(o: TendersOptions): ServerDefinition {
  const http = new HttpClient({
    userAgent: `${NAME}/${VERSION} (+https://github.com/abhijoshi23/porter)`,
    log: o.log,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    rateLimit: { perSecond: 2, burst: 4 },
  });
  const downloads = new DownloadCache({ dir: o.config.PORTER_CACHE_DIR, http, log: o.log });
  const now = o.now ?? Date.now;
  const store = new TenderStore({ config: o.config, downloads, log: o.log, now });

  return {
    name: NAME,
    version: VERSION,
    title: 'Porter Tenders',
    instructions: INSTRUCTIONS,
    tools: allTools({ store, now }),
    setup: (server) => {
      server.registerPrompt(
        'tender_scan',
        {
          title: 'Find tenders for my business',
          description:
            'Open federal tenders that fit what you do, with a bid/no-bid read on the best ones.',
          argsSchema: z.object({
            business: z
              .string()
              .describe('What you sell or do, e.g. "cloud migration and Azure support".'),
            region: z.string().optional().describe('Where you can deliver, e.g. "Ontario".'),
            clearance: z
              .string()
              .optional()
              .describe('Highest security clearance your team holds, if any.'),
          }),
        },
        ({ business, region, clearance }) => ({
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `My business: ${business}.${region ? ` I can deliver in ${region}.` : ''}${clearance ? ` Our team holds ${clearance} clearance.` : ''}\n\n` +
                  '1. Use search_tenders for open notices that match (try one or two phrasings).\n' +
                  '2. For the three most promising, call summarize_tender_fit with my profile.\n' +
                  '3. Give me a short table: title, buyer, closes (ET), kind, clearance, blockers. Then one line on which to look at first and why.',
              },
            },
          ],
        }),
      );
    },
  };
}
