import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { askUser, ConfirmationTokens, digest } from './confirm.js';
import { defineTool } from './define-tool.js';
import { silentLogger } from './logger.js';
import { serverFactory } from './server.js';
import { connectTestClient, ERAS, type TestClientOptions } from './testing/client.js';

describe('ConfirmationTokens', () => {
  it('verifies a token for its own purpose only', () => {
    const t = new ConfirmationTokens('a-secret-long-enough-for-hmac-keys');
    const token = t.mint('create:abc');
    expect(t.verify(token, 'create:abc')).toBe('ok');
    expect(t.verify(token, 'create:abd')).toBe('mismatch');
    expect(new ConfirmationTokens('another-secret').verify(token, 'create:abc')).toBe('mismatch');
  });

  it('expires', () => {
    let now = 1_000_000_000_000;
    const t = new ConfirmationTokens('s', { ttlSeconds: 60, now: () => now });
    const token = t.mint('p');
    now += 59_000;
    expect(t.verify(token, 'p')).toBe('ok');
    now += 2_000;
    expect(t.verify(token, 'p')).toBe('expired');
  });

  it('rejects tampering and garbage', () => {
    const t = new ConfirmationTokens(undefined);
    const token = t.mint('p');
    const [v, , nonce, mac] = token.split('.');
    // A later expiry with the old MAC fails.
    expect(t.verify(`${v}.zzzzzz.${nonce}.${mac}`, 'p')).toBe('mismatch');
    expect(t.verify('confirm', 'p')).toBe('malformed');
    expect(t.verify('', 'p')).toBe('malformed');
    expect(t.mint('p')).not.toBe(token); // nonce
  });
});

describe('digest', () => {
  it('ignores key order and undefined fields', () => {
    expect(digest({ a: 1, b: [{ y: 2, x: 1 }] })).toBe(digest({ b: [{ x: 1, y: 2 }], a: 1 }));
    expect(digest({ a: 1, c: undefined })).toBe(digest({ a: 1 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });
});

describe.each(ERAS)('askUser over the %s protocol', (era) => {
  const tokens = new ConfirmationTokens(undefined);
  let writes = 0;
  const tool = defineTool({
    name: 'write_thing',
    title: 'Write',
    description: 'Test write.',
    input: z.object({ amount: z.number() }),
    output: z.object({ outcome: z.string() }),
    annotations: { readOnlyHint: false },
    handler: async ({ amount }, ctx) => {
      const ask = await askUser(ctx, {
        message: `Write ${amount}?`,
        digest: digest({ amount }),
        tokens,
      });
      if (ask.status === 'pending') return ask.result;
      if (ask.status === 'confirmed') writes++;
      return { data: { outcome: ask.status }, summary: ask.status };
    },
  });
  const factory = serverFactory(
    { name: 't', version: '0', instructions: '', tools: [tool] },
    silentLogger,
  );

  const run = async (opts: TestClientOptions) => {
    const t = await connectTestClient(factory, era, opts);
    try {
      const r = await t.client.callTool({ name: 'write_thing', arguments: { amount: 42 } });
      if (r.isError) return 'error';
      return (r.structuredContent as { outcome: string }).outcome;
    } finally {
      await t.close();
    }
  };

  it('writes once the user accepts, showing them the message', async () => {
    const seen: string[] = [];
    const before = writes;
    const outcome = await run({
      onElicit: (p) => {
        seen.push(p.message);
        return { action: 'accept', content: { confirm: true } };
      },
    });
    expect(outcome).toBe('confirmed');
    expect(seen).toEqual(['Write 42?']);
    expect(writes).toBe(before + 1);
  });

  it('does not write when the user declines, unticks or dismisses', async () => {
    expect(await run({ onElicit: () => ({ action: 'decline' }) })).toBe('declined');
    expect(await run({ onElicit: () => ({ action: 'cancel' }) })).toBe('dismissed');
    expect(await run({ onElicit: () => ({ action: 'accept', content: { confirm: false } }) })).toBe(
      'declined',
    );
    // A malformed answer never counts as yes. The 2025 path has the SDK reject it against
    // the requested schema (a tool error); the 2026 path validates it in askUser.
    const before = writes;
    expect(['declined', 'error']).toContain(
      await run({ onElicit: () => ({ action: 'accept', content: { confirm: 'yes' } }) }),
    );
    expect(writes).toBe(before);
  });

  it('reports a client that cannot ask', async () => {
    expect(await run({})).toBe('unsupported');
  });
});
