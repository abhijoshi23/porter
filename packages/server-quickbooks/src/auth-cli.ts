import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Logger } from '@abhijoshi23/porter-toolkit';
import type { QuickBooksConfig } from './config.js';
import { companyInfoSchema } from './entities.js';
import { authorizeUrl, exchangeCode, refreshTokens, revoke, type OAuthApp } from './oauth.js';
import { QboClient } from './qbo.js';
import { createHttp, oauthApp, type QuickBooksOptions } from './server.js';
import { TokenStore, type Connection } from './token-store.js';

/**
 * `porter-quickbooks auth | status | logout`: one-time setup run by a person in a
 * terminal, separate from the MCP server (which must never print to stdout in stdio mode).
 */

export interface CliIO {
  out: (line: string) => void;
  /** Opens the consent page. Tests replace it with a fake browser. */
  openBrowser?: (url: string) => void;
}

const HELP = `Usage:
  porter-quickbooks                 Run the MCP server (stdio by default).
  porter-quickbooks auth            Connect a QuickBooks company (opens your browser).
  porter-quickbooks auth --realm <companyId> --refresh-token <token>
                                    Connect with a token from Intuit's OAuth 2.0 Playground instead.
  porter-quickbooks status          Show the saved connection.
  porter-quickbooks logout          Revoke the connection and delete it.

Needs QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET (developer.intuit.com → your app → Keys & credentials).
QUICKBOOKS_ENVIRONMENT=sandbox (default) or production.`;

function requireApp(config: QuickBooksConfig): OAuthApp {
  const app = oauthApp(config);
  if (!app) {
    throw new Error(
      'QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set.\n' +
        'Create a free app at https://developer.intuit.com (Dashboard → Create an app → QuickBooks Online and Payments), ' +
        `add ${config.QUICKBOOKS_REDIRECT_URI} as a redirect URI under the Development keys, and copy the keys.`,
    );
  }
  return app;
}

function defaultOpen(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // The URL is printed as well.
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;

/**
 * Waits on the redirect URI for Intuit to send the browser back with `code`, `state` and
 * `realmId` (the company id). Bound to loopback only; times out after five minutes.
 */
function waitForCallback(
  redirectUri: string,
  state: string,
  onListening: () => void,
): Promise<{ code: string; realmId: string }> {
  const u = new URL(redirectUri);
  const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
  if (!['127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `QUICKBOOKS_REDIRECT_URI must point at this machine (localhost), got ${u.host}.`,
    );
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const got = new URL(req.url ?? '/', redirectUri);
      if (got.pathname !== u.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string, body: string, err?: Error) => {
        res
          .writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
          .end(page(title, body));
        clearTimeout(timer);
        server.close();
        if (err) reject(err);
      };
      const p = got.searchParams;
      const s = Buffer.from(p.get('state') ?? '');
      const want = Buffer.from(state);
      // Another site could send the browser here with its own code (login CSRF); state stops that.
      if (s.length !== want.length || !timingSafeEqual(s, want)) {
        finish(
          400,
          'Not connected',
          'This link was not started by porter-quickbooks auth.',
          new Error('State mismatch: ignoring a callback this run did not start.'),
        );
        return;
      }
      if (p.get('error')) {
        finish(
          400,
          'Not connected',
          `QuickBooks said: ${p.get('error')}.`,
          new Error(`Authorization was not granted (${p.get('error')}).`),
        );
        return;
      }
      const code = p.get('code');
      const realmId = p.get('realmId');
      if (!code || !realmId || !/^\d+$/.test(realmId)) {
        finish(
          400,
          'Not connected',
          'The response from QuickBooks was incomplete.',
          new Error('Callback without code or realmId.'),
        );
        return;
      }
      finish(200, 'Connected', 'porter-quickbooks is connected. You can close this tab.');
      resolve({ code, realmId });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes waiting for the browser.'));
    }, 5 * 60_000);
    server.once('error', reject);
    server.listen(Number(u.port || 80), host, onListening);
  });
}

