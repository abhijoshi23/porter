import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { LRUCache } from 'lru-cache';
import type { Logger } from './logger.js';
import {
  jwtVerifier,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  type ResourceServerOptions,
} from './oauth.js';
import { serverFactory, type ServerDefinition } from './factory.js';

export interface McpRoute {
  /** e.g. `/mcp`. */
  path: string;
  /** Require a bearer token on this route (OAuth 2.1 resource server). Omit for an open route. */
  auth?: ResourceServerOptions;
}

export interface FetchHandlerOptions {
  /**
   * Hostnames accepted in `Host` and `Origin` (DNS-rebinding defence), or `'localhost'`
   * for loopback-only. Without this check a web page can point its own domain at a local
   * server and drive it from the user's browser.
   */
  allowedHosts: 'localhost' | string[];
  /** Default: one open route at `/mcp`. */
  routes?: McpRoute[];
  /**
   * Per-client fixed-window limit on MCP requests. Best effort: counts live in this
   * process (on Workers, in one isolate), so it caps a noisy client, not a distributed one.
   */
  rateLimit?: { requests: number; windowSeconds: number };
  /** Who a request counts against. Default: `cf-connecting-ip`, else one shared bucket. */
  clientKey?: (req: Request) => string;
  /** Extra plain routes (e.g. a landing page), tried before the 404. */
  fallback?: (req: Request, url: URL) => Response | Promise<Response> | undefined;
}

export interface McpFetchHandler {
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * One MCP server over Streamable HTTP as a web-standard `fetch` handler: the same code on
 * Node (`toNodeHandler`) and on Cloudflare Workers. Order per request: health → OAuth
 * metadata → Host/Origin → rate limit → bearer token → MCP.
 */
export function createMcpFetchHandler(
  def: ServerDefinition | (() => ServerDefinition),
  log: Logger,
  o: FetchHandlerOptions,
): McpFetchHandler {
  const mcp = createMcpHandler(serverFactory(def, log), {
    onerror: (err) => log.warn({ err }, 'mcp http error'),
  });
  const hosts = o.allowedHosts === 'localhost' ? localhostAllowedHostnames() : o.allowedHosts;
  const origins = o.allowedHosts === 'localhost' ? localhostAllowedOrigins() : o.allowedHosts;
  if (hosts.length === 0) throw new Error('allowedHosts must list at least one hostname.');

  const routes = (o.routes ?? [{ path: '/mcp' }]).map((r) => {
    if (!r.auth) return { path: r.path, gate: undefined, metadata: undefined };
    const resourceMetadataUrl = protectedResourceMetadataUrl(r.auth).href;
    return {
      path: r.path,
      gate: requireBearerAuth({
        verifier: jwtVerifier(r.auth),
        expectedResource: r.auth.resource,
        resourceMetadataUrl,
        ...(r.auth.requiredScopes ? { requiredScopes: r.auth.requiredScopes } : {}),
      }),
      metadata: {
        path: new URL(resourceMetadataUrl).pathname,
        body: protectedResourceMetadata(r.auth),
      },
    };
  });

  const limiter = o.rateLimit && fixedWindow(o.rateLimit.requests, o.rateLimit.windowSeconds);
  const keyOf = o.clientKey ?? ((req: Request) => req.headers.get('cf-connecting-ip') ?? 'all');

  return {
    close: () => mcp.close(),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') return new Response('ok');

      for (const r of routes) {
        if (r.metadata && url.pathname === r.metadata.path) {
          // Public discovery document: clients fetch it cross-origin before they have a token.
          if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
          if (req.method !== 'GET')
            return new Response(null, { status: 405, headers: { allow: 'GET' } });
          return json(r.metadata.body, 200, { ...CORS, 'cache-control': 'public, max-age=3600' });
        }
      }

      const route = routes.find((r) => r.path === url.pathname);
      if (!route)
        return (await o.fallback?.(req, url)) ?? new Response('Not found', { status: 404 });

      const rejected =
        hostHeaderValidationResponse(req, hosts) ?? originValidationResponse(req, origins);
      if (rejected) return rejected;

      if (limiter) {
        const wait = limiter(keyOf(req));
        if (wait > 0) {
          return json(
            { error: 'rate_limited', message: `Too many requests. Try again in ${wait} s.` },
            429,
            { 'retry-after': String(wait) },
          );
        }
      }

      let authInfo: AuthInfo | undefined;
      if (route.gate) {
        const auth = await route.gate(req);
        if (auth instanceof Response) return auth;
        authInfo = auth;
      }
      return mcp.fetch(req, authInfo ? { authInfo } : undefined);
    },
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'mcp-protocol-version',
};

/** Returns 0 when allowed, else seconds until the client's window resets. */
function fixedWindow(limit: number, windowSeconds: number, now = () => Date.now()) {
  const windowMs = windowSeconds * 1000;
  // Bounded, so a flood of distinct keys can't grow memory without limit.
  const counts = new LRUCache<string, { start: number; n: number }>({ max: 10_000 });
  return (key: string): number => {
    const t = now();
    let w = counts.get(key);
    if (!w || t - w.start >= windowMs) counts.set(key, (w = { start: t, n: 0 }));
    w.n += 1;
    return w.n > limit ? Math.ceil((w.start + windowMs - t) / 1000) : 0;
  };
}
