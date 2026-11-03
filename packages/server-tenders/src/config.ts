import { baseConfigSchema, defaultCacheDir } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

export const configSchema = baseConfigSchema.extend({
  /** Where downloaded CanadaBuys files are kept between runs. */
  PORTER_CACHE_DIR: z.string().default(defaultCacheDir()),
  /**
   * How often to re-download the open-notices file. CanadaBuys regenerates it daily and
   * the new-notices file through the day.
   */
  PORTER_TENDERS_REFRESH_HOURS: z.coerce.number().positive().max(168).default(6),
  /**
   * Fiscal years of closed and cancelled notices to load for lookups (current year plus
   * previous ones; 0 = open notices only). Loaded on first need: ~25-40 MB each.
   */
  PORTER_TENDERS_HISTORY_YEARS: z.coerce.number().int().min(0).max(4).default(2),
  /** Largest single file to download. */
  PORTER_TENDERS_MAX_DOWNLOAD_MB: z.coerce.number().positive().max(1024).default(150),
});

export type TendersConfig = z.infer<typeof configSchema>;
