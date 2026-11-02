# Security

Porter servers put external data and actions in front of AI models, so the threat model has two sides:

- **Hostile input reaching the model**, such as prompt injection hidden in data.
- **A steered model attacking the server or its host**, such as malicious SQL or tool arguments.

This document grows with each milestone.

## Principles

1. **Least privilege.** Tools are read-only by default (`defineTool` sets `readOnlyHint: true`). Write tools must opt out explicitly, default to `dryRun: true`, and need human confirmation (Milestone 6). The QuickBooks demo uses a sandbox company only.
2. **Model input is hostile.** Every tool argument is schema-validated. Values that reach a query, path or URL are checked again in the handler (dataset IDs are matched against a strict pattern; SQL goes through the sandbox below).
3. **Upstream text is untrusted.** See [Prompt injection](#prompt-injection).
4. **Fail closed.** Missing or invalid config stops startup with a readable error. HTTP mode on a public interface refuses to start without an allowed-hosts list.
5. **No secrets in logs.** Logs go to stderr, and Pino redacts `authorization`, `token`, `accessToken`, `refreshToken` and `apiKey` fields. HTTP fixtures keep only `content-type`, `retry-after`, `last-modified` and `etag` headers, so cookies are never committed.

## Prompt injection

Dataset descriptions, StatCan footnotes and, later, tender documents are written by third parties, and anyone who can edit a catalogue entry can write "ignore previous instructions…". Porter's defences:

| Layer                          | What it does                                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server `instructions`          | Tell the client that publisher-provided fields are external content: data, never instructions.                                                                                                                                                                                |
| Schema                         | External text appears only in fields documented as external (`description`, `footnotes`, cell values). Tool `summary` text is written by Porter and never copies external text.                                                                                               |
| `externalText()` (toolkit)     | Strips HTML, comments and scripts. Removes control, zero-width and bidi-override characters (used to hide text). Flattens markdown headings that could impersonate a "SYSTEM" section. Caps length (descriptions: 600 characters), which limits how much an attacker can say. |
| No side effects without humans | Read-only servers can't be steered into actions. Write tools (QuickBooks, Keel) need explicit human confirmation, so injected text alone can't trigger them.                                                                                                                  |

Tested in `packages/server-opendata/test/integration.test.ts` ("prompt injection in publisher text…") with a dataset whose description contains an HTML-comment "assistant" marker, a fake `## SYSTEM` heading, a zero-width character and an instruction to create an invoice.

**Limits:** none of this makes injection impossible. The model still reads sanitized external text. The point is to shrink the attack surface and make sure a successful injection can't do anything harmful.

## SQL sandbox (`query_resource`)

The model writes SQL that runs on the user's machine, so treat it as hostile. `CsvSandbox` (`packages/server-opendata/src/sql.ts`) applies, in order:

1. **Single statement.** DuckDB's own parser splits the input (`extractStatements`), and anything other than exactly one statement is refused. No regex guessing about semicolons inside strings.
2. **SELECT only.** The prepared statement type must be `SELECT` (CTEs are fine), so `INSERT`, `DELETE`, `COPY`, `ATTACH`, `INSTALL`, `SET`, `PRAGMA` and `CALL` are refused before running.
3. **Engine sandbox.** After the CSV is loaded: `SET enable_external_access = false` (no file, network or extension access, which blocks `read_csv('/etc/passwd')`, `glob`, `read_text` and `httpfs`), then `SET lock_configuration = true` so no query can undo it. Extension autoload and autoinstall are off.
4. **Resource limits.** An in-memory database, `memory_limit = 512MB`, 2 threads, and a wall-clock timeout via `interrupt()` (default 5 s).
5. **Row cap.** The query runs as a subquery with `LIMIT max+1`, so at most `PORTER_SQL_MAX_ROWS` rows are materialized. Results are also capped by serialized size.
6. **Isolation.** A fresh DuckDB instance per call, so nothing leaks between queries or datasets.

Tested by the attack suite in `packages/server-opendata/src/sql.test.ts`: stacked statements, DML, `COPY`, `ATTACH`, `INSTALL`, re-enabling external access, `PRAGMA`, local-file and network reads, `glob`, DML smuggled into a subquery, `getenv`, a runaway query, and a check that the data is intact afterwards. Layers overlap: for example, `COPY` is stopped by the engine sandbox when the statement is prepared, before the SELECT check even runs.

## Downloads

`DownloadCache` streams files to disk with a byte cap (`PORTER_MAX_DOWNLOAD_MB`, default 100). It checks `Content-Length` first and enforces the cap while streaming, because servers can lie. Writes go to a temp file and are renamed into place, so a crash never leaves a truncated file that looks valid. Cache filenames are URL hashes, never derived from upstream names, so there's no path traversal.

### GTFS archives (`porter-transit`)

Feeds are ZIP files from agency servers, read by a small built-in reader (`packages/server-transit/src/zip.ts`) rather than a dependency:

- **No zip slip.** Only the GTFS files we ask for are extracted, each to `<workdir>/<expected name>`. The path stored in the archive (which could be `../../x`) is never used as a destination.
- **No zip bombs.** Inflated bytes are counted while streaming and the extraction aborts past `PORTER_TRANSIT_MAX_UNZIPPED_MB` (default 1 GB). Declared sizes aren't trusted.
- **Integrity.** Each file's CRC-32 is checked. Encrypted entries, multi-disk archives and ZIP64 are refused.
- **Bad downloads don't stick.** If a download can't be unzipped or loaded (e.g. an HTML maintenance page served with status 200), it is dropped from the cache so the next call fetches again.
- **SQL is ours.** The schedule database is queried only with fixed, parameterized SQL; the model never writes SQL here. Values like stop IDs are bound as parameters.

### Realtime feeds

GTFS-Realtime is decoded by a bounds-checked protobuf reader: every length is checked against the enclosing message, truncated or malformed input raises a normal error (tested against every truncation of a valid message), and unknown fields are skipped. Alert text is publisher-written, so it goes through `externalText()` like any other external text. A realtime feed older than `PORTER_TRANSIT_REALTIME_MAX_AGE_S` is reported as stale and ignored, never shown as live.

## HTTP mode

- **DNS-rebinding protection:** `Host` and `Origin` are validated before the MCP handler. Loopback binds accept only localhost names, and public binds require `PORTER_ALLOWED_HOSTS`.
- **OAuth 2.1 resource-server mode:** Milestone 7.

## Supply chain

- Exact dependency versions (`save-exact`) and a committed lockfile installed with `--frozen-lockfile` in CI.
- Dependabot for npm and GitHub Actions. CodeQL on every push and weekly.
- npm provenance on publish (Changesets release workflow, `id-token: write`).
- Lint forbids invisible or irregular whitespace characters in source, including inside strings and regexes, and literal bidi control characters ("Trojan Source", CVE-2021-42574), so code can't display differently from how it runs.
