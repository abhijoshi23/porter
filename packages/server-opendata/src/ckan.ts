import {
  externalText,
  InvalidInputError,
  MemoryCache,
  NotFoundError,
  PorterError,
  UpstreamError,
  type HttpClient,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

/** The three CKAN catalogues Porter searches. All are public with no API key. */
export const PORTALS = {
  ontario: {
    name: 'Ontario Data Catalogue',
    api: 'https://data.ontario.ca/api/3/action',
    page: (p: RawPackage) => `https://data.ontario.ca/dataset/${p.name}`,
  },
  toronto: {
    name: 'City of Toronto Open Data',
    api: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action',
    page: (p: RawPackage) => `https://open.toronto.ca/dataset/${p.name}/`,
  },
  canada: {
    name: 'Open Government Portal (Canada)',
    api: 'https://open.canada.ca/data/api/3/action',
    page: (p: RawPackage) => `https://open.canada.ca/data/en/dataset/${p.id}`,
  },
} as const;

export type PortalId = keyof typeof PORTALS;
export const PORTAL_IDS = Object.keys(PORTALS) as [PortalId, ...PortalId[]];

/**
 * Portal licence IDs → human names and canonical URLs. Toronto's CKAN reports only a
 * slug, and citing "open-government-licence-toronto" in an answer is unhelpful.
 */
const LICENCES: Record<string, { name: string; url: string }> = {
  'OGL-ON-1.0': {
    name: 'Open Government Licence – Ontario',
    url: 'https://www.ontario.ca/page/open-government-licence-ontario',
  },
  'open-government-licence-toronto': {
    name: 'Open Government Licence – Toronto',
    url: 'https://open.toronto.ca/open-data-license/',
  },
  'ca-ogl-lgo': {
    name: 'Open Government Licence – Canada',
    url: 'https://open.canada.ca/en/open-government-licence-canada',
  },
};

// Only the fields we use. `.loose()` tolerates the dozens of extra, portal-specific fields.
const translated = z.record(z.string(), z.string()).nullish();
const rawResource = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    name_translated: translated,
    format: z.string().nullish(),
    url: z.string().nullish(),
    size: z.union([z.number(), z.string()]).nullish(),
    last_modified: z.string().nullish(),
    datastore_active: z.boolean().nullish(),
  })
  .loose();
const rawPackage = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullish(),
    title_translated: translated,
    notes: z.string().nullish(),
    notes_translated: translated,
    license_id: z.string().nullish(),
    license_title: z.string().nullish(),
    license_url: z.string().nullish(),
    metadata_modified: z.string().nullish(),
    organization: z.object({ title: z.string().nullish() }).loose().nullish(),
    resources: z.array(rawResource).default([]),
  })
  .loose();
type RawPackage = z.infer<typeof rawPackage>;

const envelope = <T extends z.ZodType>(result: T) =>
  z.object({ success: z.boolean(), result: result.optional(), error: z.unknown().optional() });

export interface Licence {
  name: string;
  url: string | null;
}

export interface ResourceInfo {
  resourceId: string;
  name: string;
  format: string;
  url: string;
  sizeBytes: number | null;
  lastModified: string | null;
  /** True when `preview_resource` / `query_resource` can load it (CSV). */
  queryable: boolean;
}

export interface DatasetInfo {
  datasetId: string;
  portal: PortalId;
  title: string;
  publisher: string | null;
  /** Publisher-provided text: external content, sanitized and truncated. */
  description: string;
  licence: Licence;
  lastModified: string | null;
  pageUrl: string;
  resources: ResourceInfo[];
}

/**
 * Dataset IDs are `<portal>:<name>` (e.g. `toronto:library-branch-general-information`).
 * Encoding the portal in the ID means the model never has to pass the portal separately,
 * and the ID chains straight from `search_datasets` into every other tool.
 */
export function parseDatasetId(datasetId: string): { portal: PortalId; name: string } {
  const m = /^(ontario|toronto|canada):([A-Za-z0-9_.-]{1,200})$/.exec(datasetId.trim());
  if (!m) {
    throw new InvalidInputError(`"${datasetId}" is not a valid dataset ID.`, {
      hint: 'Dataset IDs look like "ontario:duration-of-unemployment". Get one from search_datasets.',
    });
  }
  return { portal: m[1] as PortalId, name: m[2]! };
}

