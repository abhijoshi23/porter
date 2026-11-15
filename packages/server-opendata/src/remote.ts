import {
  EXTERNAL_CONTENT_NOTICE,
  HttpClient,
  type FetchFn,
  type Logger,
  type ServerDefinition,
} from '@abhijoshi23/porter-toolkit';
import { CkanClient } from './ckan.js';
import { StatCanClient } from './statcan.js';
import { remoteTools } from './tools.js';

/**
 * Open data without a disk or native modules, for hosted deployments (Cloudflare Workers):
 * catalogue search and dataset metadata, and StatCan series by table id. No DuckDB SQL over
 * CSVs and no full-text table search: those need the local server.
 *
 * Kept free of `./sql.js` imports on purpose; a bundler must never see DuckDB.
 */
export const NAME = 'porter-opendata';
export const VERSION = '0.1.0';

const INSTRUCTIONS = `Canadian open data (hosted, reduced): the Ontario, City of Toronto and federal (open.canada.ca) catalogues, plus Statistics Canada series.

- Datasets/files: search_datasets → get_dataset (files, formats, licence). SQL over CSV files is not available here; point the user at the dataset page or the local Porter server.
- Official statistics: statcan_get_table needs a StatCan table id (e.g. 14-10-0287-01 for the Labour Force Survey) → statcan_get_series. Table search is not available here; if you don't know the id, say so.

Geography matters: Waterloo the city, Waterloo Region and the Kitchener-Cambridge-Waterloo census metropolitan area (CMA) are different.

Always cite the source and licence returned by the tools. ${EXTERNAL_CONTENT_NOTICE}`;

export interface OpendataRemoteOptions {
  log: Logger;
  /** Injected in tests for fixture replay. */
  fetch?: FetchFn;
}

export function createOpendataRemoteServer(o: OpendataRemoteOptions): ServerDefinition {
  const http = new HttpClient({
    userAgent: `${NAME}/${VERSION} (+https://github.com/abhijoshi23/porter)`,
    log: o.log,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    rateLimit: { perSecond: 4, burst: 8 },
  });
  return {
    name: NAME,
    version: VERSION,
    title: 'Porter Open Data (hosted)',
    instructions: INSTRUCTIONS,
    tools: remoteTools({ ckan: new CkanClient(http), statcan: new StatCanClient(http) }),
  };
}
