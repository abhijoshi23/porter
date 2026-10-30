import { describe, expect, it } from 'vitest';
import { NotFoundError, toToolErrorResult, UpstreamError } from './errors.js';

const text = (r: ReturnType<typeof toToolErrorResult>) => (r.content[0] as { text: string }).text;

describe('toToolErrorResult', () => {
  it('includes message, hint and retry guidance for known errors', () => {
    const r = toToolErrorResult(new UpstreamError('data.ontario.ca', 503));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('data.ontario.ca responded with HTTP 503');
    expect(text(r)).toContain('Hint:');
    expect(text(r)).toContain('retrying may succeed');
  });

  it('omits retry guidance for permanent errors', () => {
    expect(text(toToolErrorResult(new NotFoundError('No such dataset.')))).not.toContain(
      'retrying',
    );
  });

  it('never leaks internals of unexpected errors', () => {
    const r = toToolErrorResult(new Error('ECONNRESET at /srv/secret/path.ts:42 token=abc'));
    expect(text(r)).not.toContain('secret');
    expect(text(r)).toContain('Internal error');
  });
});
