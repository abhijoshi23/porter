# MCP research notes (Milestone 0)

_Researched 2026-10-30. Re-check before each milestone; the protocol and SDKs move fast._

## 1. Spec: current version is `2026-07-28`

The current stable revision is **2026-07-28**, which replaced `2025-11-25`. It is the biggest protocol change since Streamable HTTP. All Tier-1 SDKs (TS, Python, Go, C#) supported it at release.

### What changed (and why Portage cares)

| Change                                                                                                                                                                                        | What it means                                                                              | Impact on Portage                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stateless core.** No `initialize` handshake, no `Mcp-Session-Id`. Every request carries its protocol version, client info and capabilities in `_meta`.                                      | A server is a pure request → response function. Any replica can serve any request.         | HTTP servers scale horizontally with no sticky sessions. Any cross-call state, such as a write-confirmation handle, has to be a **server-minted handle passed as a tool argument**. |
| **`server/discover`** (MUST implement)                                                                                                                                                        | Clients can ask for supported versions and capabilities up front.                          | The SDK handles it.                                                                                                                                                                 |
| **Multi Round-Trip Requests (MRTR).** A server that needs input mid-call returns `resultType: "input_required"` with `inputRequests`. The client retries the same call with `inputResponses`. | Replaces server-initiated `elicitation/create`, `sampling/createMessage` and `roots/list`. | This is how QuickBooks/Keel write confirmation is done "properly" (see §6).                                                                                                         |
| **`resultType` on every result** (`complete` / `input_required`)                                                                                                                              | Required field.                                                                            | The SDK handles it.                                                                                                                                                                 |
| **`subscriptions/listen`** replaces the HTTP GET stream and `resources/subscribe`                                                                                                             | One opt-in POST stream for list-changed and resource notifications.                        | Low priority. Could announce "GTFS feed refreshed".                                                                                                                                 |
| **SSE resumability removed** (`Last-Event-ID`)                                                                                                                                                | If a stream breaks, the client re-issues the request.                                      | Tools must be safe to retry. Read tools already are, and writes go through the confirm handle.                                                                                      |
| **`Mcp-Method` / `Mcp-Name` HTTP headers** required on POST                                                                                                                                   | Gateways and rate limiters can route without parsing JSON.                                 | Our per-tool rate limiter can key on headers.                                                                                                                                       |
| **Cacheable lists.** `ttlMs` + `cacheScope` on `tools/list`, `resources/list`, `resources/read`, etc.                                                                                         | Clients cache.                                                                             | Set sensible TTLs in `createServer()`.                                                                                                                                              |
| **Deterministic `tools/list` order** (SHOULD)                                                                                                                                                 | Better prompt-cache hit rates.                                                             | Register tools in a stable order.                                                                                                                                                   |
| **JSON Schema 2020-12** for `inputSchema` / `outputSchema`. `structuredContent` can be any JSON value.                                                                                        | Zod v4 → JSON Schema works cleanly.                                                        | —                                                                                                                                                                                   |
| **OTel trace context in `_meta`** (`traceparent`, `tracestate`, `baggage`)                                                                                                                    | Standard propagation.                                                                      | Wire it into toolkit tracing for HTTP mode.                                                                                                                                         |
| **Error codes.** Resource-not-found is now `-32602`. `-32020..-32099` are reserved for the spec.                                                                                              | —                                                                                          | Toolkit error mapping must use only `-32000..-32019` for app-defined codes. Prefer `isError: true` tool results for recoverable errors.                                             |
| **Tasks** moved to the extension `io.modelcontextprotocol/tasks` (poll with `tasks/get`, plus `tasks/update`)                                                                                 | Long-running work.                                                                         | Optional. Could be used for the first GTFS/StatCan bulk download.                                                                                                                   |
| **Extensions framework** (Tasks, MCP Apps, Enterprise Managed Auth)                                                                                                                           | —                                                                                          | Out of scope for now.                                                                                                                                                               |

### Authorization changes (relevant to remote HTTP and QuickBooks)

- The MCP server is an **OAuth 2.1 resource server**. It publishes Protected Resource Metadata (RFC 9728) pointing at an authorization server, validates audience-bound tokens (RFC 8707 resource indicators), and uses PKCE.
- **Client ID Metadata Documents (CIMD)** are now the preferred client registration. **Dynamic Client Registration is deprecated** but still allowed for backwards compatibility.
- Authorization servers SHOULD send `iss` (RFC 9207), and clients MUST validate it. Client credentials are bound to their issuer.

### Deprecated (12-month minimum window). Do not adopt.

- **Sampling.** The eval runner calls the LLM provider API directly, which the brief already planned.
- **Roots.** Pass paths as tool params or config.
- **Logging (`notifications/message`).** Log to stderr (stdio) and OTel (HTTP). The brief already does this with Pino → stderr.
- The HTTP+SSE transport and DCR, as described above.

### Tool annotations and structured output (unchanged since 2025, still core)

- Annotations: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. They are **hints for client UX only**. The SDK does not enforce them, so we enforce safety in our own code.
- `outputSchema` plus `structuredContent`. The SDK validates `structuredContent` against `outputSchema` before sending. Also return a short `content` text block for clients that ignore structured output.
- Input validation failures come back as `isError: true` tool results, so the model can read them and retry.

## 2. TypeScript SDK: use **v2**, not `@modelcontextprotocol/sdk`

| Package                                  | Latest (npm, 2026-10-30) | Role                                                                      |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `@modelcontextprotocol/server`           | **2.4.0**                | `McpServer`, `createMcpHandler`, `serveStdio`, `inputRequired`            |
| `@modelcontextprotocol/client`           | **2.4.0**                | `Client`, `StreamableHTTPClientTransport`, `InMemoryTransport`            |
| `@modelcontextprotocol/node`             | 2.1.2                    | `toNodeHandler`, `localhostHostValidation`, `localhostOriginValidation`   |
| `@modelcontextprotocol/express`, `/hono` | —                        | Framework adapters (optional)                                             |
| `@modelcontextprotocol/sdk`              | 1.32.2                   | **v1 line, legacy.** It implements 2025-era protocol only. Do not use it. |
| `@modelcontextprotocol/inspector`        | 2.13.0                   | Manual testing UI                                                         |

v2 is the stable line implementing 2026-07-28. It uses **Zod v4** (`import * as z from 'zod/v4'`). With TypeScript ≥ 6, add `"types": ["node"]` to tsconfig because `@types/*` is no longer auto-included.

### Shapes we'll build on (from the v2 docs)

```ts
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// stdio: factory returns a configured server
serveStdio(() => {
  const server = new McpServer({ name: 'porter-opendata', version: '0.1.0' });
  server.registerTool(
    'search_datasets',
    {
      title: 'Search open-data catalogues',
      description: '…',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(/* … */) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, ctx) => ({
      content: [{ type: 'text', text: 'Found 12 datasets…' }],
      structuredContent: { results: [] },
    }),
  );
  return server;
});

// Streamable HTTP: the factory runs ONCE PER REQUEST (stateless).
// Put caches, DB handles and rate limiters at module scope, not in the factory.
const handler = createMcpHandler(() => buildServer());
// Node: toNodeHandler(handler) behind localhostHostValidation()/OriginValidation()
// (the Host check is the DNS-rebinding defence; the handler does NOT check it itself).
```

- **Legacy clients:** the HTTP handler serves 2025-era clients from the same factory by default. For `input_required`, a legacy shim turns the result into a real `elicitation/create` for old clients (`ServerOptions.inputRequired.legacyShim`).
- **Testing:** `InMemoryTransport.createLinkedPair()` only speaks the **2025-era** protocol. To test the 2026-07-28 path in-process, call `handler.fetch(new Request(...))` directly. **The toolkit test harness should cover both**, which makes a good interview point.
- **Elicitation inside a tool (MRTR):**
  ```ts
  const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema);
  if (confirmed?.confirm !== true)
    return inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: schema }) },
    });
  ```
  If the client lacks the elicitation capability, the call fails with `-32021` (MissingRequiredClientCapability). **We must check client capabilities ourselves and fall back** to the dryRun/confirm-token flow.

## 3. Distribution

### Official MCP Registry (`registry.modelcontextprotocol.io`). **Still in preview.**

- The registry hosts metadata only, so publish to npm first.
- `package.json` needs `"mcpName": "io.github.<user>/<server>"`, which must equal `server.json` → `name`.
- `server.json` (schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`) lists `packages[]` (`registryType: "npm"`, `identifier`, `version`, `transport: {type:"stdio"}`, `environmentVariables[]` with `isSecret`) and/or `remotes[]` for HTTP endpoints.
- Use `mcp-publisher init | login github | publish`. GitHub auth forces the `io.github.<user>/` namespace, and DNS auth allows a custom domain. A GitHub Actions publishing flow exists, which we'll use in Milestone 8.

### Claude Desktop: MCP Bundles (`.mcpb`, formerly `.dxt`)

- A zip of the server plus `manifest.json`. Build it with `npm i -g @anthropic-ai/mcpb` (2.1.2), then `mcpb init` and `mcpb pack`.
- Node is preferred because Claude Desktop ships a Node runtime. Bundle production `node_modules`.
- `user_config` in the manifest prompts for secrets (API keys), and Desktop stores them securely.
- ⚠️ **Native dependencies (DuckDB, better-sqlite3) make bundles platform-specific.** See proposal P6.

### Claude Code

```bash
claude mcp add --transport stdio porter-transit -- npx -y @abhijoshi23/porter-transit
claude mcp add -e METROLINX_API_KEY=… --transport stdio porter-transit -- npx -y @abhijoshi23/porter-transit
claude mcp add --transport http porter-demo https://<host>/mcp       # remote
```

Scopes: `local` (default), `project` (writes `.mcp.json`, committed to git), `user`. `.mcp.json` supports `${VAR:-default}` expansion. We'll ship an `examples/.mcp.json`.

Cursor and VS Code use near-identical `mcpServers` JSON. Generate them in `examples/`.

## 4. Data sources (verified with live requests on 2026-10-30)

| Source                    | Endpoint                                                                               | Status                   | Notes                                                                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontario Data Catalogue    | `https://data.ontario.ca/api/3/action/*`                                               | ✅ CKAN, no key          |                                                                                                                                                                                                                                                                                                                      |
| City of Toronto           | `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/*`                       | ✅ CKAN, no key          | Some resources are only in the CKAN datastore (`datastore_search`)                                                                                                                                                                                                                                                   |
| Open Government (federal) | `https://open.canada.ca/data/api/3/action/*`                                           | ✅ CKAN, no key          | Bilingual fields                                                                                                                                                                                                                                                                                                     |
| StatCan WDS               | `https://www150.statcan.gc.ca/t1/wds/rest/*`                                           | ✅ no key                | `getAllCubesListLite` is ~5 MB, so cache it daily and search locally                                                                                                                                                                                                                                                 |
| CanadaBuys open tenders   | `https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv` | ✅ ~6 MB CSV             | 67 bilingual columns, **~888 open notices** today. Includes `tenderDescription`, `noticeURL`, `attachment`, `gsin`/`unspsc`, `procurementCategory` (e.g. `*CNST`, `*SRV`), `tenderClosingDate` (local ISO, no TZ). Descriptions contain HTML entities. Refresh cadence: confirm from `Last-Modified` in Milestone 5. |
| GRT static                | `https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1`                 | ✅ zip                   |                                                                                                                                                                                                                                                                                                                      |
| GRT realtime              | `…/api/grt-routes/api/tripupdates`, `…/vehiclepositions`                               | ✅ open protobuf         |                                                                                                                                                                                                                                                                                                                      |
| HSR static                | `https://opendata.hamilton.ca/GTFS-Static/google_transit.zip`                          | ✅                       |                                                                                                                                                                                                                                                                                                                      |
| HSR realtime              | `https://opendata.hamilton.ca/GTFS-RT/GTFS_TripUpdates.pb`                             | ✅ open                  |                                                                                                                                                                                                                                                                                                                      |
| TTC static                | Toronto CKAN `merged-gtfs-ttc-routes-and-schedules` (`completegtfs.zip`)               | ✅                       | Also `ttc-routes-and-schedules`. Use the merged one.                                                                                                                                                                                                                                                                 |
| TTC realtime              | `https://bustime.ttc.ca/gtfsrt/trips` (dataset `ttc-gtfs-realtime-gtfs-rt`)            | ✅ open                  | Old NextBus XML feed also exists. Ignore it.                                                                                                                                                                                                                                                                         |
| GO static                 | `https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip`  | ✅ ~12 MB                |                                                                                                                                                                                                                                                                                                                      |
| GO realtime               | `https://api.openmetrolinx.com/OpenDataAPI/…`                                          | 🔑 **401 without a key** | Needs Metrolinx Open Data registration and terms acceptance                                                                                                                                                                                                                                                          |

Licences: Open Government Licence – Ontario / – Toronto / – Canada and the Statistics Canada Open Licence. Each tool result should carry `licence` + `sourceUrl` (needed for the "cite table and licence" acceptance criterion).

## 5. Existing MCP servers and how Portage differs

The space is **busier than the brief assumes**. Portage's edge is the quality of its engineering, not being first.

| Area            | Existing                                                                                                                                                                                                                                                                                                                                                          | What they do                                                                                                                                                     | Portage's difference                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QuickBooks      | **[intuit/quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server)** (official, TS, stdio, ~145 tools)                                                                                                                                                                                                                               | CRUD across 29 entities plus 11 reports. Writes are gated only by env flags (`QUICKBOOKS_DISABLE_WRITE`…). No preview or confirm step. Tokens in a plain `.env`. | A **task-shaped "owner's assistant"** of about 6 tools: who owes me, AR aging, P&L, draft invoice. Writes need a preview, then MRTR elicitation or a signed confirm handle. Tokens are encrypted at rest. Remote OAuth-capable. Has evals. Pitch: "145 endpoint wrappers vs 6 tools an LLM actually uses correctly", with eval numbers to back it up. |
| StatCan / CKAN  | [ReyemTech/mcp-canada](https://github.com/ReyemTech/mcp-canada) (266 tools!), [Aryan-Jhaveri/mcp-statcan](https://github.com/aryan-jhaveri/mcp-statcan), [opendatafyi/openmcp](https://github.com/opendatafyi/openmcp), [neobenjax/CanData](https://github.com/neobenjax/Canadian-Open-Data-Agentic-Platform-MCP-Server), maplestats-mcp, pipeworx-io/mcp-statcan | Mostly 1:1 API wrappers. Several cover federal only.                                                                                                             | **Cross-portal** search across Ontario, Toronto and federal. **SQL over resources** in a sandboxed DuckDB. StatCan **suppression symbols and scalar factors handled**, plus a geography resolver (Waterloo city vs region vs CMA). Every answer carries a **licence and citation**. The tool-count contrast (6 vs 266) is the ADR-001 story.          |
| GTFS            | [jdamcd/gtfs-mcp](https://github.com/jdamcd/gtfs-mcp), [sandraschi/gtfs-mcp](https://github.com/sandraschi/gtfs-mcp), [cyanheads/transitland-mcp-server](https://github.com/cyanheads/transitland-mcp-server), a GO Transit server                                                                                                                                | Generic or global, or one agency at a time.                                                                                                                      | Ontario multi-agency **pre-configured**, with a one-transfer trip planner. Tested correctness for **after-midnight times, calendar exceptions and `America/Toronto` DST**. Realtime clearly labelled vs scheduled.                                                                                                                                    |
| Tenders         | [samarpassey/maple-procure](https://github.com/samarpassey/maple-procure) (Python, SQLite, provenance, two-call writes), [pipeworx-io/mcp-canada-tenders](https://github.com/pipeworx-io/mcp-canada-tenders) (hosted gateway)                                                                                                                                     | Search and provenance.                                                                                                                                           | **`summarize_tender_fit`** extracts structured fit fields (mandatory criteria, clearance, deadlines). FTS with GSIN/UNSPSC category mapping ("IT consulting" → codes). **Prompt-injection tests** on tender text. TypeScript. Evals.                                                                                                                  |
| Keel / Trillium | —                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                | Unique (your products).                                                                                                                                                                                                                                                                                                                               |

## 6. Proposed changes to the brief

**P1 — Target spec 2026-07-28 with SDK v2.** Use `@modelcontextprotocol/server` / `client` / `node` and Zod v4, not `@modelcontextprotocol/sdk`. Keep the default legacy support so Claude Desktop and other 2025-era clients still work.

**P2 — Make the confirmation pattern stateless.** Sessions are gone, so a write tool works like this:

1. The first call returns a preview plus a `confirmationToken`. The token is an HMAC-signed blob of {tool, normalized args hash, expiry ≈ 5 min}, minted by the server.
2. If the client supports elicitation, use MRTR `inputRequired.elicit` and ask the human directly.
3. Otherwise, a second call with `confirm: true` plus a matching token executes the write.

The token is needed because `confirm: true` alone could be produced by the model without human involvement. This becomes ADR-004. It is also retry-safe now that SSE resumability is gone.

**P3 — Remote auth: be a resource server only.** Do not build our own authorization server. Use a hosted AS (WorkOS AuthKit, Auth0, Stytch, or Keycloak if self-hosted) that supports **CIMD** and PKCE. Our server implements Protected Resource Metadata plus audience-checked JWT validation. Less code, fewer security bugs, and it matches the spec.

**P4 — Drop deprecated features from the plan.** No Sampling, Roots or Logging. Use the `resources` + `subscriptions/listen` combination only where it adds value.

**P5 — Toolkit test harness covers both protocol eras.** Use `InMemoryTransport` (2025) **and** `handler.fetch` (2026-07-28). Run the integration tests against both.

**P6 — Native deps vs `.mcpb`.** DuckDB (`@duckdb/node-api`) and SQLite native bindings make per-platform bundles. Options:

- (a) per-OS `.mcpb` builds in a CI matrix;
- (b) use `node:sqlite` (built into Node 22+, no native dep) for caches, GTFS and tenders FTS5, and keep DuckDB **only** in `server-opendata` for `query_resource`.

I recommend **(b)**. It removes DuckDB from 4 of the 5 data servers, and SQLite is better than DuckDB for GTFS point lookups and FTS anyway.

**P7 — GO Transit realtime is opt-in.** It needs a Metrolinx API key, so GO is scheduled-only unless `METROLINX_API_KEY` is set. GRT, HSR and TTC realtime are open and enabled by default.

**P8 — Tenders index is small** (~900 open notices). Use SQLite FTS5 rather than DuckDB. Also ingest the "new/amended" notices file so we can say "this tender closed / was amended" (needed for the "already-closed tender" eval).

**P9 — Sharpen the pitch around the competition.** README and ADR-001 should explicitly compare Portage with the official Intuit server and mcp-canada on tool count vs eval task-success. That gives the evals a concrete story.

**P10 — Scope / sequencing (optional).** Seven servers is a lot. I suggest treating Keel/Trillium as a stretch, so the core portfolio is toolkit + opendata + transit + evals + tenders + QuickBooks. Order unchanged.

## 7. Decisions (resolved 2026-10-30)

The name is **Porter**, the GitHub user is `abhijoshi23`, and the project must cost **$0**. The eval runner uses Claude Code headless or Ollama, and the demo is hosted on the Cloudflare Workers free tier. P1–P10 are adopted. See `decisions-log.md`.

Wherever these notes say "Portage", read **Porter**.
