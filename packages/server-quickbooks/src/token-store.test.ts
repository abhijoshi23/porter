import { mkdtempSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenStore, TokenStoreError, type Connection } from './token-store.js';

const conn: Connection = {
  realmId: '123',
  environment: 'sandbox',
  refreshToken: 'AB11-super-secret-refresh',
  accessToken: 'eyJ-access',
  accessExpiresAt: 1,
  connectedAt: 2,
};

describe('TokenStore', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'porter-store-'));

  it('round-trips, encrypted at rest, owner-only', async () => {
    const s = new TokenStore(dir(), 'sandbox', 'secret-1');
    expect(await s.load()).toBeNull();
    await s.save(conn);
    expect(await s.load()).toEqual(conn);
    const raw = await readFile(s.path, 'utf8');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('123');
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect(s.path).toMatch(/quickbooks-sandbox\.json$/);
  });

  it('cannot be read with another client secret', async () => {
    const d = dir();
    await new TokenStore(d, 'sandbox', 'secret-1').save(conn);
    await expect(new TokenStore(d, 'sandbox', 'secret-2').load()).rejects.toBeInstanceOf(
      TokenStoreError,
    );
  });

  it('detects tampering', async () => {
    const s = new TokenStore(dir(), 'sandbox', 'secret-1');
    await s.save(conn);
    const f = JSON.parse(await readFile(s.path, 'utf8'));
    const bytes = Buffer.from(f.data, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(s.path, JSON.stringify({ ...f, data: bytes.toString('base64') }));
    await expect(s.load()).rejects.toThrow(/porter-quickbooks auth/);
  });

  it('keeps sandbox and production apart, and clears', async () => {
    const d = dir();
    await new TokenStore(d, 'sandbox', 's').save(conn);
    expect(await new TokenStore(d, 'production', 's').load()).toBeNull();
    const s = new TokenStore(d, 'sandbox', 's');
    await s.clear();
    expect(await s.load()).toBeNull();
  });
});
