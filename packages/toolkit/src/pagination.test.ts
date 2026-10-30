import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { InvalidInputError } from './errors.js';
import { decodeCursor, encodeCursor, paginate, truncateRows } from './pagination.js';

describe('cursors', () => {
  it('round-trips state', () => {
    const schema = z.object({ o: z.number(), q: z.string() });
    expect(decodeCursor(schema, encodeCursor({ o: 20, q: 'transit' }))).toEqual({
      o: 20,
      q: 'transit',
    });
  });

  it.each(['not-base64!!', encodeCursor({ wrong: true }), encodeCursor('x')])(
    'rejects a bad cursor %#',
    (c) => {
      expect(() => decodeCursor(z.object({ o: z.number() }), c)).toThrow(InvalidInputError);
    },
  );
});

describe('paginate', () => {
  const all = Array.from({ length: 25 }, (_, i) => i);

  it('walks every page exactly once', () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = paginate(all, { cursor, limit: 10 });
      expect(page.total).toBe(25);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('omits nextCursor on the last page', () => {
    expect(paginate([1, 2], { limit: 10 }).nextCursor).toBeUndefined();
  });
});

describe('truncateRows', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `row ${i}` }));

  it('caps by row count', () => {
    const r = truncateRows(rows, { maxRows: 5, maxBytes: 1e6, refineHint: 'Add a filter.' });
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.note).toBe('Results truncated: showing 5 of 100. Add a filter.');
  });

  it('caps by serialized size', () => {
    const r = truncateRows(rows, { maxRows: 1000, maxBytes: 200, refineHint: '' });
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThanOrEqual(200);
    expect(r.truncated).toBe(true);
  });

  it('passes small results through untouched', () => {
    expect(truncateRows(rows.slice(0, 3), { maxRows: 10, maxBytes: 1e6, refineHint: '' })).toEqual({
      rows: rows.slice(0, 3),
      truncated: false,
    });
  });
});
