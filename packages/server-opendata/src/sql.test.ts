import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsvSandbox } from './sql.js';

let db: CsvSandbox;
const limits = { maxRows: 50, timeoutMs: 2_000 };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'porter-sql-'));
  const csv = join(dir, 'cities.csv');
  await writeFile(
    csv,
    'City Name,year,rate\nWaterloo,2019,5.0\nHamilton,2019,4.9\nToronto,2019,6.1\nToronto,2020,9.6\n',
  );
  db = await CsvSandbox.open(csv);
});
afterAll(() => db.close());

describe('CsvSandbox: legitimate use', () => {
  it('describes inferred columns and counts rows', async () => {
    const d = await db.describe();
    expect(d.rowCount).toBe(4);
    expect(d.columns).toEqual([
      { name: 'City Name', type: 'VARCHAR' },
      { name: 'year', type: 'BIGINT' },
      { name: 'rate', type: 'DOUBLE' },
    ]);
  });

  it('runs aggregates, CTEs and a trailing semicolon', async () => {
    const r = await db.query(
      'WITH t AS (SELECT "City Name" AS city, max(rate) AS peak FROM data GROUP BY 1) SELECT * FROM t ORDER BY peak DESC;',
      limits,
    );
    expect(r.rows[0]).toEqual({ city: 'Toronto', peak: 9.6 });
    expect(r.hasMore).toBe(false);
  });

  it('caps rows and reports hasMore', async () => {
    const r = await db.query('SELECT * FROM data', { ...limits, maxRows: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.hasMore).toBe(true);
  });

  it('passes useful SQL errors through to the model', async () => {
    await expect(db.query('SELECT nope FROM data', limits)).rejects.toThrow(/SQL error: .*nope/);
  });
});

describe('CsvSandbox: hostile queries are refused', () => {
  const attacks: [string, string, RegExp][] = [
    ['stacked statements', 'SELECT 1; DROP TABLE data', /single SQL statement/],
    ['DELETE', 'DELETE FROM data', /read-only SELECT/],
    ['DROP', 'DROP TABLE data', /read-only SELECT/],
    // Caught by whichever layer fires first: the engine sandbox (at prepare time) or the SELECT-only check.
    [
      'COPY to disk',
      "COPY data TO '/tmp/porter-leak.csv'",
      /read-only SELECT|disabled by configuration/,
    ],
    ['ATTACH', "ATTACH '/tmp/x.db'", /read-only SELECT/],
    ['INSTALL extension', 'INSTALL httpfs', /read-only SELECT/],
    ['re-enable external access', 'SET enable_external_access = true', /read-only SELECT/],
    ['PRAGMA', 'PRAGMA database_list', /read-only SELECT|SQL error/],
    ['read local file', "SELECT * FROM read_csv('/etc/passwd')", /disabled by configuration/],
    ['read_text', "SELECT * FROM read_text('/etc/hosts')", /disabled by configuration/],
    ['glob filesystem', "SELECT * FROM glob('/*')", /disabled by configuration/],
    [
      'network fetch',
      "SELECT * FROM read_csv('https://example.com/a.csv')",
      /disabled by configuration/,
    ],
    ['sneak DML into a subquery', 'SELECT * FROM (DELETE FROM data RETURNING *)', /SQL error/],
    ['env access', "SELECT getenv('HOME')", /SQL error/],
  ];

  it.each(attacks)('%s', async (_label, sql, message) => {
    const err = await db.query(sql, limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message).toMatch(message);
  });

  it('kills runaway queries at the time limit', async () => {
    const started = Date.now();
    await expect(
      db.query('SELECT count(*) FROM range(100000000000)', { maxRows: 1, timeoutMs: 200 }),
    ).rejects.toThrow(/time limit/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still works after refusing attacks (data intact)', async () => {
    expect((await db.describe()).rowCount).toBe(4);
  });
});
