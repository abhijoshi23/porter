import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentLogger } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { createOpendataRemoteServer } from './remote.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Local imports reachable from a module, following relative `.js` specifiers. */
function importGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(join(here, entry.replace(/\.js$/, '.ts')), 'utf8');
  for (const m of src.matchAll(/from '\.\/([\w-]+\.js)'/g)) importGraph(m[1]!, seen);
  return seen;
}

describe('remote (hosted) open-data server', () => {
  it('has the disk-free tools only', () => {
    const def = createOpendataRemoteServer({ log: silentLogger });
    expect(def.tools.map((t) => t.name)).toEqual([
      'search_datasets',
      'get_dataset',
      'statcan_get_table',
      'statcan_get_series',
    ]);
    expect(def.instructions).toMatch(/SQL over CSV files is not available here/);
  });

  it('never imports DuckDB, directly or through another module', () => {
    const graph = importGraph('remote.js');
    expect(graph).not.toContain('sql.js');
    expect(graph).not.toContain('sql-tools.js');
    for (const f of graph) {
      expect(readFileSync(join(here, f.replace(/\.js$/, '.ts')), 'utf8')).not.toMatch(/@duckdb/);
    }
  });
});
