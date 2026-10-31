import { baseConfigSchema, defaultCacheDir } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

export const configSchema = baseConfigSchema.extend({
  /** Where downloaded CSVs and the StatCan table list are cached between runs. */
  PORTER_CACHE_DIR: z.string().default(defaultCacheDir()),
  /** Largest resource `preview_resource` / `query_resource` will download. */
  PORTER_MAX_DOWNLOAD_MB: z.coerce.number().positive().max(2048).default(100),
  /** Wall-clock limit for one `query_resource` SQL query. */
  PORTER_SQL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  /** Hard cap on rows `query_resource` returns to the model. */
  PORTER_SQL_MAX_ROWS: z.coerce.number().int().min(1).max(1_000).default(200),
});

export type OpendataConfig = z.infer<typeof configSchema>;
