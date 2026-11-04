import {
  isInputRequiredResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { toToolErrorResult } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Read-only by default (docs/tool-design.md). A tool that writes has to opt out explicitly.
 *
 * Annotations are *hints* for the client UI (for example, whether to show a confirmation
 * prompt). The SDK does not enforce them, and the spec tells clients not to trust them
 * from untrusted servers. Real safety for write tools lives in the handler: a preview plus
 * confirmation (`confirm.ts`).
 */
const DEFAULT_ANNOTATIONS: Required<
  Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Most Porter tools talk to external public APIs.
  openWorldHint: true,
};

export interface ToolContext {
  log: Logger;
  /** The SDK's per-request context (auth info, HTTP request, MRTR input responses). */
  mcp: ServerContext;
  /** What a 2025-era client declared at initialize. Use `clientCapabilities(ctx)`, which covers both eras. */
  legacyClientCapabilities: () => ClientCapabilities | undefined;
}

export interface ToolOutput<O> {
  /** Validated against `output` and sent as `structuredContent`. */
  data: O;
  /** One or two sentences a person could read: what was found, plus any truncation note. */
  summary: string;
}

export interface ToolDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
  R extends ToolOutput<z.output<O>> | InputRequiredResult =
    ToolOutput<z.output<O>> | InputRequiredResult,
> {
  name: string;
  title: string;
  /** Say *when* to use it and *what it returns*, with units, formats and an example. */
  description: string;
  input: I;
  output: O;
  annotations?: Partial<ToolAnnotations>;
  /**
   * Returns the result, or (write tools on 2026-07-28 clients) an `input_required` result
   * from `askUser` so the client asks the user and calls again.
   */
  handler: (args: z.output<I>, ctx: ToolContext) => Promise<R>;
}

/**
 * Identity function that keeps the generic types tied together, so `handler` is checked
 * against `input` and `output`. `R` is inferred: a read-only tool's handler is typed as
 * returning plain `ToolOutput`, so tests can call it and read `.data` directly.
 */
export function defineTool<
  I extends z.ZodObject,
  O extends z.ZodObject,
  R extends ToolOutput<z.output<O>> | InputRequiredResult = ToolOutput<z.output<O>>,
>(def: ToolDefinition<I, O, R>): ToolDefinition<I, O, R> {
  return def;
}

/** Registers a tool on a server. Error mapping and result shaping happen here. */
export function registerTool(server: McpServer, tool: ToolDefinition, log: Logger): void {
  const toolLog = log.child({ tool: tool.name });
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      outputSchema: tool.output,
      annotations: { title: tool.title, ...DEFAULT_ANNOTATIONS, ...tool.annotations },
    },
    async (args, mcp) => {
      const started = performance.now();
      try {
        const out = await tool.handler(args, {
          log: toolLog,
          mcp,
          legacyClientCapabilities: () => server.server.getClientCapabilities(),
        });
        if (isInputRequiredResult(out)) {
          toolLog.info({ ms: Math.round(performance.now() - started) }, 'tool needs input');
          return out;
        }
        const { data, summary } = out;
        toolLog.info({ ms: Math.round(performance.now() - started) }, 'tool ok');
        return {
          // Many clients (including Claude Code today) put only `content` into the model's
          // context and ignore `structuredContent`. The spec says a tool with an output
          // schema SHOULD also return the serialized JSON as text, so we send the summary
          // and the JSON together in one text block.
          content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data)}` }],
          structuredContent: data,
        };
      } catch (err) {
        toolLog.warn({ err, ms: Math.round(performance.now() - started) }, 'tool failed');
        return toToolErrorResult(err);
      }
    },
  );
}
