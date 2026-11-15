/**
 * End-to-end: the real Worker bundle in the real Workers runtime (workerd, via Wrangler's
 * test harness), driven over HTTP by the real MCP client in both protocol eras.
 */
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createTestHarness, type TestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_URL = 'https://porter-demo.example.workers.dev';
const SECRET = 'test-confirm-secret-0123456789abcdef0123456789';

const baseVars = { RATE_LIMIT_PER_MINUTE: '0', LOG_LEVEL: 'warn' };
const worker = (vars: Record<string, string> = {}) => ({
  configPath: './wrangler.jsonc',
  vars: { ...baseVars, ...vars },
  secrets: { PORTER_CONFIRM_SECRET: SECRET },
});

let server: TestHarness;
let base: URL;

beforeAll(async () => {
  server = createTestHarness({ root, workers: [worker()] });
  base = (await server.listen()).url;
});
afterAll(async () => server?.close());

type Era = 'legacy' | { pin: '2026-07-28' };
const ERAS: [string, Era][] = [
  ['2025', 'legacy'],
  ['2026', { pin: '2026-07-28' }],
];

async function connect(path: string, era: Era, o: { approve?: boolean; token?: string } = {}) {
  const client = new Client(
    { name: 'porter-e2e', version: '0' },
    {
      versionNegotiation: { mode: era },
      ...(o.approve !== undefined ? { capabilities: { elicitation: { form: {} } } } : {}),
    },
  );
  if (o.approve !== undefined) {
    const approve = o.approve;
    client.setRequestHandler('elicitation/create', async () =>
      approve ? { action: 'accept', content: { confirm: true } } : { action: 'decline' },
    );
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, base), {
      ...(o.token ? { requestInit: { headers: { authorization: `Bearer ${o.token}` } } } : {}),
    }),
  );
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';
const invoice = { customer: '3', lines: [{ item: 'Pump', quantity: 4 }] };

describe('landing page and routing', () => {
  it('serves the landing page with the connect URLs', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain(`${base.origin}/quickbooks/mcp`);
    expect(html).not.toContain('mcp-auth'); // OAuth not configured here
  });

  it('answers health and 404s', async () => {
    expect(await (await fetch(new URL('/healthz', base))).text()).toBe('ok');
    expect((await fetch(new URL('/nope', base))).status).toBe(404);
  });
});

describe.each(ERAS)('QuickBooks demo over the %s protocol', (_name, era) => {
  it('lists the tools and answers from the sample company', async () => {
    const c = await connect('/quickbooks/mcp', era);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain('who_owes_me');
    const r = await c.callTool({ name: 'who_owes_me', arguments: { overdueOnly: true } });
    expect(text(r)).toMatch(/Bill's Windsurf Shop, \$600\.20/);
    await c.close();
  });

  it('refuses a write from a client that cannot ask the user, creating nothing', async () => {
    const c = await connect('/quickbooks/mcp', era);
    const r = await c.callTool({ name: 'create_invoice', arguments: invoice });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Nothing was created/);
    await c.close();
  });
});

describe('QuickBooks demo writes', () => {
  it('refuses a 2025 client even with elicitation: stateless HTTP has no way to ask it', async () => {
    let asked = 0;
    const c = await connect('/quickbooks/mcp', 'legacy', { approve: true });
    c.setRequestHandler('elicitation/create', async () => {
      asked++;
      return { action: 'accept', content: { confirm: true } };
    });
    const r = await c.callTool({ name: 'create_invoice', arguments: invoice });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/this connection cannot ask the user/);
    expect(asked).toBe(0);
    await c.close();
  });

  it('2026: asks the user, creates on yes, and forgets it on the next request', async () => {
    const c = await connect('/quickbooks/mcp', { pin: '2026-07-28' }, { approve: true });
    const r = await c.callTool({ name: 'create_invoice', arguments: invoice });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Created invoice 1101 for Cool Cars/);
    // A fresh sample company per request: nothing carries over to the next visitor.
    const after = await c.callTool({ name: 'find_invoices', arguments: { number: '1101' } });
    expect(text(after)).not.toMatch(/Cool Cars/);
    await c.close();
  });

  it('2026: creates nothing when the user declines', async () => {
    const c = await connect('/quickbooks/mcp', { pin: '2026-07-28' }, { approve: false });
    const r = await c.callTool({ name: 'create_invoice', arguments: invoice });
    expect(text(r)).toMatch(/did not approve/);
    await c.close();
  });
});

describe('open data (hosted)', () => {
  it('serves the disk-free tools only', async () => {
    const c = await connect('/opendata/mcp', { pin: '2026-07-28' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'search_datasets',
      'get_dataset',
      'statcan_get_table',
      'statcan_get_series',
    ]);
    await c.close();
  });
});

describe('DNS-rebinding guard', () => {
  it('rejects a Host the Worker was not configured for', async () => {
    const res = await server.fetch('http://evil.example/quickbooks/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('OAuth route and rate limit', () => {
  // A minimal authorization server: discovery metadata and a key set. Porter never issues tokens.
  let as: Server;
  let issuer: string;
  let priv: CryptoKey;
  let jwk: JWK;
  const RESOURCE = `${PUBLIC_URL}/quickbooks/mcp-auth`;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    priv = kp.privateKey;
    jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
    as = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      } else if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => as.listen(0, '127.0.0.1', r));
    const addr = as.address();
    issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    await server.update({
      root,
      workers: [worker({ PORTER_OAUTH_ISSUER: issuer, PUBLIC_URL, RATE_LIMIT_PER_MINUTE: '20' })],
    });
    base = (await server.listen()).url;
  });
  afterAll(async () => {
    await new Promise<void>((r) => as.close(() => r()));
    await server.update({ root, workers: [worker()] });
  });

  const sign = (aud = RESOURCE) =>
    new SignJWT({ scope: 'openid', client_id: 'claude' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(priv);

  it('challenges an anonymous client and publishes resource metadata', async () => {
    const res = await fetch(new URL('/quickbooks/mcp-auth', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/quickbooks/mcp-auth"`,
    );
    const meta = await fetch(
      new URL('/.well-known/oauth-protected-resource/quickbooks/mcp-auth', base),
    );
    expect(await meta.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [issuer],
    });
  });

  it('accepts a token from the authorization server, in the real runtime', async () => {
    const c = await connect('/quickbooks/mcp-auth', { pin: '2026-07-28' }, { token: await sign() });
    const r = await c.callTool({ name: 'who_owes_me', arguments: {} });
    expect(text(r)).toMatch(/open across/);
    await c.close();
  });

  it('rejects a token minted for another resource', async () => {
    await expect(
      connect(
        '/quickbooks/mcp-auth',
        { pin: '2026-07-28' },
        { token: await sign('https://other.example/mcp') },
      ),
    ).rejects.toThrow();
  });

  it('lists the OAuth route on the landing page once configured', async () => {
    expect(await (await fetch(base)).text()).toContain('/quickbooks/mcp-auth');
  });

  it('rate-limits a client that keeps calling', async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await fetch(new URL('/opendata/mcp', base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }),
      });
      if (res.status === 429) limited = res;
    }
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
