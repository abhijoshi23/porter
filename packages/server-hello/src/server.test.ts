import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serverFactory, silentLogger } from '@abhijoshi23/porter-toolkit';
import { connectTestClient, ERAS, type TestClient } from '@abhijoshi23/porter-toolkit/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, getCity, listCities } from './server.js';

const ctx = { log: silentLogger, mcp: {} as never };

describe('list_cities (unit)', () => {
  it('filters by region, case-insensitively', async () => {
    const r = await listCities.handler({ region: 'waterloo', limit: 10 }, ctx);
    expect(r.data.cities.map((c) => c.id)).toEqual(['kitchener', 'waterloo', 'cambridge']);
    expect(r.data.nextCursor).toBeUndefined();
  });

  it('paginates', async () => {
    const first = await listCities.handler({ limit: 5 }, ctx);
    expect(first.data.cities).toHaveLength(5);
    expect(first.summary).toContain('pass nextCursor');
    const second = await listCities.handler({ limit: 5, cursor: first.data.nextCursor }, ctx);
    expect(second.data.cities).toHaveLength(3);
  });
});

describe('get_city (unit)', () => {
  it('points the model back to list_cities on an unknown id', async () => {
    await expect(getCity.handler({ id: 'atlantis' }, ctx)).rejects.toMatchObject({
      hint: expect.stringContaining('list_cities'),
    });
  });
});

describe.each(ERAS)('porter-hello over the %s protocol', (era) => {
  let t: TestClient;
  afterEach(async () => t?.close());

  it('chains list_cities -> get_city', async () => {
    t = await connectTestClient(serverFactory(definition, silentLogger), era);
    const list = await t.client.callTool({ name: 'list_cities', arguments: { region: 'Peel' } });
    const ids = (list.structuredContent as { cities: { id: string }[] }).cities.map((c) => c.id);
    expect(ids).toEqual(['mississauga', 'brampton']);
    const one = await t.client.callTool({ name: 'get_city', arguments: { id: ids[0] } });
    expect(one.structuredContent).toMatchObject({ name: 'Mississauga', population: 717961 });
  });
});

// Spawns the built binary like Claude Desktop would. Proves nothing writes to stdout but the protocol.
describe('stdio binary (smoke)', () => {
  it('serves tools over stdio', async () => {
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin],
        env: { LOG_LEVEL: 'silent' },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_cities', 'get_city']);
    await client.close();
  }, 15_000);
});
