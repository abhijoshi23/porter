import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { BaseConfig } from './config.js';
import { ConfigError } from './config.js';
import { serverFactory, type ServerDefinition } from './factory.js';
import { createMcpFetchHandler, type McpRoute } from './http-handler.js';
import type { Logger } from './logger.js';

export { serverFactory, type AnyTool, type ServerDefinition } from './factory.js';

export interface RunningServer {
  /** Set in HTTP mode: the actual bound port (useful when configured with port 0). */
  port?: number;
  close(): Promise<void>;
}

/** Starts the server on the transport chosen by `PORTER_TRANSPORT`. */
export async function runServer(
  def: ServerDefinition,
  config: BaseConfig,
  log: Logger,
): Promise<RunningServer> {
  if (config.PORTER_TRANSPORT === 'stdio') {
    // serveStdio picks the protocol era from the client's first message. A 2025-era
    // `initialize` gets a classic session; a 2026 request with `_meta` gets the stateless path.
    const handle = serveStdio(serverFactory(def, log), {
      onerror: (err) => log.error({ err }, 'stdio error'),
    });
    log.info({ server: def.name, version: def.version }, 'listening on stdio');
    return { close: () => handle.close() };
  }

  // Same handler as on Cloudflare Workers: Host/Origin checks, optional OAuth, then MCP.
  const handler = createMcpFetchHandler(def, log, {
    allowedHosts: allowedHosts(config),
    routes: [mcpRoute(config)],
  });
  const nodeHandler = toNodeHandler(handler);

  const http: HttpServer = createHttpServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.PORTER_HTTP_PORT, config.PORTER_HTTP_HOST, resolve);
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.PORTER_HTTP_PORT;
  log.info(
    {
      server: def.name,
      url: `http://${config.PORTER_HTTP_HOST}:${port}/mcp`,
      oauth: config.PORTER_OAUTH_ISSUER ?? false,
    },
    'listening on http',
  );

  return {
    port,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function allowedHosts(config: BaseConfig): 'localhost' | string[] {
  if (LOOPBACK.has(config.PORTER_HTTP_HOST)) return 'localhost';
  if (config.PORTER_ALLOWED_HOSTS.length === 0) {
    throw new ConfigError(
      `PORTER_HTTP_HOST=${config.PORTER_HTTP_HOST} is not loopback, so PORTER_ALLOWED_HOSTS must list the public hostname(s) clients will use.`,
    );
  }
  return config.PORTER_ALLOWED_HOSTS;
}

function mcpRoute(config: BaseConfig): McpRoute {
  const { PORTER_OAUTH_ISSUER: issuer, PORTER_OAUTH_RESOURCE: resource } = config;
  if (!issuer && !resource) return { path: '/mcp' };
  if (!issuer || !resource) {
    throw new ConfigError(
      'Set PORTER_OAUTH_ISSUER and PORTER_OAUTH_RESOURCE together (or neither, for no auth).',
    );
  }
  const url = new URL(resource);
  if (url.pathname !== '/mcp') {
    throw new ConfigError(`PORTER_OAUTH_RESOURCE must be this server's /mcp URL; got ${resource}.`);
  }
  return {
    path: '/mcp',
    auth: {
      issuer,
      resource: url,
      ...(config.PORTER_OAUTH_JWKS_URL ? { jwksUrl: new URL(config.PORTER_OAUTH_JWKS_URL) } : {}),
      ...(config.PORTER_OAUTH_SCOPES.length
        ? {
            requiredScopes: config.PORTER_OAUTH_SCOPES,
            scopesSupported: config.PORTER_OAUTH_SCOPES,
          }
        : {}),
    },
  };
}

/**
 * Standard entry point for a server's bin: run `start`, shut down cleanly on signals,
 * and on startup failure print to stderr and exit non-zero. Claude Desktop shows that
 * stderr output in its MCP log, so the message has to be self-explanatory.
 */
export async function main(start: () => Promise<RunningServer>): Promise<void> {
  let running: RunningServer;
  try {
    running = await start();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const shutdown = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
