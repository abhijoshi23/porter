import * as z from 'zod/v4';

/** Settings every Porter server understands. Servers extend this with their own keys. */
export const baseConfigSchema = z.object({
  PORTER_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  PORTER_HTTP_HOST: z.string().default('127.0.0.1'),
  // 0 = pick a free port (tests).
  PORTER_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /**
   * Comma-separated hostnames allowed in the `Host` header when bound to a non-loopback
   * interface (DNS-rebinding defence). Ignored for loopback binds, which only accept localhost names.
   */
  PORTER_ALLOWED_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Validates environment variables at startup and fails fast with a readable list of
 * problems. A misconfigured stdio server that crashes later shows up in Claude Desktop as
 * "server disconnected" with no explanation, so failing early with a clear message on
 * stderr matters.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(
    `Invalid configuration:\n${lines.join('\n')}\nSee .env.example for every supported variable.`,
  );
}
