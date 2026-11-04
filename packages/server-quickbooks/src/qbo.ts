import {
  InvalidInputError,
  NotFoundError,
  PorterError,
  type HttpClient,
  type Logger,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';
import { ReauthorizeError, refreshTokens, type OAuthApp } from './oauth.js';
import { TokenStoreError, type Connection, type ConnectionStore } from './token-store.js';

export const API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
  // Never reaches the network: the demo's fetch answers it in memory.
  demo: 'https://sandbox-quickbooks.api.intuit.com',
} as const;

/**
 * Intuit retired minor versions 1-74 on 2025-08-01; anything lower is now ignored and
 * answered as 75. Sent explicitly so the response shape doesn't move under us.
 */
export const MINOR_VERSION = '75';

/** Query pages are capped at 1000 rows by QuickBooks. */
const PAGE = 1000;
/** Most rows one query may pull in total; a small business is far below this. */
const MAX_ROWS = 10_000;

export class NotConnectedError extends PorterError {
  constructor(reason: string) {
    super(`QuickBooks is not connected: ${reason}`, {
      hint: 'Tell the user to set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET and run `porter-quickbooks auth` once in a terminal (see the porter-quickbooks README).',
    });
  }
}

const faultSchema = z.object({
  Fault: z.object({
    Error: z
      .array(
        z.looseObject({
          Message: z.string().optional(),
          Detail: z.string().optional(),
          code: z.string().optional(),
        }),
      )
      .default([]),
    type: z.string().optional(),
  }),
});

export interface QboOptions {
  http: HttpClient;
  log: Logger;
  environment: 'sandbox' | 'production' | 'demo';
  /** Missing when the client id or secret isn't configured. */
  app: OAuthApp | undefined;
  store: ConnectionStore | undefined;
  now: () => number;
}

/**
 * QuickBooks Online Accounting API v3 for one connected company. Handles access-token
 * refresh (an hour each), rotating refresh tokens, query paging and Intuit's error format.
 */
export class QboClient {
  private conn: Connection | null = null;
  private refreshing: Promise<Connection> | null = null;

  constructor(private readonly o: QboOptions) {}

  get environment() {
    return this.o.environment;
  }

  /** The saved connection, loaded once. */
  async connection(): Promise<Connection> {
    if (this.conn) return this.conn;
    if (!this.o.app || !this.o.store) {
      throw new NotConnectedError('QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET are not set.');
    }
    let c: Connection | null;
    try {
      c = await this.o.store.load();
    } catch (err) {
      if (err instanceof TokenStoreError) throw new NotConnectedError(err.message);
      throw err;
    }
    if (!c) throw new NotConnectedError(`no saved connection for ${this.o.environment}.`);
    this.conn = c;
    return c;
  }

  private async accessToken(force: boolean): Promise<{ token: string; realmId: string }> {
    const c = await this.connection();
    if (!force && c.accessToken && (c.accessExpiresAt ?? 0) > this.o.now()) {
      return { token: c.accessToken, realmId: c.realmId };
    }
    // Single flight: concurrent tool calls share one refresh. Two refreshes racing with the
    // same refresh token can leave us holding a rotated-away one.
    this.refreshing ??= this.refresh(c).finally(() => {
      this.refreshing = null;
    });
    const fresh = await this.refreshing;
    return { token: fresh.accessToken!, realmId: fresh.realmId };
  }

  private async refresh(c: Connection): Promise<Connection> {
    const app = this.o.app!;
    const store = this.o.store!;
    let tokens;
    try {
      tokens = await refreshTokens(this.o.http, app, c.refreshToken, this.o.now());
    } catch (err) {
      // Another process (a second client running this server) may have rotated the token
      // and saved the new one. Pick it up and try once more.
      const onDisk = err instanceof ReauthorizeError ? await store.load().catch(() => null) : null;
      if (!onDisk || onDisk.refreshToken === c.refreshToken) throw err;
      this.o.log.info('refresh token was rotated by another process; using the saved one');
      tokens = await refreshTokens(this.o.http, app, onDisk.refreshToken, this.o.now());
    }
    const next: Connection = { ...c, ...tokens };
    await store.save(next); // before use: the old refresh token may already be dead
    this.conn = next;
    return next;
  }

