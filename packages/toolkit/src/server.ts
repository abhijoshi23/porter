import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { BaseConfig } from './config.js';
import { ConfigError } from './config.js';
import { registerTool, type ToolDefinition } from './define-tool.js';
import type { Logger } from './logger.js';

// Handlers are contravariant in their args, so a list of differently-typed tools needs `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any>;

export interface ServerDefinition {
  name: string;
  version: string;
  title?: string;
  /** Sent to the client and usually added to the model's system prompt. Say what the server is for and how its tools chain together. */
  instructions: string;
  /** Registered in this order, which keeps `tools/list` deterministic (a SHOULD in 2026-07-28, for prompt caching). */
  tools: AnyTool[];
  /** Hook for resources and prompts. */
  setup?: (server: McpServer, log: Logger) => void;
}

/** Tool lists only change when we ship a new version, so clients may cache them for an hour. */
const LIST_TTL_MS = 60 * 60 * 1000;

/**
 * Returns a factory that builds a fully registered `McpServer`.
 *
 * The SDK calls the factory **once per HTTP request** (2026-07-28 is stateless) and once
 * per stdio connection. Keep it cheap: shared state such as HTTP clients, caches and DB
 * handles belongs in module scope or in closures created outside the factory.
 */
export function serverFactory(def: ServerDefinition, log: Logger): () => McpServer {
  return () => {
    const server = new McpServer(
      { name: def.name, version: def.version, ...(def.title ? { title: def.title } : {}) },
      {
        instructions: def.instructions,
        cacheHints: {
          'tools/list': { ttlMs: LIST_TTL_MS, cacheScope: 'public' },
          'prompts/list': { ttlMs: LIST_TTL_MS, cacheScope: 'public' },
          'resources/templates/list': { ttlMs: LIST_TTL_MS, cacheScope: 'public' },
        },
      },
    );
    for (const tool of def.tools) registerTool(server, tool, log);
    def.setup?.(server, log);
    return server;
  };
}

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
  const factory = serverFactory(def, log);

  if (config.PORTER_TRANSPORT === 'stdio') {
    // serveStdio picks the protocol era from the client's first message. A 2025-era
    // `initialize` gets a classic session; a 2026 request with `_meta` gets the stateless path.
    const handle = serveStdio(factory, { onerror: (err) => log.error({ err }, 'stdio error') });
    log.info({ server: def.name, version: def.version }, 'listening on stdio');
    return { close: () => handle.close() };
  }

  const handler = createMcpHandler(factory, {
    onerror: (err) => log.warn({ err }, 'mcp http error'),
  });
  const nodeHandler = toNodeHandler(handler);
  const { validateHost, validateOrigin } = httpGuards(config);

  const http: HttpServer = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // DNS-rebinding defence. A malicious web page can point its own domain at
    // 127.0.0.1 and make the browser POST to our local server. The Host header then
    // carries the attacker's domain, so rejecting unknown hosts stops it. The SDK
    // handler does not do this itself.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.PORTER_HTTP_PORT, config.PORTER_HTTP_HOST, resolve);
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.PORTER_HTTP_PORT;
  log.info(
    { server: def.name, url: `http://${config.PORTER_HTTP_HOST}:${port}/mcp` },
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

function httpGuards(config: BaseConfig) {
  if (LOOPBACK.has(config.PORTER_HTTP_HOST)) {
    return { validateHost: localhostHostValidation(), validateOrigin: localhostOriginValidation() };
  }
  if (config.PORTER_ALLOWED_HOSTS.length === 0) {
    throw new ConfigError(
      `PORTER_HTTP_HOST=${config.PORTER_HTTP_HOST} is not loopback, so PORTER_ALLOWED_HOSTS must list the public hostname(s) clients will use.`,
    );
  }
  return {
    validateHost: hostHeaderValidation(config.PORTER_ALLOWED_HOSTS),
    validateOrigin: originValidation(config.PORTER_ALLOWED_HOSTS),
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
