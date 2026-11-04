import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// Spawns the built binary the way Claude Desktop does. No network: nothing is connected.
describe('stdio binary (smoke)', () => {
  it('starts without credentials and lists tools', async () => {
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin],
        env: {
          LOG_LEVEL: 'silent',
          PORTER_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'porter-smoke-')),
        },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const r = await client.callTool({ name: 'who_owes_me', arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
  }, 20_000);

  it('prints help for the CLI and fails fast on bad config', () => {
    const help = spawnSync(process.execPath, [bin, 'help'], { env: {}, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('porter-quickbooks auth');
    const bad = spawnSync(process.execPath, [bin], {
      env: { QUICKBOOKS_ENVIRONMENT: 'live' },
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('QUICKBOOKS_ENVIRONMENT');
    expect(bad.stdout).toBe('');
  });
});
