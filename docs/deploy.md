# Deploying the hosted demo

The demo in [`apps/demo`](../apps/demo) is a Cloudflare Worker that serves:

| Route                  | What                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `/`                    | A landing page with the connect URLs                              |
| `/quickbooks/mcp`      | QuickBooks sample company, open                                   |
| `/opendata/mcp`        | Open-data catalogue search and StatCan series, open               |
| `/quickbooks/mcp-auth` | QuickBooks sample company behind OAuth 2.1 (optional, see part 2) |
| `/healthz`             | `ok`                                                              |

Everything here uses free tiers. Design and trade-offs: [ADR-005](adr/005-remote-hosting.md).

## Part 1: the open demo (Cloudflare only)

You need a free Cloudflare account. No credit card is required for Workers' free plan.

1. **Build** the packages the Worker imports:

   ```bash
   pnpm install
   pnpm build
   ```

2. **Log in** to Cloudflare once. It opens your browser:

   ```bash
   cd apps/demo
   npx wrangler login
   ```

3. **Find your workers.dev subdomain.** In the Cloudflare dashboard, go to **Workers & Pages**. The subdomain shows on the right (for example `you.workers.dev`). The Worker will live at `porter-demo.you.workers.dev`.

4. **Set the hostname** in [`apps/demo/wrangler.jsonc`](../apps/demo/wrangler.jsonc). Requests with any other `Host` are refused (DNS-rebinding guard).

   ```jsonc
   "ALLOWED_HOSTS": "porter-demo.you.workers.dev",
   "PUBLIC_URL": "https://porter-demo.you.workers.dev",
   ```

5. **Set the approval secret.** Without it, a 2026 client's invoice approval can fail when its retry lands on another isolate.

   ```bash
   openssl rand -base64 48 | npx wrangler secret put PORTER_CONFIRM_SECRET
   ```

6. **Deploy.** It's `run deploy`, because plain `pnpm deploy` is a different, built-in pnpm command:

   ```bash
   pnpm --filter @abhijoshi23/porter-demo run deploy
   ```

7. **Check it:**

   ```bash
   curl https://porter-demo.you.workers.dev/healthz        # ok
   claude mcp add --transport http porter-qb https://porter-demo.you.workers.dev/quickbooks/mcp
   ```

   Then ask Claude Code "Who owes me money?". In Claude on the web or desktop, go to **Settings → Connectors → Add custom connector** and paste the same URL.

8. **Watch CPU time.** In the dashboard, open **Workers & Pages → porter-demo → Metrics → CPU time**. The free plan allows about 10 ms per request. Local measurements were about 1 ms at the median (ADR-005). `npx wrangler tail` streams logs.

## Part 2: the OAuth route (WorkOS AuthKit)

This part is optional. It adds `/quickbooks/mcp-auth`, which needs a signed-in user. Porter only checks tokens: AuthKit handles sign-in, client registration and token issuing. Any provider that issues JWTs with `aud` set to the MCP URL works the same way (Auth0 with an API audience, or Keycloak).

1. **Create a WorkOS account** (free) and open **Authentication → AuthKit**. Note your AuthKit domain, for example `https://your-app-12345.authkit.app`. That's the issuer.
2. **Allow MCP clients to register.** Under the AuthKit **MCP** settings, enable dynamic client registration and/or Client ID Metadata Documents, so Claude can register itself.
3. **Register the resource.** Add `https://porter-demo.you.workers.dev/quickbooks/mcp-auth` as a **Resource Indicator** in the WorkOS dashboard.

   > [!IMPORTANT]
   > Without a Resource Indicator, AuthKit issues tokens with a default audience. Porter then rejects every token with "The access token was not issued for this server." That rejection is the RFC 8707 audience check working as designed.

4. **Configure the Worker** in `wrangler.jsonc`:

   ```jsonc
   "PUBLIC_URL": "https://porter-demo.you.workers.dev",
   "PORTER_OAUTH_ISSUER": "https://your-app-12345.authkit.app",
   ```

   The signing keys are found from the issuer's metadata (`jwks_uri`). Set `PORTER_OAUTH_JWKS_URL` only if your provider doesn't publish it.

5. **Deploy again** (part 1, step 6), then check it:

   ```bash
   # 401 with WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/quickbooks/mcp-auth"
   curl -i -X POST https://porter-demo.you.workers.dev/quickbooks/mcp-auth \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   curl https://porter-demo.you.workers.dev/.well-known/oauth-protected-resource/quickbooks/mcp-auth
   ```

   Add the `/quickbooks/mcp-auth` URL to Claude or Claude Code. The client should open AuthKit's sign-in page, then connect.

## Configuration

| Variable                | Kind   | Default | Meaning                                                                   |
| ----------------------- | ------ | ------- | ------------------------------------------------------------------------- |
| `ALLOWED_HOSTS`         | var    | (none)  | Hostnames clients use. `localhost` is always allowed (for `wrangler dev`) |
| `PUBLIC_URL`            | var    | (none)  | `https://` origin of the Worker; required with `PORTER_OAUTH_ISSUER`      |
| `PORTER_OAUTH_ISSUER`   | var    | (none)  | Turns on `/quickbooks/mcp-auth`                                           |
| `PORTER_OAUTH_JWKS_URL` | var    | (none)  | Signing keys, if the issuer's metadata doesn't list `jwks_uri`            |
| `PORTER_CONFIRM_SECRET` | secret | (none)  | Signs write approvals; set with `wrangler secret put`                     |
| `RATE_LIMIT_PER_MINUTE` | var    | `60`    | Per client IP, per server; `0` turns it off                               |
| `LOG_LEVEL`             | var    | `info`  | Logs go to `console`, visible in `wrangler tail`                          |

## Local development

```bash
pnpm build
pnpm --filter @abhijoshi23/porter-demo dev     # http://localhost:8787
pnpm --filter @abhijoshi23/porter-demo test    # the Worker in workerd, end to end
```

## What the hosted demo can't do

- **No writes from 2025-era clients over HTTP.** Such a client can't be asked to approve an invoice, so `create_invoice` refuses it and creates nothing. 2026-07-28 clients get the approval prompt. Reading always works.
- **No SQL over CSVs, StatCan table search, transit or tenders.** These need native modules, disk, or more CPU than the free tier allows. Run those servers locally.
- **No real QuickBooks books.** The hosted QuickBooks server only ever serves the sample company, and it resets on every request.
