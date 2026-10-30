import type { McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { toToolErrorResult } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Read-only by default (docs/tool-design.md). A tool that writes has to opt out explicitly.
 *
 * Annotations are *hints* for the client UI (for example, whether to show a confirmation
 * prompt). The SDK does not enforce them, and the spec tells clients not to trust them
 * from untrusted servers. Real safety for write tools lives in the handler: dryRun plus
 * confirmation (Milestone 6).
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
> {
  name: string;
  title: string;
  /** Say *when* to use it and *what it returns*, with units, formats and an example. */
  description: string;
  input: I;
  output: O;
  annotations?: Partial<ToolAnnotations>;
  handler: (args: z.output<I>, ctx: ToolContext) => Promise<ToolOutput<z.output<O>>>;
}

/**
 * Identity function that keeps the generic types tied together, so `handler` is checked
 * against `input` and `output`.
 */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
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
        const { data, summary } = await tool.handler(args, { log: toolLog, mcp });
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
