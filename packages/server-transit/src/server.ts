import {
  DownloadCache,
  EXTERNAL_CONTENT_NOTICE,
  HttpClient,
  type FetchFn,
  type Logger,
  type ServerDefinition,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import { AGENCIES } from './agencies.js';
import type { TransitConfig } from './config.js';
import { FeedStore } from './feed-store.js';
import { RealtimeClient } from './realtime.js';
import { allTools, type Deps } from './tools.js';

export { configSchema } from './config.js';
export const NAME = 'porter-transit';
export const VERSION = '0.1.0';

const INSTRUCTIONS = `Ontario public transit: schedules and live predictions for Grand River Transit (grt: Kitchener, Waterloo, Cambridge, ION LRT), Hamilton Street Railway (hsr), TTC (ttc: Toronto) and GO Transit (go: regional trains and buses).

Typical flow: find_stops (if the stop name is loose) → next_departures, or plan_simple_trip for A-to-B on one vehicle. route_info gives a route's stops and hours; service_alerts gives detours and closures.

Rules:
- Say whether a time is live or scheduled: each departure has a status, and realtime.status says whether live data was used. Never call a scheduled time "live".
- When a stop name is ambiguous the tools return labelled options: choose with id:<n> or ask the user.
- plan_simple_trip finds direct rides only. If it reports a transfer is needed, say so rather than inventing a connection.
- Times are local (America/Toronto). The first call for an agency may report that its schedule is still being prepared; retry shortly.
- Mention the agency's data licence when presenting results. ${EXTERNAL_CONTENT_NOTICE}`;

export interface TransitOptions {
  config: TransitConfig;
  log: Logger;
  /** Injected in tests. */
  fetch?: FetchFn;
  /** Injected in tests to pin "now". */
  now?: () => number;
}

/** Builds the server definition. Feeds and realtime caches are shared across requests. */
export function createTransitServer(o: TransitOptions): ServerDefinition {
  const http = new HttpClient({
    userAgent: `${NAME}/${VERSION} (+https://github.com/abhijoshi23/porter)`,
    log: o.log,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    rateLimit: { perSecond: 4, burst: 8 },
  });
  const downloads = new DownloadCache({ dir: o.config.PORTER_CACHE_DIR, http, log: o.log });
  const now = o.now ?? Date.now;
  const deps: Deps = {
    feeds: new FeedStore({ config: o.config, http, downloads, log: o.log, now }),
    realtime: new RealtimeClient({
      http,
      log: o.log,
      maxAgeSeconds: o.config.PORTER_TRANSIT_REALTIME_MAX_AGE_S,
      now,
    }),
    config: o.config,
    now,
  };

  return {
    name: NAME,
    version: VERSION,
    title: 'Porter Transit',
    instructions: INSTRUCTIONS,
    tools: allTools(deps),
    setup: (server) => {
      server.registerPrompt(
        'commute_check',
        {
          title: 'Check my commute',
          description:
            'Next direct rides between two stops, with live delays and any alerts on the way.',
          argsSchema: z.object({
            agency: z.string().describe(`One of: ${o.config.PORTER_TRANSIT_AGENCIES.join(', ')}.`),
            from: z.string().describe('Where you get on, e.g. "Waterloo Public Square".'),
            to: z.string().describe('Where you get off.'),
          }),
        },
        ({ agency, from, to }) => ({
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `I'm travelling on ${AGENCIES[agency as keyof typeof AGENCIES]?.name ?? agency} from ${from} to ${to}.\n\n` +
                  '1. Use plan_simple_trip for the next direct options. If a stop name is ambiguous, show me the options.\n' +
                  '2. Call service_alerts for the route(s) you recommend.\n' +
                  '3. Answer in two or three lines: which one to take, when it leaves (live or scheduled), when it arrives, and any alert that matters.',
              },
            },
          ],
        }),
      );
    },
  };
}