const QUERYABLE = new Set(['CSV']);

function toDataset(portal: PortalId, p: RawPackage): DatasetInfo {
  const known = p.license_id ? LICENCES[p.license_id] : undefined;
  return {
    datasetId: `${portal}:${p.name}`,
    portal,
    title: externalText(p.title_translated?.en ?? p.title ?? p.name, 200),
    publisher: p.organization?.title ? externalText(p.organization.title, 120) : null,
    description: externalText(p.notes_translated?.en ?? p.notes, 600),
    licence: known ?? { name: p.license_title ?? 'Unspecified', url: p.license_url ?? null },
    lastModified: p.metadata_modified ?? null,
    pageUrl: PORTALS[portal].page(p),
    resources: p.resources
      .filter((r) => r.url)
      .map((r) => {
        const format = (r.format ?? '').trim().toUpperCase() || 'UNKNOWN';
        const size =
          r.size === null || r.size === undefined || r.size === '' ? NaN : Number(r.size);
        return {
          resourceId: r.id,
          name: externalText(r.name_translated?.en ?? r.name ?? r.id, 150),
          format,
          url: r.url!,
          sizeBytes: Number.isFinite(size) ? size : null,
          lastModified: r.last_modified ?? null,
          queryable: QUERYABLE.has(format),
        };
      }),
  };
}

export class CkanClient {
  // Metadata changes rarely; ten minutes keeps chained calls (search → get → preview) cheap.
  private readonly cache = new MemoryCache<DatasetInfo>({ max: 500, ttlMs: 10 * 60_000 });

  constructor(private readonly http: HttpClient) {}

  async search(
    portal: PortalId,
    o: { query: string; rows: number; start: number; format?: string | undefined },
  ): Promise<{ count: number; datasets: DatasetInfo[] }> {
    const url = new URL(`${PORTALS[portal].api}/package_search`);
    url.searchParams.set('q', o.query);
    url.searchParams.set('rows', String(o.rows));
    url.searchParams.set('start', String(o.start));
    if (o.format) url.searchParams.set('fq', `res_format:"${o.format.replace(/"/g, '')}"`);
    const body = await this.http.getJson(
      url,
      envelope(z.object({ count: z.number(), results: z.array(rawPackage) })),
    );
    if (!body.success || !body.result) throw portalError(portal);
    const datasets = body.result.results.map((p) => toDataset(portal, p));
    for (const d of datasets) this.cache.set(d.datasetId, d);
    return { count: body.result.count, datasets };
  }

  async get(datasetId: string): Promise<DatasetInfo> {
    const { portal, name } = parseDatasetId(datasetId);
    return this.cache.getOrLoad(`${portal}:${name}`, async () => {
      const url = new URL(`${PORTALS[portal].api}/package_show`);
      url.searchParams.set('id', name);
      let body;
      try {
        body = await this.http.getJson(url, envelope(rawPackage));
      } catch (err) {
        // CKAN answers a missing dataset with HTTP 404.
        if (err instanceof UpstreamError && err.status === 404) throw notFound(datasetId);
        throw err;
      }
      if (!body.success || !body.result) throw notFound(datasetId);
      return toDataset(portal, body.result);
    });
  }

  async getResource(
    datasetId: string,
    resourceId: string,
  ): Promise<{ dataset: DatasetInfo; resource: ResourceInfo }> {
    const dataset = await this.get(datasetId);
    const resource = dataset.resources.find((r) => r.resourceId === resourceId);
    if (!resource) {
      throw new NotFoundError(`Dataset ${datasetId} has no resource "${resourceId}".`, {
        hint: `Valid resource IDs: ${dataset.resources.map((r) => `${r.resourceId} (${r.format})`).join(', ') || 'none'}.`,
      });
    }
    return { dataset, resource };
  }
}

function notFound(datasetId: string): NotFoundError {
  return new NotFoundError(`Dataset ${datasetId} was not found.`, {
    hint: 'Check the ID, or call search_datasets to find current datasets.',
  });
}

function portalError(portal: PortalId): PorterError {
  return new PorterError(`${PORTALS[portal].name} returned an error.`, { retryable: true });
}
