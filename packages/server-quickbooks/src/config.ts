import { baseConfigSchema } from '@abhijoshi23/porter-toolkit';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';

/** Where the encrypted QuickBooks connection is kept: $XDG_CONFIG_HOME/porter or ~/.config/porter. */
export function defaultConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'porter');
}

export const configSchema = baseConfigSchema.extend({
  /**
   * From your app's Keys & credentials page on developer.intuit.com (free). Optional at
   * startup so the server still starts and can tell the model how to connect; tools fail
   * with that hint until both are set and `porter-quickbooks auth` has run.
   */
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  /**
   * `sandbox` (default): Intuit sandbox companies only. `production`: real books. `demo`: a
   * built-in sample company held in memory; no Intuit account or credentials needed, and
   * invoices "created" disappear when the server stops.
   */
  QUICKBOOKS_ENVIRONMENT: z.enum(['sandbox', 'production', 'demo']).default('sandbox'),
  /** Must match a redirect URI registered on the app. Intuit allows http://localhost for development keys. */
  QUICKBOOKS_REDIRECT_URI: z.url().default('http://localhost:8723/callback'),
  /** Holds `quickbooks-<environment>.json`, encrypted with a key derived from the client secret. */
  PORTER_CONFIG_DIR: z.string().default(defaultConfigDir()),
  /** "Today" for due dates and reporting periods. QuickBooks dates have no time zone. */
  PORTER_TIMEZONE: z.string().default('America/Toronto'),
  /**
   * Signs write confirmations. Set it when several processes serve one client (HTTP behind
   * a load balancer); stdio servers can leave it empty and get a random per-process key.
   */
  PORTER_CONFIRM_SECRET: z.string().min(32).optional(),
  /**
   * `true`: refuse writes from clients that can't ask the user themselves (elicitation),
   * instead of falling back to preview-then-confirm-token.
   */
  QUICKBOOKS_REQUIRE_ELICITATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type QuickBooksConfig = z.infer<typeof configSchema>;