  /**
   * One API call. A 401 means the access token was revoked or expired early: refresh once
   * and repeat. Errors come back as Intuit "Fault" bodies, which say what was wrong.
   */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const { token, realmId } = await this.accessToken(attempt > 0);
      const u = new URL(`${API_BASE[this.o.environment]}/v3/company/${realmId}/${path}`);
      u.search = new URLSearchParams({ ...params, minorversion: MINOR_VERSION }).toString();
      const res = await this.o.http.request(u, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        returnErrors: true,
      });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = undefined;
      }
      const fault = faultSchema.safeParse(json);
      if (res.ok && !fault.success && json !== undefined) return json;
      throw this.toError(res.status, fault.success ? fault.data : null, path);
    }
  }

  private toError(status: number, fault: z.infer<typeof faultSchema> | null, path: string) {
    const first = fault?.Fault.Error[0];
    // Intuit's own wording; it may quote values from the books, so keep it short.
    const said = [first?.Message, first?.Detail]
      .filter(Boolean)
      .join(': ')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    this.o.log.warn(
      { status, path, fault: fault?.Fault.type, code: first?.code },
      'quickbooks error',
    );
    if (status === 401) return new ReauthorizeError('HTTP 401 after refreshing');
    if (status === 403) {
      return new PorterError(`QuickBooks refused access (HTTP 403)${said ? `: ${said}` : ''}.`, {
        hint: 'The connected user may lack permission for this, or the company subscription does not include it. Tell the user.',
      });
    }
    if (status === 429) {
      return new PorterError('QuickBooks rate limit reached.', {
        hint: 'Wait a few seconds before retrying.',
        retryable: true,
      });
    }
    if (status >= 500) {
      return new PorterError(`QuickBooks had a problem (HTTP ${status}).`, { retryable: true });
    }
    if (fault?.Fault.type === 'ValidationFault' || status === 400) {
      if (first?.code === '610') return new NotFoundError(`QuickBooks: ${said || 'not found'}.`);
      return new InvalidInputError(
        `QuickBooks rejected the request: ${said || `HTTP ${status}`}.`,
        {
          hint: 'Check the ids and values against find_customers / find_items, then try again.',
        },
      );
    }
    return new PorterError(`QuickBooks returned HTTP ${status}${said ? `: ${said}` : ''}.`);
  }

  /**
   * Runs a QuickBooks query (their SQL-like language) and pages through all results.
   * `where` and `orderBy` are built by our code from validated ids and dates only, never
   * from free text: names are matched locally after fetching.
   */
  async query<S extends z.ZodType>(
    entity: string,
    schema: S,
    opts: { where?: string[]; orderBy?: string } = {},
  ): Promise<{ rows: z.output<S>[]; capped: boolean }> {
    const rows: z.output<S>[] = [];
    const where = opts.where?.length ? ` WHERE ${opts.where.join(' AND ')}` : '';
    const order = opts.orderBy ? ` ORDERBY ${opts.orderBy}` : '';
    for (let start = 1; ; start += PAGE) {
      const q = `SELECT * FROM ${entity}${where}${order} STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
      const json = (await this.call('GET', 'query', { query: q })) as {
        QueryResponse?: Record<string, unknown>;
      };
      const page = json.QueryResponse?.[entity];
      const list = Array.isArray(page) ? page : [];
      for (const raw of list) {
        const parsed = schema.safeParse(raw);
        if (parsed.success) rows.push(parsed.data);
        else this.o.log.warn({ entity, issues: parsed.error.issues.slice(0, 3) }, 'skipped row');
      }
      if (list.length < PAGE) return { rows, capped: false };
      if (rows.length >= MAX_ROWS) return { rows, capped: true };
    }
  }

  async read<S extends z.ZodType>(entity: string, id: string, schema: S): Promise<z.output<S>> {
    // Singletons (Preferences) have no id in the path.
    const path = id ? `${entity.toLowerCase()}/${encodeURIComponent(id)}` : entity.toLowerCase();
    const json = (await this.call('GET', path)) as Record<string, unknown>;
    return schema.parse(json[entity]);
  }

  async report(name: string, params: Record<string, string>): Promise<unknown> {
    return this.call('GET', `reports/${name}`, params);
  }

  /**
   * Creates an entity. `requestId` makes the create idempotent on Intuit's side: the same id
   * again returns the original result instead of a duplicate (max 50 characters, unique per
   * company), so a retry after a dropped connection can't double-invoice.
   */
  async create<S extends z.ZodType>(
    entity: string,
    body: unknown,
    requestId: string,
    schema: S,
  ): Promise<z.output<S>> {
    const json = (await this.call(
      'POST',
      entity.toLowerCase(),
      { requestid: requestId.slice(0, 50) },
      body,
    )) as Record<string, unknown>;
    return schema.parse(json[entity]);
  }

  /** The web app link for a transaction, for the user to open. */
  appUrl(kind: 'invoice', id: string): string {
    const host = {
      sandbox: 'app.sandbox.qbo.intuit.com',
      production: 'app.qbo.intuit.com',
      demo: 'quickbooks.demo.invalid', // nothing to open: the invoice exists only in memory
    }[this.o.environment];
    return `https://${host}/app/${kind}?txnId=${encodeURIComponent(id)}`;
  }
}
