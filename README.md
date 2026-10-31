# Porter

**MCP servers that give AI assistants safe, well-designed access to Canadian public data, Ontario transit, federal tenders and small-business accounting.**

> 🚧 Early development. The toolkit and the open-data server are done. See the [roadmap](#roadmap).

Porter is a monorepo of [Model Context Protocol](https://modelcontextprotocol.io) servers built on a shared toolkit. It targets the **2026-07-28** MCP spec with the v2 TypeScript SDK, and it still serves 2025-era clients such as Claude Desktop.

## Why another set of MCP servers?

Most existing servers wrap APIs one endpoint at a time; one Canadian-data server ships 266 tools. Porter designs a small number of **task-shaped tools**, and its eval suite measures whether models actually pick and chain them correctly. See [docs/mcp-notes.md](docs/mcp-notes.md) for the landscape.

## Packages

| Package                                           | Status       | What it does                                                                                                      |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`@abhijoshi23/porter-toolkit`](packages/toolkit) | ✅           | Server factory (stdio and Streamable HTTP), `defineTool`, resilient HTTP, pagination and truncation, test harness |
| [`porter-hello`](packages/server-hello)           | ✅ (example) | Reference server showing the patterns                                                                             |
| `porter-opendata`                                 | Milestone 2  | Ontario, Toronto and federal CKAN plus StatCan                                                                    |
| `porter-transit`                                  | Milestone 3  | GTFS for GRT, HSR, TTC and GO, with realtime where open                                                           |
| `porter-tenders`                                  | Milestone 5  | CanadaBuys tender search and fit summaries                                                                        |
| `porter-quickbooks`                               | Milestone 6  | QuickBooks Online sandbox, with confirmed writes                                                                  |

## Example

> **You:** How has unemployment in Kitchener–Cambridge–Waterloo changed since 2019?
>
> **Assistant** (via `statcan_find_table` → `statcan_get_table` → `statcan_get_series`): The seasonally adjusted unemployment rate (3-month moving average) rose from **5.0% in January 2019** to **7.7% in September 2026**. Source: Statistics Canada, Table 14-10-0459-01 (DOI 10.25318/1410045901-eng), Statistics Canada Open Licence.

## Toolkit at a glance

- **Both protocol eras**: stateless 2026-07-28, plus the 2025 `initialize` handshake for older clients. Every integration test runs under both.
- **Safe by default**: tools are read-only unless they opt out. Errors become model-readable `isError` results with hints, and internals never leak.
- **Context-friendly**: opaque cursors, plus hard row and byte caps with "refine your query" hints.
- **Resilient upstream calls**: per-host token-bucket rate limiting, timeouts, jittered retries that honour `Retry-After`.
- **DNS-rebinding protection** in HTTP mode (`Host`/`Origin` validation).
- **stdout is sacred**: logs go to stderr only, and lint forbids `console.log`.

Security details (SQL sandbox, prompt injection, download limits): [docs/security.md](docs/security.md).

## Development

Requires Node ≥ 22.13 (24 LTS recommended) and pnpm.

```bash
pnpm install
pnpm build && pnpm test      # unit + integration (both protocol eras) + stdio smoke tests
pnpm lint
```

### Try the hello server in MCP Inspector

```bash
pnpm build
pnpm --filter @abhijoshi23/porter-hello inspect
```

Or add it to Claude Code:

```bash
claude mcp add --transport stdio porter-hello -- node "$PWD/packages/server-hello/dist/bin.js"
```

## Roadmap

0. ✅ Research ([docs/mcp-notes.md](docs/mcp-notes.md))
1. ✅ Toolkit + CI
2. ✅ Open data server
3. Transit server
4. Eval runner
5. Tenders server
6. QuickBooks server
7. Keel/Trillium adapters + remote deployment
8. Publish to npm, the MCP Registry and `.mcpb` bundles

## License

MIT
