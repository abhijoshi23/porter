import { baseConfigSchema, defaultCacheDir } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import { AGENCY_IDS, type AgencyId } from './agencies.js';

export const configSchema = baseConfigSchema.extend({
  /** Where GTFS zips and the built schedule databases live between runs. */
  PORTER_CACHE_DIR: z.string().default(defaultCacheDir()),
  /** Comma-separated agencies to serve. TTC alone is ~70 MB zipped, so trim if you don't need it. */
  PORTER_TRANSIT_AGENCIES: z
    .string()
    .default(AGENCY_IDS.join(','))
    .transform((s, ctx) => {
      const ids = s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const bad = ids.filter((x) => !(AGENCY_IDS as readonly string[]).includes(x));
      if (bad.length || ids.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown agencies: ${bad.join(', ') || '(none given)'}; use ${AGENCY_IDS.join(', ')}`,
        });
        return z.NEVER;
      }
      return [...new Set(ids)] as AgencyId[];
    }),
  /** Largest GTFS zip to download. */
  PORTER_TRANSIT_MAX_DOWNLOAD_MB: z.coerce.number().positive().max(2048).default(200),
  /** Cap on the total unzipped size of the files we extract (zip-bomb guard). */
  PORTER_TRANSIT_MAX_UNZIPPED_MB: z.coerce.number().positive().max(8192).default(1024),
  /** How often to re-download static schedules. Agencies publish every few weeks. */
  PORTER_TRANSIT_REFRESH_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(24),
  /**
   * How long a tool call waits for a first-time feed download and build before replying
   * "still preparing, try again". The build continues in the background either way.
   */
  PORTER_TRANSIT_BUILD_WAIT_MS: z.coerce.number().int().min(0).max(600_000).default(25_000),
  /** Realtime predictions older than this are reported as stale and not applied. */
  PORTER_TRANSIT_REALTIME_MAX_AGE_S: z.coerce.number().int().min(30).max(3600).default(300),
});

export type TransitConfig = z.infer<typeof configSchema>;
