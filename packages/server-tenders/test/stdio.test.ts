import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

// Spawns the built binary the way Claude Desktop does. No network: listing tools loads no data.
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
    expect(tools).toHaveLength(3);
    expect(client.getInstructions()).toContain('Eastern time');
    await client.close();
  }, 20_000);

  it('fails fast with a readable message on bad config', async () => {
    const { spawnSync } = await import('node:child_process');
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const r = spawnSync(process.execPath, [bin], {
      env: { PORTER_TENDERS_HISTORY_YEARS: 'lots' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PORTER_TENDERS_HISTORY_YEARS');
    expect(r.stdout).toBe('');
  });
});
