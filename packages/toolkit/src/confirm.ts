import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ToolContext } from './define-tool.js';

/**
 * Human confirmation for write tools (ADR-004, mcp-notes.md P2).
 *
 * The model can put anything in a tool call, including `confirm: true`, so a flag alone
 * proves nothing. Two mechanisms, best first:
 *
 * 1. **Elicitation**: the server asks the *user* through the client UI. The model never
 *    sees the question or produces the answer.
 *    - 2026-07-28 clients: the tool returns `input_required` (multi round-trip request);
 *      the client asks the user and retries the same call with `inputResponses`.
 *    - 2025 clients: the server sends an `elicitation/create` request mid-call and waits.
 * 2. **Confirmation tokens**, for clients that can't elicit: the first call returns a
 *    preview plus an HMAC-signed token bound to that exact preview. Executing needs the
 *    token back with unchanged arguments. This can't prove a human looked; it proves the
 *    write is exactly what was previewed, and it relies on the client's own approval prompt
 *    for tool calls. Servers can refuse this fallback (`requireElicitation`).
 */

export type AskResult =
  | { status: 'confirmed' }
  /** The user said no (or unticked the box). */
  | { status: 'declined' }
  /**
   * The prompt was dismissed or never shown: the user closed it, or the client could not
   * show it (Claude Code in headless `-p` mode cancels every elicitation). Not a "no".
   */
  | { status: 'dismissed' }
  /** 2026 era: return this from the handler; the client asks and calls again. */
  | { status: 'pending'; result: InputRequiredResult }
  /** The client can't ask the user. Fall back to a confirmation token, or refuse. */
  | { status: 'unsupported' };

const answerSchema = z.object({
  confirm: z.boolean().describe('Tick to go ahead.'),
});

export interface AskOptions {
  /** Shown to the user. Say exactly what will happen, with the amounts. */
  message: string;
  /**
   * Digest of what is being confirmed (see `digest`). In the 2026 era the answer comes back
   * on a *new* request, so we bind it to the preview it was given for: if the preview changed
   * between rounds (a price was edited in the meantime), the user is asked again.
   */
  digest: string;
  tokens: ConfirmationTokens;
}

/** What the client said it supports. 2026 requests carry it per request; 2025 clients declare it once at initialize. */
export function clientCapabilities(ctx: ToolContext): ClientCapabilities | undefined {
  const envelope = ctx.mcp.mcpReq.envelope as Record<string, unknown> | undefined;
  if (envelope) return envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return ctx.legacyClientCapabilities();
}

function canElicitForm(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!e) return false;
  // `elicitation: {}` predates the form/url split and means form.
  return e.form !== undefined || e.url === undefined;
}

export async function askUser(ctx: ToolContext, o: AskOptions): Promise<AskResult> {
  if (!canElicitForm(clientCapabilities(ctx))) return { status: 'unsupported' };
  const req = ctx.mcp.mcpReq;

  if (req.envelope) {
    const answer = inputResponse(req.inputResponses, 'confirm');
    const state = req.requestState();
    // The answer only counts with the state we minted for this same preview.
    const bound = typeof state === 'string' && o.tokens.verify(state, `ask:${o.digest}`) === 'ok';
    if (answer.kind === 'elicit' && bound) {
      // Client-supplied: validate before trusting it.
      const parsed = answerSchema.safeParse(answer.content);
      if (answer.action === 'cancel') return { status: 'dismissed' };
      const yes = answer.action === 'accept' && parsed.success && parsed.data.confirm;
      return { status: yes ? 'confirmed' : 'declined' };
    }
    return {
      status: 'pending',
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({ message: o.message, requestedSchema: answerSchema }),
        },
        requestState: o.tokens.mint(`ask:${o.digest}`),
      }),
    };
  }

  const res = await req.elicitInput({
    mode: 'form',
    message: o.message,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', title: 'Go ahead', description: 'Tick to go ahead.' },
      },
      required: ['confirm'],
    },
  });
  if (res.action === 'cancel') return { status: 'dismissed' };
  return {
    status: res.action === 'accept' && res.content?.confirm === true ? 'confirmed' : 'declined',
  };
}

export type TokenCheck = 'ok' | 'expired' | 'mismatch' | 'malformed';

/**
 * Short-lived HMAC tokens bound to a purpose string (tool name plus a digest of the
 * normalized request). Stateless, so any replica with the same key can verify them, and
 * there is no server-side store to clean up.
 *
 * Format: `v1.<expiry seconds>.<nonce>.<mac>`, all base64url. The nonce makes each token
 * unique, so callers can derive an idempotency key from it.
 */
export class ConfirmationTokens {
  private readonly key: Buffer;

  /**
   * `secret` should be set when several processes serve one client (HTTP behind a load
   * balancer). Without it each process gets a random key, which is fine for stdio: one
   * process serves both calls.
   */
  constructor(
    secret: string | undefined,
    private readonly opts: { ttlSeconds?: number; now?: () => number } = {},
  ) {
    this.key = secret ? createHash('sha256').update(secret).digest() : randomBytes(32);
  }

  private now(): number {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  private mac(body: string, purpose: string): string {
    return createHmac('sha256', this.key).update(`${body}\0${purpose}`).digest('base64url');
  }

  mint(purpose: string): string {
    const exp = this.now() + (this.opts.ttlSeconds ?? 600);
    const body = `v1.${exp.toString(36)}.${randomBytes(12).toString('base64url')}`;
    return `${body}.${this.mac(body, purpose)}`;
  }

  verify(token: string, purpose: string): TokenCheck {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return 'malformed';
    const body = parts.slice(0, 3).join('.');
    const given = Buffer.from(parts[3]!, 'base64url');
    const want = Buffer.from(this.mac(body, purpose), 'base64url');
    if (given.length !== want.length || !timingSafeEqual(given, want)) return 'mismatch';
    if (parseInt(parts[1]!, 36) < this.now()) return 'expired';
    return 'ok';
  }
}

/**
 * Stable digest of a JSON value: object keys sorted, so `{a,b}` and `{b,a}` match. Use it on
 * the *resolved* request (ids, quantities, amounts), not on raw model input.
 */
export function digest(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canon(value)))
    .digest('base64url');
}
