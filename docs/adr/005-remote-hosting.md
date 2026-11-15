# ADR-005: Remote hosting and authorization

- Status: accepted
- Date: 2026-11-14
- Applies to: `apps/demo` (Cloudflare Worker), `packages/toolkit` (`createMcpFetchHandler`, `jwtVerifier`), HTTP mode of every server.

## Context

Porter's servers run locally over stdio. For people to try them without installing anything, there should be a public URL they can paste into Claude or Claude Code. Constraints:

- **$0.** Hosting and sign-in must be on free tiers (decisions log, cost plan).
- **Cloudflare Workers free tier.** Roughly 10 ms of CPU per request, no native modules, no persistent disk, and no I/O, timers or random values at module scope.
- **Stateless protocol.** In 2026-07-28 every request stands alone. A Worker can also land consecutive requests on different isolates.
- **Authorization spec.** An MCP server that requires sign-in is an OAuth 2.1 resource server. It publishes Protected Resource Metadata (RFC 9728), answers 401 with a `WWW-Authenticate` challenge that points at it, and accepts only tokens issued for itself (RFC 8707 audience).

## Decision

1. **One fetch-native HTTP handler.** The toolkit's `createMcpFetchHandler` serves a server definition as `fetch(Request) → Response`. Each request goes through health, then OAuth metadata, then the Host/Origin check, then the per-client rate limit, then the bearer token, then MCP. Node's HTTP mode wraps the same handler with `toNodeHandler`, so local HTTP and Workers behave identically and share their tests.
2. **Resource server only.** Porter never issues tokens (P3). `jwtVerifier` checks JWTs locally:
   - the signature against the issuer's published keys, found through RFC 8414 or OpenID discovery, where the metadata must name the same issuer;
   - `iss`, `aud` (this server's URL), and `exp`/`nbf`;
   - only asymmetric algorithms, so `alg: none` and HS256-with-a-public-key are refused.

   The challenge responses and the scope check come from the SDK (`requireBearerAuth`). Any provider that issues JWTs with a resource-bound `aud` works. WorkOS AuthKit is the default in the runbook.

3. **What the hosted demo serves.** Only code that fits the platform:
   - `porter-quickbooks` in demo mode;
   - `porter-opendata/remote`: catalogue search and metadata, plus StatCan series by table id.

   Left out are opendata's DuckDB SQL (a native module), StatCan table search (a 5 MB list, too much CPU per request), transit (`node:sqlite`) and tenders (tens of MB parsed in memory). Those stay local. The remote entry's import graph is tested never to reach DuckDB.

4. **Open by default, OAuth beside it.** `/quickbooks/mcp` and `/opendata/mcp` are open, so a reviewer can paste the URL and try them. `/quickbooks/mcp-auth` serves the same server behind OAuth once an issuer is configured. That shows the full spec flow without making every visitor sign in.
5. **A fresh sample company per request.** `serverFactory` accepts a function returning a definition. The demo builds a new QuickBooks sample company for each request, so one visitor's invoices or memos never reach the next. One `ConfirmationTokens` per isolate, keyed by the `PORTER_CONFIRM_SECRET` secret, is shared across those definitions, so a 2026 approval minted on one request verifies on the retry even if it lands on another isolate.
6. **Build at startup, not per request.** Building the app costs about 30 ms of CPU, so it happens at module scope, which has a separate and larger startup allowance. Two changes make that legal: `env` comes from `cloudflare:workers`, and `ConfirmationTokens` creates its key on first use instead of in the constructor.
7. **Best-effort rate limit.** It is a fixed window per client IP (`cf-connecting-ip`), 60 requests a minute per server by default. It lives in memory, so it caps a noisy client within one isolate, not a distributed one. Cloudflare's own DDoS protection sits in front of it.

## Consequences

- **Writes from 2025-era clients over HTTP are refused.** A 2025 client can't be asked anything mid-call over stateless HTTP, because there is no session to carry the question. With `QUICKBOOKS_REQUIRE_ELICITATION` on (ADR-004), such a client gets a refusal and nothing is created. This is tested end-to-end. 2026-07-28 clients get the approval prompt through `input_required`. Claude Code 2.1.323 showed the prompt (its headless mode declined it).
- **CPU.** In Node, a request uses about 1 ms of CPU at the median and 5–7 ms at the 95th percentile. `process.cpuUsage` counts the whole process, so this overstates a Worker. The Cloudflare dashboard's CPU-time chart is the real check after deploying.
- **Bundle.** 212 KiB gzipped, against a free-tier limit of 3 MB.
- **Tests.** The Worker is tested in the real runtime with Wrangler's `createTestHarness`, not `@cloudflare/vitest-pool-workers`, which needs Vitest 4 while the repo runs Vitest 5. The suite covers:
  - both protocol eras;
  - the 2026 approval round trip;
  - the per-request reset, which a deliberate mutation confirmed the tests catch;
  - OAuth against a fake issuer, and the rate limit.
- **Real books stay local.** Remote access to a real QuickBooks company would need each user's Intuit tokens stored server-side (KV or D1) and a second OAuth flow chained behind ours. That is left as a follow-up.

## Alternatives considered

- **Building the app on the first request.** This was the first version. It fit the global-scope rules but spent about 30 ms of CPU inside a request on every fresh isolate.
- **One shared sample company.** It is simpler, but visitors would see each other's test invoices, and anyone could leave text in them for the next person.
- **`@cloudflare/vitest-pool-workers`.** It would mean pinning Vitest 4 in one package of a Vitest 5 monorepo.
- **Porter's own authorization server** (for example `workers-oauth-provider`). That means more code that issues credentials, against P3. A hosted AS does dynamic client registration, CIMD, consent and key rotation for free.
- **OAuth on every route.** It is closer to a real deployment, but each person trying the demo would hit a sign-in wall.
- **Render or Fly for full servers.** They could run DuckDB and SQLite, but Fly no longer has a real free tier, and Render's free instances sleep and hold no persistent disk. They would be worth it only if the hosted demo had to include SQL or transit.
