import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, silentLogger } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { runCli } from './auth-cli.js';
import { configSchema } from './config.js';
import { CLIENT, fakeQuickBooks, NOW, REALM, sampleState } from './demo.js';
import { TokenStore } from './token-store.js';

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function setup() {
  const state = sampleState();
  const dir = mkdtempSync(join(tmpdir(), 'porter-cli-'));
  const port = await freePort();
  const config = loadConfig(configSchema, {
    QUICKBOOKS_CLIENT_ID: CLIENT.id,
    QUICKBOOKS_CLIENT_SECRET: CLIENT.secret,
    QUICKBOOKS_REDIRECT_URI: `http://localhost:${port}/callback`,
    PORTER_CONFIG_DIR: dir,
  });
  const out: string[] = [];
  const opts = { config, log: silentLogger, fetch: fakeQuickBooks(state), now: () => NOW };
  const store = new TokenStore(dir, 'sandbox', CLIENT.secret);
  return { state, out, opts, store, io: { out: (l: string) => out.push(l) } };
}

/** Plays the browser: follows the consent URL straight back to the redirect URI. */
const browser =
  (answer: (state: string) => Record<string, string>) =>
  (url: string): void => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri')!);
    for (const [k, v] of Object.entries(answer(u.searchParams.get('state')!)))
      back.searchParams.set(k, v);
    void fetch(back).catch(() => {});
  };

describe('porter-quickbooks auth', () => {
  it('connects through the browser and saves an encrypted connection', async () => {
    const { out, opts, store, io } = await setup();
    let consent = '';
    const code = await runCli(['auth'], opts, {
      ...io,
      openBrowser: (url) => {
        consent = url;
        browser((state) => ({ code: 'good-code', state, realmId: REALM }))(url);
      },
    });
    expect(code).toBe(0);
    const u = new URL(consent);
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(out.join('\n')).toContain('Connected to "Porter Test Co"');
    const saved = await store.load();
    expect(saved).toMatchObject({
      realmId: REALM,
      companyName: 'Porter Test Co',
      refreshToken: 'refresh-1',
    });
  });

  it('ignores a callback with the wrong state', async () => {
    const { opts, store, io } = await setup();
    await expect(
      runCli(['auth'], opts, {
        ...io,
        openBrowser: browser(() => ({ code: 'good-code', state: 'forged', realmId: REALM })),
      }),
    ).rejects.toThrow(/State mismatch/);
    expect(await store.load()).toBeNull();
  });

  it('reports a denied consent', async () => {
    const { opts, io } = await setup();
    await expect(
      runCli(['auth'], opts, {
        ...io,
        openBrowser: browser((state) => ({ error: 'access_denied', state })),
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it('imports a Playground token, rotating it straight away', async () => {
    const { state, opts, store, io } = await setup();
    expect(await runCli(['auth', '--realm', REALM, '--refresh-token', 'refresh-0'], opts, io)).toBe(
      0,
    );
    expect(state.refreshToken).not.toBe('refresh-0');
    expect((await store.load())?.refreshToken).toBe(state.refreshToken);
    await expect(
      runCli(['auth', '--realm', 'abc', '--refresh-token', 'x'], opts, io),
    ).rejects.toThrow(/--realm/);
  });

  it('shows status and logs out (revoking at Intuit)', async () => {
    const { state, out, opts, store, io } = await setup();
    expect(await runCli(['status'], opts, io)).toBe(1);
    await runCli(['auth', '--realm', REALM, '--refresh-token', 'refresh-0'], opts, io);
    expect(await runCli(['status'], opts, io)).toBe(0);
    expect(out.join('\n')).toMatch(/Connected: Porter Test Co \(company 9341455555555, sandbox\)/);
    expect(await runCli(['logout'], opts, io)).toBe(0);
    expect(state.calls.revoke).toBe(1);
    expect(await store.load()).toBeNull();
  });

  it('explains how to get keys when they are missing', async () => {
    const config = loadConfig(configSchema, {});
    await expect(
      runCli(['auth'], { config, log: silentLogger }, { out: () => {} }),
    ).rejects.toThrow(/developer\.intuit\.com.*redirect URI/s);
  });
});
