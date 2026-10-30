import * as z from 'zod/v4';
import { InvalidInputError } from './errors.js';

/**
 * Cursors are opaque to the model: base64url-encoded JSON. The model only passes back
 * `nextCursor` verbatim, so the encoding can change without breaking any tool interface.
 * We still validate decoded cursors with a schema, because the model can and will send
 * garbage.
 */
export function encodeCursor(state: unknown): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(schema: S, cursor: string): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
}

function invalidCursor(): InvalidInputError {
  return new InvalidInputError('The cursor is invalid or expired.', {
    hint: 'Pass the exact `nextCursor` value from the previous result, or omit `cursor` to start over.',
  });
}

/** Reusable input fields for paginated tools. */
export const paginationInput = {
  cursor: z
    .string()
    .optional()
    .describe('Opaque `nextCursor` from a previous call. Omit for the first page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Results per page (1-50, default 10).'),
};

const offsetCursor = z.object({ o: z.number().int().min(0) });

export interface Page<T> {
  items: T[];
  /** Present when more results exist. */
  nextCursor?: string;
  total: number;
}

/** Offset pagination over an in-memory list (for example, search results already ranked locally). */
export function paginate<T>(
  all: readonly T[],
  opts: { cursor?: string | undefined; limit: number },
): Page<T> {
  const offset = opts.cursor ? decodeCursor(offsetCursor, opts.cursor).o : 0;
  const items = all.slice(offset, offset + opts.limit);
  const next = offset + items.length;
  return {
    items,
    total: all.length,
    ...(next < all.length ? { nextCursor: encodeCursor({ o: next }) } : {}),
  };
}

export interface Truncated<T> {
  rows: T[];
  truncated: boolean;
  /** Short sentence for the tool summary, e.g. "Showing 50 of 10,212 rows; add a WHERE clause to narrow it." */
  note?: string;
}

/**
 * Hard caps on what goes into the model's context: at most `maxRows` rows **and** at most
 * `maxBytes` of serialized JSON, whichever is hit first. Never send 10k rows to a model.
 * It burns the context window and answers get worse, not better.
 */
export function truncateRows<T>(
  rows: readonly T[],
  opts: { maxRows: number; maxBytes: number; refineHint: string },
): Truncated<T> {
  const out: T[] = [];
  let bytes = 2; // the surrounding "[]"
  for (const row of rows) {
    if (out.length >= opts.maxRows) break;
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes + size > opts.maxBytes) break;
    out.push(row);
    bytes += size;
  }
  if (out.length === rows.length) return { rows: out, truncated: false };
  return {
    rows: out,
    truncated: true,
    note: `Results truncated: showing ${out.length} of ${rows.length}. ${opts.refineHint}`,
  };
}
