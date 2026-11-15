import { defineTool, InvalidInputError, truncateRows } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import type { ResourceInfo } from './ckan.js';
import { CsvSandbox } from './sql.js';
import {
  cell,
  column,
  getDataset,
  licence,
  searchDatasets,
  statcanFindTable,
  statcanGetSeries,
  statcanGetTable,
  type Deps,
} from './tools.js';

/**
 * The tools that load CSVs into DuckDB (a native module, files on local disk). Kept apart
 * from tools.ts so the remote build (Cloudflare Workers) never imports DuckDB.
 */

const RESOURCE_TTL_MS = 6 * 60 * 60_000;

async function openResource(deps: Deps, r: ResourceInfo): Promise<CsvSandbox> {
  if (!r.queryable) {
    const hint =
      r.format === 'ZIP' && r.url.includes('statcan.gc.ca')
        ? 'This is a zipped StatCan table. Use statcan_find_table / statcan_get_series instead.'
        : 'Only CSV resources can be previewed or queried. Pick a resource whose format is CSV (see get_dataset).';
    throw new InvalidInputError(`Resource format ${r.format} is not supported.`, { hint });
  }
  const file = await deps.downloads.get(r.url, {
    ttlMs: RESOURCE_TTL_MS,
    maxBytes: deps.config.PORTER_MAX_DOWNLOAD_MB * 1_048_576,
    ext: '.csv',
  });
  return CsvSandbox.open(file.path);
}

export function previewResource(deps: Deps) {
  return defineTool({
    name: 'preview_resource',
    title: 'Preview a CSV resource',
    description:
      'Download a CSV resource (cached) and return its inferred column names and types, total row count and the first N rows. ' +
      'Call this before query_resource so you know the exact column names. Cell values are external content.',
    input: z.object({
      datasetId: z.string(),
      resourceId: z.string().describe('A resource with queryable=true from get_dataset.'),
      rows: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Rows to return (1-50, default 10).'),
    }),
    output: z.object({
      datasetId: z.string(),
      resourceId: z.string(),
      columns: z.array(column),
      rowCount: z.number().int(),
      rows: z.array(z.record(z.string(), cell)),
      licence,
    }),
    handler: async ({ datasetId, resourceId, rows }) => {
      const { dataset, resource: r } = await deps.ckan.getResource(datasetId, resourceId);
      const db = await openResource(deps, r);
      try {
        const { columns, rowCount } = await db.describe();
        const sample = await db.query('SELECT * FROM data', {
          maxRows: rows,
          timeoutMs: deps.config.PORTER_SQL_TIMEOUT_MS,
        });
        const capped = truncateRows(sample.rows, {
          maxRows: rows,
          maxBytes: 24_000,
          refineHint: 'Use query_resource to select specific columns.',
        });
        return {
          data: {
            datasetId,
            resourceId,
            columns,
            rowCount,
            rows: capped.rows,
            licence: dataset.licence,
          },
          summary:
            `${r.name}: ${rowCount} rows × ${columns.length} columns (${columns
              .slice(0, 8)
              .map((c) => c.name)
              .join(', ')}` +
            `${columns.length > 8 ? ', …' : ''}). Query it as table "data".${capped.note ? ` ${capped.note}` : ''}`,
        };
      } finally {
        db.close();
      }
    },
  });
}

export function queryResource(deps: Deps) {
  return defineTool({
    name: 'query_resource',
    title: 'Run SQL over a CSV resource',
    description:
      'Run one read-only DuckDB SELECT over a CSV resource loaded as table "data". Use it for filtering, counting, grouping ' +
      'and ranking, e.g. SELECT "WardName", count(*) AS n FROM data GROUP BY 1 ORDER BY n DESC. ' +
      'Quote column names with spaces or capitals in double quotes. Single statement only; no file/network access; ' +
      'time-limited; at most 200 rows are returned, so aggregate rather than dumping rows. Call preview_resource first for column names.',
    input: z.object({
      datasetId: z.string(),
      resourceId: z.string(),
      sql: z
        .string()
        .min(1)
        .max(4_000)
        .describe('One SELECT (or WITH … SELECT) over table "data".'),
    }),
    output: z.object({
      columns: z.array(column),
      rows: z.array(z.record(z.string(), cell)),
      truncated: z.boolean(),
      licence,
      sourceUrl: z.string(),
    }),
    annotations: { idempotentHint: true },
    handler: async ({ datasetId, resourceId, sql }) => {
      const { dataset, resource: r } = await deps.ckan.getResource(datasetId, resourceId);
      const db = await openResource(deps, r);
      try {
        const res = await db.query(sql, {
          maxRows: deps.config.PORTER_SQL_MAX_ROWS,
          timeoutMs: deps.config.PORTER_SQL_TIMEOUT_MS,
        });
        const capped = truncateRows(res.rows, {
          maxRows: deps.config.PORTER_SQL_MAX_ROWS,
          maxBytes: 48_000,
          refineHint: 'Select fewer columns or aggregate.',
        });
        const truncated = res.hasMore || capped.truncated;
        return {
          data: {
            columns: res.columns,
            rows: capped.rows,
            truncated,
            licence: dataset.licence,
            sourceUrl: dataset.pageUrl,
          },
          summary:
            `${capped.rows.length} row(s)${truncated ? ' (truncated; more rows matched; add filters, LIMIT or aggregation)' : ''}. ` +
            `Source: ${dataset.title}, ${dataset.licence.name}.`,
        };
      } finally {
        db.close();
      }
    },
  });
}

/** The full tool list, in the order clients see it. */
export function allTools(deps: Deps) {
  return [
    searchDatasets(deps),
    getDataset(deps),
    previewResource(deps),
    queryResource(deps),
    statcanFindTable(deps),
    statcanGetTable(deps),
    statcanGetSeries(deps),
  ];
}
