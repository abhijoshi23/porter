import { DuckDBInstance, StatementType, type DuckDBConnection } from '@duckdb/node-api';
import { InvalidInputError, PorterError } from '@abhijoshi23/porter-toolkit';

export interface Column {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: Column[];
  rows: Record<string, unknown>[];
  /** True when more rows matched than `maxRows`. */
  hasMore: boolean;
}

/**
 * A throwaway, locked-down DuckDB holding one CSV as table `data`.
 *
 * The model writes the SQL, and the model may be steered by prompt injection, so treat
 * every query as hostile. Defences, outermost first:
 *
 * 1. **One statement only.** DuckDB's own parser splits the input (`extractStatements`).
 *    No regex guessing about semicolons inside strings.
 * 2. **SELECT only.** The prepared statement's type must be SELECT, so INSERT, COPY,
 *    ATTACH, PRAGMA, SET, INSTALL, CALL and friends are rejected before running.
 * 3. **Engine sandbox.** After loading the CSV we set `enable_external_access=false`
 *    (no file, network or extension access, which blocks `read_csv('/etc/passwd')`,
 *    `glob`, `httpfs` and ATTACH), then `lock_configuration=true` so a query cannot
 *    turn it back on.
 * 4. **Resource limits.** An in-memory database with a memory cap and 2 threads, plus a
 *    wall-clock timeout via `interrupt()`.
 * 5. **Row cap.** The query runs as a subquery with `LIMIT maxRows + 1`, so we never
 *    materialize more than we return.
 *
 * Each call gets a fresh instance, so no state leaks between queries or resources.
 */
export class CsvSandbox {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(csvPath: string): Promise<CsvSandbox> {
    const instance = await DuckDBInstance.create(':memory:', {
      threads: '2',
      memory_limit: '512MB',
      // Don't let DuckDB auto-install extensions (it would try the network).
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    });
    const conn = await instance.connect();
    try {
      // The path is ours (a hash under the cache dir), never model input, but quote it anyway.
      const path = csvPath.replace(/'/g, "''");
      await conn.run(
        `CREATE TABLE data AS SELECT * FROM read_csv('${path}', sample_size = 20000, ignore_errors = true, null_padding = true)`,
      );
    } catch (err) {
      conn.closeSync();
      instance.closeSync();
      throw new PorterError('This file could not be parsed as CSV.', {
        hint: 'The resource may be mislabelled or malformed. Try another resource of the dataset.',
        cause: err,
      });
    }
    await conn.run('SET enable_external_access = false');
    await conn.run('SET lock_configuration = true');
    return new CsvSandbox(instance, conn);
  }

  async describe(): Promise<{ columns: Column[]; rowCount: number }> {
    const cols = (await this.conn.runAndReadAll('DESCRIBE data')).getRowObjectsJson();
    const count = (
      await this.conn.runAndReadAll('SELECT count(*)::INTEGER AS n FROM data')
    ).getRowObjectsJson();
    return {
      columns: cols.map((c) => ({ name: String(c.column_name), type: String(c.column_type) })),
      rowCount: Number(count[0]?.n ?? 0),
    };
  }

  async query(sql: string, o: { maxRows: number; timeoutMs: number }): Promise<QueryResult> {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!trimmed) throw new InvalidInputError('The SQL query is empty.');

    let extracted;
    try {
      extracted = await this.conn.extractStatements(trimmed);
    } catch (err) {
      throw sqlError(err);
    }
    if (extracted.count !== 1) {
      throw new InvalidInputError('Only a single SQL statement is allowed.', {
        hint: 'Send one SELECT query without semicolon-separated statements.',
      });
    }
    let prepared;
    try {
      prepared = await extracted.prepare(0);
    } catch (err) {
      throw sqlError(err);
    }
    if (prepared.statementType !== StatementType.SELECT) {
      throw new InvalidInputError('Only read-only SELECT queries are allowed.', {
        hint: 'Rewrite as a SELECT over the table named "data" (WITH ... SELECT is fine).',
      });
    }

    const timer = setTimeout(() => this.conn.interrupt(), o.timeoutMs);
    try {
      const reader = await this.conn.runAndReadAll(
        `SELECT * FROM (${trimmed}) AS porter_q LIMIT ${o.maxRows + 1}`,
      );
      const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
      const names = reader.columnNames();
      const types = reader.columnTypes();
      return {
        columns: names.map((name, i) => ({ name, type: String(types[i]) })),
        rows: rows.slice(0, o.maxRows),
        hasMore: rows.length > o.maxRows,
      };
    } catch (err) {
      if (String(err).includes('Interrupted')) {
        throw new InvalidInputError(`The query exceeded the ${o.timeoutMs} ms time limit.`, {
          hint: 'Simplify the query: filter earlier, avoid cross joins, or aggregate.',
        });
      }
      throw sqlError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

/** DuckDB's error text is useful to the model (e.g. "column X not found; candidates: ..."), so pass the first line through. */
function sqlError(err: unknown): InvalidInputError {
  const first = String(err instanceof Error ? err.message : err)
    .split('\n')[0]!
    .slice(0, 300);
  return new InvalidInputError(`SQL error: ${first}`, {
    hint: 'The table is named "data". Call preview_resource to see column names and types.',
  });
}
