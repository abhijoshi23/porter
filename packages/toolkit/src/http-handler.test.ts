import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  createLocalJWKSet,
  type CryptoKey,
  type JWK,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { defineTool } from './define-tool.js';
import { createMcpFetchHandler, type FetchHandlerOptions } from './http-handler.js';
import { silentLogger } from './logger.js';
import { jwtVerifier, type ResourceServerOptions } from './oauth.js';
import type { ServerDefinition } from './server.js';

const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description: 'Echoes the caller.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ data: { ok: true }, summary: 'ok' }),
});
const def: ServerDefinition = {
  name: 'porter-test',
  version: '1.0.0',
  instructions: 'Test.',
  tools: [whoami],
};

const ISSUER = 'https://auth.example.com';
const BASE = 'https://demo.example.com';
const RESOURCE = new URL(`${BASE}/mcp-auth`);

let priv: CryptoKey;
let jwk: JWK;
let otherPriv: CryptoKey;
beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  priv = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256' };
  otherPriv = (await generateKeyPair('ES256')).privateKey;
});

const sign = (
  claims: Record<string, unknown> = {},
  o: { key?: CryptoKey; exp?: string | number; kid?: string } = {},
) =>
  new SignJWT({ scope: 'mcp:tools', client_id: 'client-1', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: o.kid ?? 'k1' })
    .setIssuer((claims.iss as string) ?? ISSUER)
    .setAudience((claims.aud as string) ?? RESOURCE.href)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(o.key ?? priv);

const auth = (extra: Partial<ResourceServerOptions> = {}): ResourceServerOptions => ({
  issuer: ISSUER,
  resource: RESOURCE,
  keys: createLocalJWKSet({ keys: [jwk] }),
  scopesSupported: ['mcp:tools'],
  ...extra,
});

const handler = (o: Partial<FetchHandlerOptions> = {}) =>
  createMcpFetchHandler(def, silentLogger, {
    allowedHosts: ['demo.example.com'],
    routes: [{ path: '/mcp' }, { path: '/mcp-auth', auth: auth() }],
    ...o,
  });

const rpc = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      // Real requests carry Host (Node HTTP, Workers); a bare Request in Node does not.
      host: new URL(BASE).host,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const list = (path: string, headers?: Record<string, string>) =>
  rpc(path, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('createMcpFetchHandler', () => {
  it('serves MCP on an open route, health, and 404 elsewhere', async () => {
    const h = handler();
    const res = await h.fetch(list('/mcp'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"whoami"');
    expect(await (await h.fetch(new Request(`${BASE}/healthz`))).text()).toBe('ok');
    expect((await h.fetch(new Request(`${BASE}/nope`))).status).toBe(404);
  });

  it('hands unknown paths to the fallback', async () => {
    const h = handler({
      fallback: (_r, url) => (url.pathname === '/' ? new Response('hi') : undefined),
    });
    expect(await (await h.fetch(new Request(`${BASE}/`))).text()).toBe('hi');
    expect((await h.fetch(new Request(`${BASE}/x`))).status).toBe(404);
  });

  it('rejects a foreign Host or Origin (DNS rebinding)', async () => {
    const h = handler();
    const foreignHost = list('/mcp', { host: 'evil.example.net' });
    expect((await h.fetch(foreignHost)).status).toBe(403);
    expect((await h.fetch(list('/mcp', { origin: 'https://evil.example.net' }))).status).toBe(403);
    expect((await h.fetch(list('/mcp', { origin: BASE }))).status).toBe(200);
  });

  it('rate-limits per client and says when to retry', async () => {
    const h = handler({ rateLimit: { requests: 2, windowSeconds: 60 } });
    const from = (ip: string) => list('/mcp', { 'cf-connecting-ip': ip });
    expect((await h.fetch(from('1.1.1.1'))).status).toBe(200);
    expect((await h.fetch(from('1.1.1.1'))).status).toBe(200);
    const limited = await h.fetch(from('1.1.1.1'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.fetch(from('2.2.2.2'))).status).toBe(200);
  });

  it('refuses to start without an allowed host', () => {
    expect(() => handler({ allowedHosts: [] })).toThrow(/allowedHosts/);
  });
});

describe('OAuth resource-server route', () => {
  it('answers 401 with a challenge pointing at the resource metadata', async () => {
    const res = await handler().fetch(list('/mcp-auth'));
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://demo.example.com/.well-known/oauth-protected-resource/mcp-auth"',
    );
  });

  it('serves RFC 9728 metadata naming the resource and authorization server', async () => {
    const res = await handler().fetch(
      new Request(`${BASE}/.well-known/oauth-protected-resource/mcp-auth`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      resource: RESOURCE.href,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    });
  });

  it('accepts a valid token', async () => {
    const res = await handler().fetch(list('/mcp-auth', bearer(await sign())));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"whoami"');
  });

  it.each([
    ['expired', () => sign({}, { exp: Math.floor(Date.now() / 1000) - 120 }), /expired/],
    [
      'for another resource',
      () => sign({ aud: 'https://other.example.com/mcp' }),
      /not issued for this server/,
    ],
    ['from another issuer', () => sign({ iss: 'https://evil.example.com' }), /unexpected issuer/],
    ['signed with an unknown key', () => sign({}, { key: otherPriv }), /signature is invalid/],
    ['garbage', async () => 'not.a.jwt', /invalid/],
  ])('rejects a token %s', async (_name, make, message) => {
    const res = await handler().fetch(list('/mcp-auth', bearer(await make())));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error_description: string }).error_description).toMatch(
      message,
    );
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const none = `${b64({ alg: 'none' })}.${b64({ iss: ISSUER, aud: RESOURCE.href, exp: now + 300 })}.`;
    expect((await handler().fetch(list('/mcp-auth', bearer(none)))).status).toBe(401);
  });

  it('answers 403 insufficient_scope when a required scope is missing', async () => {
    const h = handler({
      routes: [{ path: '/mcp-auth', auth: auth({ requiredScopes: ['mcp:admin'] }) }],
    });
    const res = await h.fetch(list('/mcp-auth', bearer(await sign())));
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('does not require a token on the open route', async () => {
    expect((await handler().fetch(list('/mcp'))).status).toBe(200);
  });
});

describe('jwtVerifier key discovery', () => {
  const provider = (meta: Record<string, unknown>) => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return Response.json(meta);
      if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchFn, calls };
  };

  it('finds jwks_uri in the issuer metadata, then verifies', async () => {
    const { fetchFn, calls } = provider({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    const v = jwtVerifier({ issuer: ISSUER, resource: RESOURCE, fetch: fetchFn });
    const info = await v.verifyAccessToken(await sign());
    expect(info).toMatchObject({ clientId: 'client-1', scopes: ['mcp:tools'], resource: RESOURCE });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
    await v.verifyAccessToken(await sign());
    expect(calls.filter((c) => c.endsWith('authorization-server'))).toHaveLength(1);
  });

  it('ignores metadata that names a different issuer', async () => {
    const { fetchFn } = provider({
      issuer: 'https://evil.example.com',
      jwks_uri: `${ISSUER}/jwks`,
    });
    const v = jwtVerifier({ issuer: ISSUER, resource: RESOURCE, fetch: fetchFn });
    await expect(v.verifyAccessToken(await sign())).rejects.toMatchObject({ code: 'server_error' });
  });
});
