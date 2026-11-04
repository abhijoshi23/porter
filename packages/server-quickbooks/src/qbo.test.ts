import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient, silentLogger } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { customerSchema } from './entities.js';
import { QboClient } from './qbo.js';
import { CLIENT, fakeQuickBooks, NOW, REALM, sampleState } from './demo.js';
import { TokenStore } from './token-store.js';

const app = {
  clientId: CLIENT.id,
  clientSecret: CLIENT.secret,
  redirectUri: 'http://localhost:8723/callback',
};

async function setup() {
  const state = sampleState();
  const store = new TokenStore(
    mkdtempSync(join(tmpdir(), 'porter-qbo-')),
    'sandbox',
    CLIENT.secret,
  );
  await store.save({
    realmId: REALM,
    environment: 'sandbox',
    refreshToken: state.refreshToken,
    connectedAt: NOW,
  });
  const http = new HttpClient({
    userAgent: 't',
    log: silentLogger,
    fetch: fakeQuickBooks(state),
    sleep: async () => {},
  });
  const client = () =>
    new QboClient({ http, log: silentLogger, environment: 'sandbox', app, store, now: () => NOW });
  return { state, store, client };
}

describe('QboClient', () => {
  it('shares one refresh between concurrent calls', async () => {
    const { state, client } = await setup();
    const c = client();
    await Promise.all([1, 2, 3].map(() => c.query('Customer', customerSchema)));
    expect(state.calls.token).toBe(1);
  });

  it('picks up a refresh token another process rotated', async () => {
    const { state, store, client } = await setup();
    const a = client();
    const b = client();
    await b.connection();
    await a.query('Customer', customerSchema); // a rotates refresh-0 → refresh-1 and saves it
    // b still holds refresh-0 in memory; Intuit now rejects it.
    expect((b as unknown as { conn: { refreshToken: string } }).conn.refreshToken).toBe(
      'refresh-0',
    );
    const { rows } = await b.query('Customer', customerSchema);
    expect(rows.length).toBeGreaterThan(0);
    expect((await store.load())?.refreshToken).toBe(state.refreshToken);
  });

  it('asks for reauthorization when the grant is gone', async () => {
    const { state, client } = await setup();
    state.refreshToken = 'revoked-elsewhere';
    const err = await client()
      .query('Customer', customerSchema)
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/rejected the saved connection/);
    expect((err as { hint: string }).hint).toMatch(/porter-quickbooks auth/);
  });

  it('turns query faults into readable errors', async () => {
    const { client } = await setup();
    const err = await client()
      .query('Customer', customerSchema, { where: ['DisplayName LIKE x'] })
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/QuickBooks rejected the request: Error parsing query/);
  });
});
