import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fixtures.js';

describe('createFixtureFetch', () => {
  let base: string;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res
      .writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=secret' })
      .end('{"hello":"world"}');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('records once, then replays without touching the network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'porter-fixtures-'));
    const recorded = await createFixtureFetch({ dir, mode: 'record' })(`${base}/api?q=1`);
    expect(await recorded.json()).toEqual({ hello: 'world' });
    expect(hits).toBe(1);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const saved = await readFile(join(dir, files[0]!), 'utf8');
    expect(saved).not.toContain('secret'); // cookies are not persisted

    const replayed = await createFixtureFetch({ dir, mode: 'replay' })(`${base}/api?q=1`);
    expect(await replayed.json()).toEqual({ hello: 'world' });
    expect(hits).toBe(1);
  });

  it('fails loudly when a fixture is missing in replay mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'porter-fixtures-'));
    await expect(createFixtureFetch({ dir, mode: 'replay' })(`${base}/other`)).rejects.toThrow(
      /PORTER_FIXTURES=record/,
    );
  });
});
