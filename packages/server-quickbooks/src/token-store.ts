import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';

/**
 * The QuickBooks connection: which company, plus OAuth tokens. The refresh token is a
 * long-lived credential to someone's books, so it is never written in the clear.
 *
 * - AES-256-GCM (authenticated: a tampered file fails to decrypt instead of decrypting to
 *   garbage).
 * - The key is derived with HKDF from the app's client secret and a random per-file salt.
 *   Nothing extra to manage, the file is useless without the secret (which lives in the
 *   client's MCP config or a password manager, not next to the file), and rotating the
 *   secret simply means connecting again.
 * - Written to a temp file then renamed (atomic), mode 0600.
 *
 * Intuit rotates refresh tokens: each refresh may return a new one and the old one then
 * stops working, so every refresh is saved before the new access token is used.
 */

export const connectionSchema = z.object({
  realmId: z.string().regex(/^\d+$/),
  environment: z.enum(['sandbox', 'production', 'demo']),
  refreshToken: z.string().min(1),
  /** Epoch ms. Rolling (extended on each refresh), and capped at five years by Intuit. */
  refreshExpiresAt: z.number().optional(),
  accessToken: z.string().optional(),
  accessExpiresAt: z.number().optional(),
  connectedAt: z.number(),
  companyName: z.string().optional(),
});
export type Connection = z.infer<typeof connectionSchema>;

const fileSchema = z.object({
  v: z.literal(1),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

const INFO = 'porter-quickbooks connection v1';

function keyFor(secret: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, INFO, 32));
}

export class TokenStoreError extends Error {
  override name = 'TokenStoreError';
}

/** Where the connection lives: an encrypted file, or memory for the demo company. */
export interface ConnectionStore {
  load(): Promise<Connection | null>;
  save(c: Connection): Promise<void>;
}

export class MemoryStore implements ConnectionStore {
  constructor(private c: Connection | null = null) {}
  async load() {
    return this.c;
  }
  async save(c: Connection) {
    this.c = c;
  }
}

export class TokenStore implements ConnectionStore {
  readonly path: string;

  constructor(
    dir: string,
    environment: 'sandbox' | 'production',
    private readonly secret: string,
  ) {
    this.path = join(dir, `quickbooks-${environment}.json`);
  }

  /** `null` when not connected yet. Throws TokenStoreError when the file can't be decrypted. */
  async load(): Promise<Connection | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const f = fileSchema.parse(JSON.parse(raw));
      const decipher = createDecipheriv(
        'aes-256-gcm',
        keyFor(this.secret, Buffer.from(f.salt, 'base64')),
        Buffer.from(f.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(f.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return connectionSchema.parse(JSON.parse(plain));
    } catch (err) {
      throw new TokenStoreError(
        `Could not read ${this.path}: it was saved with a different client secret, or it is damaged. Run \`porter-quickbooks auth\` to connect again.`,
        { cause: err },
      );
    }
  }

  async save(c: Connection): Promise<void> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFor(this.secret, salt), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(c), 'utf8'), cipher.final()]);
    const body = JSON.stringify({
      v: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600); // writeFile's mode is subject to umask
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
