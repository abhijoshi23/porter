# Porter

**MCP servers that give AI assistants safe, well-designed access to Canadian public data, Ontario transit, federal tenders and small-business accounting.**

> 🚧 Early development. The toolkit, the open-data and transit servers, and the eval runner are done. See the [roadmap](#roadmap).

Porter is a monorepo of [Model Context Protocol](https://modelcontextprotocol.io) servers built on a shared toolkit. It targets the **2026-07-28** MCP spec with the v2 TypeScript SDK, and it still serves 2025-era clients such as Claude Desktop.

## Why another set of MCP servers?

Most existing servers wrap APIs one endpoint at a time; one Canadian-data server ships 266 tools. Porter designs a small number of **task-shaped tools**, and its eval suite measures whether models actually pick and chain them correctly. See [docs/mcp-notes.md](docs/mcp-notes.md) for the landscape.

## Packages

| Package                                           | Status       | What it does                                                                                                      |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`@abhijoshi23/porter-toolkit`](packages/toolkit) | ✅           | Server factory (stdio and Streamable HTTP), `defineTool`, resilient HTTP, pagination and truncation, test harness |
| [`porter-hello`](packages/server-hello)           | ✅ (example) | Reference server showing the patterns                                                                             |
| [`porter-opendata`](packages/server-opendata)     | ✅           | Ontario, Toronto and federal CKAN plus StatCan                                                                    |
| [`porter-transit`](packages/server-transit)       | ✅           | GTFS for GRT, HSR, TTC and GO, with realtime where open                                                           |
| [`porter-evals`](packages/evals)                  | ✅ (private) | Eval runner: Claude Code headless or Ollama drivers, deterministic checks, Markdown reports                       |
| `porter-tenders`                                  | Milestone 5  | CanadaBuys tender search and fit summaries                                                                        |
| `porter-quickbooks`                               | Milestone 6  | QuickBooks Online sandbox, with confirmed writes                                                                  |

## Evals

A model gets a real request ("When are the next buses at King and James in Hamilton?"), uses Porter's servers over MCP against live data, and deterministic checks score what it did. Checks cover the right tools and arguments, the call budget, and honesty about scheduled versus live times.

| Model                    | Passed          | Failed tool calls / task |
| ------------------------ | --------------- | ------------------------ |
| Claude Haiku             | **93%** (39/42) | 0.21 (baseline 0.71)     |
| qwen2.5-coder:7b (local) | 50% (7/14)      | 0.36                     |

The first run exposed two real bugs and five tool-design gaps; [tool-design.md](docs/tool-design.md#changelog-tool-names-descriptions-and-how-eval-scores-moved) records each finding, the change and how the numbers moved. Method and caveats: [docs/evals.md](docs/evals.md).

## Example

> **You:** How has unemployment in Kitchener–Cambridge–Waterloo changed since 2019?
>
> **Assistant** (via `statcan_find_table` → `statcan_get_table` → `statcan_get_series`): The seasonally adjusted unemployment rate (3-month moving average) rose from **5.0% in January 2019** to **7.7% in September 2026**. Source: Statistics Canada, Table 14-10-0459-01 (DOI 10.25318/1410045901-eng), Statistics Canada Open Licence.

> **You:** What's the first train from Kitchener to Union after 6 a.m.?
>
> **Assistant** (via `plan_simple_trip`): The next direct GO train leaves **Kitchener GO at 06:07** and arrives at **Union Station at 07:47** (1 h 40 min). This is the published schedule: GO doesn't offer open live predictions. Source: GO Transit open data (Metrolinx).

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
3. ✅ Transit server
4. ✅ Eval runner ([docs/evals.md](docs/evals.md))
5. Tenders server
6. QuickBooks server
7. Keel/Trillium adapters + remote deployment
8. Publish to npm, the MCP Registry and `.mcpb` bundles

## License

MIT
