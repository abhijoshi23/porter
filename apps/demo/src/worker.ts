import { env as workerEnv } from 'cloudflare:workers';
import {
  ConfirmationTokens,
  createLogger,
  createMcpFetchHandler,
  loadConfig,
  type Logger,
  type McpFetchHandler,
  type McpRoute,
} from '@abhijoshi23/porter-toolkit';
import { createOpendataRemoteServer } from '@abhijoshi23/porter-opendata/remote';
import { configSchema, createQuickBooksServer } from '@abhijoshi23/porter-quickbooks';
import { landingPage } from './landing.js';

/**
 * Porter's hosted demo on Cloudflare Workers (free tier). Two MCP servers over stateless
 * Streamable HTTP:
 *
 *   /quickbooks/mcp       the built-in sample company, open
 *   /quickbooks/mcp-auth  the same, behind OAuth 2.1 (only when PORTER_OAUTH_ISSUER is set)
 *   /opendata/mcp         catalogue search and StatCan series, open
 *
 * See ADR-005 and docs/deploy.md.
 */
export interface DemoEnv {
  /** Comma-separated hostnames clients use, e.g. porter-demo.<you>.workers.dev. */
  ALLOWED_HOSTS?: string;
  /** Public origin, e.g. https://porter-demo.<you>.workers.dev. Needed for the OAuth route. */
  PUBLIC_URL?: string;
  /** Hosted authorization server (WorkOS AuthKit, Auth0…). Unset: no /quickbooks/mcp-auth. */
  PORTER_OAUTH_ISSUER?: string;
  PORTER_OAUTH_JWKS_URL?: string;
  /** Secret (wrangler secret put). Signs write approvals so they survive a hop between isolates. */
  PORTER_CONFIRM_SECRET?: string;
  /** Requests per minute per client IP, per server. */
  RATE_LIMIT_PER_MINUTE?: string;
  LOG_LEVEL?: string;
}

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

interface App {
  fetch(req: Request): Promise<Response>;
}

export function createApp(env: DemoEnv, log: Logger = workerLogger(env)): App {
  const hosts = [
    ...LOCAL,
    ...(env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  ];
  const perMinute = Number(env.RATE_LIMIT_PER_MINUTE ?? '60');
  const rateLimit = perMinute > 0 ? { requests: perMinute, windowSeconds: 60 } : undefined;

  if (!env.PORTER_CONFIRM_SECRET) {
    log.warn('PORTER_CONFIRM_SECRET is not set: write approvals only work within one isolate.');
  }
  // One signer for the isolate, shared by the per-request definitions, so an approval minted
  // on one request verifies on the next. Its key is made on first use (no randomness here).
  const tokens = new ConfirmationTokens(env.PORTER_CONFIRM_SECRET);
  const qbConfig = loadConfig(configSchema, {
    QUICKBOOKS_ENVIRONMENT: 'demo',
    // Unused in demo mode (nothing is stored); set so no home directory is looked up.
    PORTER_CONFIG_DIR: '/nonexistent',
  });

  const routes: McpRoute[] = [{ path: '/quickbooks/mcp' }];
  if (env.PORTER_OAUTH_ISSUER) {
    if (!env.PUBLIC_URL)
      throw new Error('PORTER_OAUTH_ISSUER needs PUBLIC_URL (this Worker’s https origin).');
    routes.push({
      path: '/quickbooks/mcp-auth',
      auth: {
        issuer: env.PORTER_OAUTH_ISSUER,
        resource: new URL('/quickbooks/mcp-auth', env.PUBLIC_URL),
        ...(env.PORTER_OAUTH_JWKS_URL ? { jwksUrl: new URL(env.PORTER_OAUTH_JWKS_URL) } : {}),
        resourceName: 'Porter QuickBooks demo',
        documentationUrl: new URL('https://github.com/abhijoshi23/porter/blob/main/docs/deploy.md'),
      },
    });
  }

  const opendata: McpFetchHandler = createMcpFetchHandler(
    createOpendataRemoteServer({ log }),
    log,
    {
      allowedHosts: hosts,
      routes: [{ path: '/opendata/mcp' }],
      ...(rateLimit ? { rateLimit } : {}),
      fallback: (req, url) => landingPage(req, url, { oauth: routes.length > 1 }),
    },
  );
  const quickbooks = createMcpFetchHandler(
    // Fresh sample company per request: one visitor's invoices never show up for the next.
    () => createQuickBooksServer({ config: qbConfig, log, tokens }),
    log,
    {
      allowedHosts: hosts,
      routes,
      ...(rateLimit ? { rateLimit } : {}),
      fallback: (req) => opendata.fetch(req),
    },
  );
  return quickbooks;
}

function workerLogger(env: DemoEnv): Logger {
  return createLogger('porter-demo', env.LOG_LEVEL ?? 'info', (line) => console.log(line));
}

/**
 * Built at startup, not on the first request: startup has its own, larger CPU allowance,
 * while building here inside a request (~30 ms) would blow the free tier's ~10 ms per-request
 * budget on every fresh isolate. Nothing in createApp does I/O, timers or randomness, which
 * Workers forbids at global scope.
 */
let app: App | undefined;
try {
  app = createApp(workerEnv as DemoEnv);
} catch (err) {
  console.error(err); // e.g. OAuth issuer without PUBLIC_URL; every request then gets a 500
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (!app) return new Response('Server misconfigured. See the Worker logs.', { status: 500 });
    return app.fetch(req);
  },
} satisfies ExportedHandler<DemoEnv>;
