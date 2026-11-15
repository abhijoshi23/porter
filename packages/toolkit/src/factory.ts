import { McpServer } from '@modelcontextprotocol/server';
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
 *
 * Pass a function instead of a definition to build a fresh one per request, e.g. a public
 * demo whose sample data must not carry over from one visitor to the next.
 */
export function serverFactory(
  source: ServerDefinition | (() => ServerDefinition),
  log: Logger,
): () => McpServer {
  return () => {
    const def = typeof source === 'function' ? source() : source;
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
