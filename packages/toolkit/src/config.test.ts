import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { baseConfigSchema, ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(baseConfigSchema, {});
    expect(c).toMatchObject({
      PORTER_TRANSPORT: 'stdio',
      PORTER_HTTP_PORT: 3000,
      PORTER_ALLOWED_HOSTS: [],
    });
  });

  it('parses comma-separated hosts and coerces numbers', () => {
    const c = loadConfig(baseConfigSchema, {
      PORTER_ALLOWED_HOSTS: 'a.example, b.example',
      PORTER_HTTP_PORT: '8080',
    });
    expect(c.PORTER_ALLOWED_HOSTS).toEqual(['a.example', 'b.example']);
    expect(c.PORTER_HTTP_PORT).toBe(8080);
  });

  it('lists every problem in one readable error', () => {
    const schema = baseConfigSchema.extend({ API_KEY: z.string().min(1) });
    try {
      loadConfig(schema, { PORTER_TRANSPORT: 'carrier-pigeon' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('PORTER_TRANSPORT');
      expect((err as Error).message).toContain('API_KEY');
      expect((err as Error).message).toContain('.env.example');
    }
  });
});
