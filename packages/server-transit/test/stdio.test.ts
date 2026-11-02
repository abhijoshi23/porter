import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

// Spawns the built binary the way Claude Desktop does. Catches stray stdout writes and
// native-module (DuckDB) loading problems. No network: listing tools loads no feed.
describe('stdio binary (smoke)', () => {
  it('starts and lists tools', async () => {
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin],
        env: {
          LOG_LEVEL: 'silent',
          PORTER_CACHE_DIR: mkdtempSync(join(tmpdir(), 'porter-smoke-')),
        },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const r = await client.callTool({ name: 'list_agencies', arguments: {} });
    expect(JSON.stringify(r.structuredContent)).toContain('not_loaded');
    await client.close();
  }, 20_000);

  it('fails fast with a readable message on bad config', async () => {
    const { spawnSync } = await import('node:child_process');
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const r = spawnSync(process.execPath, [bin], {
      env: { PORTER_TRANSIT_AGENCIES: 'grt,mars' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mars');
    expect(r.stdout).toBe('');
  });
});
