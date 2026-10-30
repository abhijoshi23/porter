import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Errors a tool handler can throw. `defineTool` turns each one into a tool result with
 * `isError: true` instead of a JSON-RPC error.
 *
 * Why: the MCP spec splits failures into two kinds. *Protocol* errors (unknown tool,
 * malformed request) are JSON-RPC errors that the client surfaces to the host app.
 * *Tool execution* errors are ordinary results with `isError: true`, and the model reads
 * them. Upstream timeouts, 404s and bad filters are things the model can recover from
 * ("try a narrower date range"), so they must reach the model as results.
 */
export class PorterError extends Error {
  /** Guidance for the model on what to try next. Appended to the error text. */
  readonly hint: string | undefined;
  /** Whether repeating the same call later could succeed. */
  readonly retryable: boolean;

  constructor(message: string, opts: { hint?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
  }
}

/** The caller asked for something invalid that schema validation could not catch (a bad cursor, an unknown ID). */
export class InvalidInputError extends PorterError {}

export class NotFoundError extends PorterError {}

/** An upstream API answered with a non-2xx status. */
export class UpstreamError extends PorterError {
  readonly status: number;
  readonly host: string;

  constructor(host: string, status: number, opts: { hint?: string; cause?: unknown } = {}) {
    super(`${host} responded with HTTP ${status}.`, {
      hint: opts.hint ?? defaultHintForStatus(status),
      retryable: status === 429 || status >= 500,
      cause: opts.cause,
    });
    this.status = status;
    this.host = host;
  }
}

export class UpstreamTimeoutError extends PorterError {
  constructor(host: string, timeoutMs: number, cause?: unknown) {
    super(`${host} did not respond within ${timeoutMs} ms.`, {
      hint: 'The upstream service is slow or down. Retry shortly, or narrow the request.',
      retryable: true,
      cause,
    });
  }
}

function defaultHintForStatus(status: number): string {
  if (status === 404)
    return 'The resource does not exist. Check the ID, or search again to get a valid one.';
  if (status === 400 || status === 422)
    return 'The upstream rejected the parameters. Check filters and formats.';
  if (status === 401 || status === 403)
    return 'The server is not authorized for this resource. This is a configuration issue; tell the user.';
  if (status === 429) return 'Rate limited by the upstream. Wait a few seconds before retrying.';
  return 'The upstream service had a problem. Retry shortly.';
}

/**
 * Turns any thrown value into a tool result the model can read. Unknown errors are
 * reported generically so we never leak stack traces or internal details into the model's
 * context. The caller logs the full error to stderr.
 */
export function toToolErrorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof PorterError) {
    text = err.message;
    if (err.hint) text += `\nHint: ${err.hint}`;
    if (err.retryable) text += '\n(This error is temporary; retrying may succeed.)';
  } else {
    text =
      'Internal error while running this tool. Do not retry the same call; tell the user it failed.';
  }
  return { content: [{ type: 'text', text }], isError: true };
}