async function connected(o: QuickBooksOptions, store: TokenStore, conn: Connection, io: CliIO) {
  const qbo = new QboClient({
    http: createHttp(o),
    log: o.log,
    environment: o.config.QUICKBOOKS_ENVIRONMENT,
    app: requireApp(o.config),
    store,
    now: o.now ?? Date.now,
  });
  const info = await qbo.read('CompanyInfo', conn.realmId, companyInfoSchema);
  await store.save({ ...((await store.load()) ?? conn), companyName: info.CompanyName });
  io.out(
    `Connected to "${info.CompanyName}" (company ${conn.realmId}, ${o.config.QUICKBOOKS_ENVIRONMENT}).\n` +
      `Saved, encrypted, to ${store.path}.`,
  );
}

export async function runCli(
  args: string[],
  o: QuickBooksOptions & { log: Logger },
  io: CliIO,
): Promise<number> {
  const [cmd, ...rest] = args;
  const now = o.now ?? Date.now;
  const env = o.config.QUICKBOOKS_ENVIRONMENT;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(HELP);
    return 0;
  }

  if (env === 'demo') {
    io.out(
      'QUICKBOOKS_ENVIRONMENT=demo uses a built-in sample company: there is nothing to connect.',
    );
    return 0;
  }
  const app = requireApp(o.config);
  const store = new TokenStore(o.config.PORTER_CONFIG_DIR, env, app.clientSecret);
  const http = createHttp(o);

  if (cmd === 'auth') {
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const realm = flag('--realm');
    const refreshToken = flag('--refresh-token');
    if (realm || refreshToken) {
      if (!realm || !/^\d+$/.test(realm) || !refreshToken) {
        throw new Error('Give both --realm <companyId> (digits) and --refresh-token <token>.');
      }
      // Refresh straight away: it proves the token works and rotates it, so the copy left
      // in the Playground page or shell history stops being useful.
      const tokens = await refreshTokens(http, app, refreshToken, now());
      const conn: Connection = { realmId: realm, environment: env, ...tokens, connectedAt: now() };
      await store.save(conn);
      await connected(o, store, conn, io);
      return 0;
    }

    const state = randomBytes(24).toString('base64url');
    const url = authorizeUrl(app, state);
    const callback = waitForCallback(app.redirectUri, state, () => {
      io.out(
        `Opening QuickBooks to connect a ${env} company. If no browser opens, visit:\n\n  ${url}\n`,
      );
      (io.openBrowser ?? defaultOpen)(url);
    });
    const { code, realmId } = await callback;
    const tokens = await exchangeCode(http, app, code, now());
    const conn: Connection = { realmId, environment: env, ...tokens, connectedAt: now() };
    await store.save(conn);
    await connected(o, store, conn, io);
    return 0;
  }

  if (cmd === 'status') {
    const c = await store.load();
    if (!c) {
      io.out(`Not connected (${env}). Run: porter-quickbooks auth`);
      return 1;
    }
    const when = (ms?: number) =>
      ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown';
    io.out(
      [
        `Connected: ${c.companyName ?? '(name unknown)'} (company ${c.realmId}, ${c.environment})`,
        `Since: ${when(c.connectedAt)}`,
        `Refresh token valid until: ${when(c.refreshExpiresAt)} if unused (each use extends it)`,
        `File: ${store.path}`,
      ].join('\n'),
    );
    return 0;
  }

  if (cmd === 'logout') {
    const c = await store.load().catch(() => null);
    if (c) {
      try {
        await revoke(http, app, c.refreshToken);
      } catch (err) {
        io.out(
          `Could not revoke at Intuit (${(err as Error).message}); deleting the local copy anyway.`,
        );
      }
    }
    await store.clear();
    io.out(
      c
        ? `Disconnected ${c.companyName ?? c.realmId} and deleted ${store.path}.`
        : 'Nothing to disconnect.',
    );
    return 0;
  }

  io.out(HELP);
  return 2;
}
