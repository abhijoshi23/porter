import {
  DownloadCache,
  EXTERNAL_CONTENT_NOTICE,
  HttpClient,
  type FetchFn,
  type Logger,
  type ServerDefinition,
} from '@abhijoshi23/porter-toolkit';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { CkanClient, PORTAL_IDS } from './ckan.js';
import type { OpendataConfig } from './config.js';
import { StatCanClient } from './statcan.js';
import { allTools, type Deps } from './tools.js';

export { configSchema } from './config.js';
export const NAME = 'porter-opendata';
export const VERSION = '0.1.0';

const INSTRUCTIONS = `Canadian open data: the Ontario, City of Toronto and federal (open.canada.ca) catalogues, plus Statistics Canada tables.

Two paths:
- Datasets/files: search_datasets → get_dataset → preview_resource → query_resource (DuckDB SQL over CSV, table "data").
- Official statistics (unemployment, CPI, population…): statcan_find_table → statcan_get_table (member names) → statcan_get_series.

Geography matters: Waterloo the city, Waterloo Region and the Kitchener-Cambridge-Waterloo census metropolitan area (CMA) are different. Labour-force data by city uses CMAs. When a name is ambiguous the tools return the options: choose explicitly or ask the user.

Always cite the source and licence returned by the tools. ${EXTERNAL_CONTENT_NOTICE}`;

export interface OpendataOptions {
  config: OpendataConfig;
  log: Logger;
  /** Injected in tests for fixture replay. */
  fetch?: FetchFn;
}

/** Builds the server definition. Shared clients live here, outside the per-request factory. */
export function createOpendataServer(o: OpendataOptions): ServerDefinition {
  const http = new HttpClient({
    userAgent: `${NAME}/${VERSION} (+https://github.com/abhijoshi23/porter)`,
    log: o.log,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    // Public-sector hosts: be polite. StatCan documents a limit of 25 req/s per IP; stay well under.
    rateLimit: { perSecond: 4, burst: 8 },
  });
  const downloads = new DownloadCache({ dir: o.config.PORTER_CACHE_DIR, http, log: o.log });
  const deps: Deps = {
    ckan: new CkanClient(http),
    statcan: new StatCanClient(http, downloads),
    downloads,
    config: o.config,
  };

  return {
    name: NAME,
    version: VERSION,
    title: 'Porter Open Data',
    instructions: INSTRUCTIONS,
    tools: allTools(deps),
    setup: (server) => {
      // Resources are application-controlled context (the user or host attaches them),
      // while tools are model-controlled. Exposing dataset metadata as a resource lets a
      // user pin a dataset into the conversation without the model having to search.
      server.registerResource(
        'dataset',
        new ResourceTemplate('opendata://{portal}/{name}', { list: undefined }),
        {
          title: 'Open-data dataset metadata',
          description: `Metadata for one catalogue dataset. portal is one of: ${PORTAL_IDS.join(', ')}.`,
          mimeType: 'application/json',
          cacheHint: { ttlMs: 10 * 60_000, cacheScope: 'public' },
        },
        async (uri, vars) => {
          const d = await deps.ckan.get(`${vars.portal}:${vars.name}`);
          return {
            contents: [
              { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(d, null, 2) },
            ],
          };
        },
      );

      server.registerPrompt(
        'compare_cities',
        {
          title: 'Compare a metric across Waterloo Region, Hamilton and Toronto',
          description:
            'Guides the assistant through finding a StatCan table and comparing one indicator across three Ontario metros.',
          argsSchema: z.object({
            metric: z
              .string()
              .describe('What to compare, e.g. "unemployment rate" or "employment rate".'),
            since: z.string().optional().describe('Start year, e.g. "2019".'),
          }),
        },
        ({ metric, since }) => ({
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `Compare the ${metric} across Kitchener-Cambridge-Waterloo, Hamilton and Toronto` +
                  `${since ? ` since ${since}` : ' over the last five years'}.\n\n` +
                  '1. Use statcan_find_table to find an active table with census metropolitan area (CMA) geography.\n' +
                  '2. Use statcan_get_table to confirm the exact geography and member names.\n' +
                  '3. Call statcan_get_series once per CMA with the same members and date range.\n' +
                  '4. Present a short table of start vs latest values and the change, note any suppressed points, ' +
                  'and cite the table (with DOI) and the Statistics Canada Open Licence.',
              },
            },
          ],
        }),
      );
    },
  };
}
