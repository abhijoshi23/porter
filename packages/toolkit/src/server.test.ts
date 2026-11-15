import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { baseConfigSchema, ConfigError, loadConfig } from './config.js';
import { defineTool } from './define-tool.js';
import { NotFoundError } from './errors.js';
import { silentLogger } from './logger.js';
import { runServer, serverFactory, type RunningServer, type ServerDefinition } from './server.js';
import { connectTestClient, ERAS, type TestClient } from './testing/client.js';

const lookup = defineTool({
  name: 'lookup_city',
  title: 'Look up a city',
  description: 'Returns the population of a known city.',
  input: z.object({ city: z.string() }),
  output: z.object({ city: z.string(), population: z.number() }),
  handler: async ({ city }) => {
    if (city !== 'Waterloo')
      throw new NotFoundError(`Unknown city "${city}".`, { hint: 'Try "Waterloo".' });
    return {
      data: { city, population: 121_436 },
      summary: 'Waterloo has 121,436 residents (2021 census).',
    };
  },
});

const crash = defineTool({
  name: 'crash',
  title: 'Always fails',
  description: 'Throws an unexpected error.',
  input: z.object({}),
  output: z.object({}),
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async () => {
    throw new Error('secret internal detail');
  },
});

const def: ServerDefinition = {
  name: 'porter-test',
  version: '1.2.3',
  instructions: 'Test server.',
  tools: [lookup, crash],
};

describe.each(ERAS)('server over the %s protocol', (era) => {
  let t: TestClient;
  afterEach(async () => t?.close());

  it('lists tools in registration order with safe-by-default annotations', async () => {
    t = await connectTestClient(serverFactory(def, silentLogger), era);
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name)).toEqual(['lookup_city', 'crash']);
    expect(tools[0]!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools[0]!.outputSchema).toMatchObject({ type: 'object' });
  });

  it('returns structured content plus a readable summary', async () => {
    t = await connectTestClient(serverFactory(def, silentLogger), era);
    const r = await t.client.callTool({ name: 'lookup_city', arguments: { city: 'Waterloo' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ city: 'Waterloo', population: 121436 });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^Waterloo has 121,436 residents/);
  });

  it('maps domain errors to recoverable tool results', async () => {
    t = await connectTestClient(serverFactory(def, silentLogger), era);
    const r = await t.client.callTool({ name: 'lookup_city', arguments: { city: 'Atlantis' } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain('Hint: Try "Waterloo".');
  });

  it('rejects invalid input before the handler runs', async () => {
    t = await connectTestClient(serverFactory(def, silentLogger), era);
    const r = await t.client.callTool({ name: 'lookup_city', arguments: { city: 42 } });
    expect(r.isError).toBe(true);
  });

  it('hides internals of unexpected errors', async () => {
    t = await connectTestClient(serverFactory(def, silentLogger), era);
    const r = await t.client.callTool({ name: 'crash', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).not.toContain('secret');
  });
});

describe('runServer over real HTTP', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  const start = async () => {
    const config = loadConfig(baseConfigSchema, {
      PORTER_TRANSPORT: 'http',
      PORTER_HTTP_PORT: '0',
    });
    running = await runServer(def, config, silentLogger);
    return `http://127.0.0.1:${running.port}`;
  };

  it('serves MCP on /mcp and health on /healthz', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    const client = new Client(
      { name: 't', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const r = await client.callTool({ name: 'lookup_city', arguments: { city: 'Waterloo' } });
    expect(r.structuredContent).toMatchObject({ population: 121436 });
    await client.close();
  });

  it('blocks DNS-rebinding: a foreign Host or Origin gets 403', async () => {
    const base = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const foreignOrigin = await fetch(`${base}/mcp`, {
      method: 'POST',
      body,
      headers: { ...headers, origin: 'https://evil.example' },
    });
    expect(foreignOrigin.status).toBe(403);
    // fetch() won't let us forge Host, so use node:http for that case.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/mcp`,
        { method: 'POST', headers: { ...headers, host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(403);
  });

  it('refuses to bind publicly without an allowed-hosts list', async () => {
    const config = loadConfig(baseConfigSchema, {
      PORTER_TRANSPORT: 'http',
      PORTER_HTTP_HOST: '0.0.0.0',
      PORTER_HTTP_PORT: '0',
    });
    await expect(runServer(def, config, silentLogger)).rejects.toBeInstanceOf(ConfigError);
  });

  it('requires a bearer token on /mcp when OAuth is configured', async () => {
    const config = loadConfig(baseConfigSchema, {
      PORTER_TRANSPORT: 'http',
      PORTER_HTTP_PORT: '0',
      PORTER_OAUTH_ISSUER: 'https://auth.example.com',
      PORTER_OAUTH_RESOURCE: 'http://localhost:3000/mcp',
    });
    running = await runServer(def, config, silentLogger);
    const base = `http://127.0.0.1:${running.port}`;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
    const meta = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(await meta.json()).toMatchObject({
      resource: 'http://localhost:3000/mcp',
      authorization_servers: ['https://auth.example.com'],
    });
  });

  it.each([
    [{ PORTER_OAUTH_ISSUER: 'https://auth.example.com' }, /together/],
    [{ PORTER_OAUTH_RESOURCE: 'https://mcp.example.com/mcp' }, /together/],
    [
      {
        PORTER_OAUTH_ISSUER: 'https://auth.example.com',
        PORTER_OAUTH_RESOURCE: 'https://mcp.example.com/other',
      },
      /\/mcp URL/,
    ],
  ])('rejects incomplete OAuth settings %#', async (env, message) => {
    const config = loadConfig(baseConfigSchema, {
      PORTER_TRANSPORT: 'http',
      PORTER_HTTP_PORT: '0',
      ...env,
    });
    await expect(runServer(def, config, silentLogger)).rejects.toThrow(message);
  });
});
