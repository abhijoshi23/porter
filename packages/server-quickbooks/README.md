# porter-quickbooks

An MCP server for **QuickBooks Online**, shaped around what a small-business owner asks: who owes me, how did we do last month, and invoice this customer. It is six task-shaped tools instead of a wrapper per API endpoint, and the one tool that writes **never creates anything until the user approves it**.

Try it with no Intuit account: `QUICKBOOKS_ENVIRONMENT=demo` serves a built-in sample company.

## Tools

| Tool              | Use it to…                                                                                                      | Example prompt                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `who_owes_me`     | See receivables by customer, most overdue first, with aging buckets, the oldest invoices and contact emails     | "Who should I chase for payment?"                   |
| `profit_and_loss` | Read income, costs and net income for a period, optionally compared with the previous period or the year before | "How did we do last month compared with September?" |
| `find_invoices`   | List invoices by customer, status and date, or open one by number with its lines                                | "What's on invoice 1037? Is it paid?"               |
| `find_customers`  | Look up customers by name, with balance and email                                                               | "What does Amy's Bird Sanctuary owe?"               |
| `find_items`      | Look up products and services with their default prices                                                         | "What do we charge for design?"                     |
| `create_invoice`  | Create an invoice, **after the user approves it**. It is not emailed to the customer                            | "Invoice Amy for 3 hours of design"                 |

The tools can't email, record payments, edit or delete anything.

**Prompt:** `month_end_review` compares last month with the month before and lists who to chase first.

### How writes are confirmed

The model can put anything in a tool call, including `confirm: true`, so a flag proves nothing. `create_invoice` first resolves the customer, items and prices into the exact invoice it would send, then gets approval in the best way the client supports:

1. **The client asks the user** (MCP elicitation). The user sees the invoice in the client's own UI and approves or declines; the model never sees the question and can't answer it.
   - 2026-07-28 clients: the tool returns `input_required`, the client asks, then calls again with the answer. The answer is bound to that exact invoice with a signed `requestState`, so if a price changes between the two rounds the user is asked again.
   - 2025 clients: the server sends `elicitation/create` during the call and waits.
2. **Otherwise, preview then token.** The first call returns `status: "preview"` and a signed `confirmationToken` that lasts 10 minutes and matches only that invoice. The model is told to show the preview and call again with the token only after the user says yes. The token can't prove a person looked: it proves the invoice created is exactly the one previewed, and the client's own tool-approval prompt is the human check. To refuse this fallback, set `QUICKBOOKS_REQUIRE_ELICITATION=true`.

Every create sends Intuit a `requestid` derived from the approval, so a retry after a dropped connection returns the same invoice instead of a duplicate. See [ADR-004](../../docs/adr/004-write-confirmation.md).

### Design notes

- **Money is added in cents.** QuickBooks sends amounts as JSON numbers, so 0.1 + 0.2 invoices total exactly 0.30.
- **"Today" is the business's date.** Overdue days and "this month" use `PORTER_TIMEZONE` (default `America/Toronto`). At 9 pm in Toronto on the 31st, UTC already says the 1st.
- **Periods follow the fiscal year.** `this_year` and the quarters start in the company's fiscal start month. Current periods run to today. "Previous period" for a month is the previous calendar month, not the previous 31 days.
- **No guessing whose books to touch.** Names are matched locally ("amys bird" finds Amy's Bird Sanctuary). If a name matches more than one customer, the tool lists them with ids and asks.
- **No free text in queries.** Names are matched after fetching, and invoice numbers must match a strict pattern. Nothing the model types ends up inside a QuickBooks query string.
- **Canada and other VAT/GST countries.** Outside the US, every invoice line needs a sales tax code. The tool asks for one and lists the company's codes rather than picking one.
- **Customer names and memos are data.** They are sanitized like other external text, so a customer called "Ignore previous instructions…" stays a name.

## Install

**Claude Code:**

```bash
claude mcp add --transport stdio porter-quickbooks \
  --env QUICKBOOKS_CLIENT_ID=... --env QUICKBOOKS_CLIENT_SECRET=... \
  -- npx -y @abhijoshi23/porter-quickbooks
```

**Claude Desktop / Cursor / VS Code** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "porter-quickbooks": {
      "command": "npx",
      "args": ["-y", "@abhijoshi23/porter-quickbooks"],
      "env": { "QUICKBOOKS_CLIENT_ID": "...", "QUICKBOOKS_CLIENT_SECRET": "..." }
    }
  }
}
```

For the demo company, use `"env": { "QUICKBOOKS_ENVIRONMENT": "demo" }` instead and skip the setup below.

> Publishing to npm happens in Milestone 8. Until then, build from source and point the command at `packages/server-quickbooks/dist/bin.js`.

## Connect a QuickBooks sandbox company (free)

1. Sign up at [developer.intuit.com](https://developer.intuit.com). A sandbox company with sample data is created for you.
2. **Dashboard → Create an app → QuickBooks Online and Payments**, with the scope `com.intuit.quickbooks.accounting`.
3. Under **Keys & credentials** (Development), add the redirect URI `http://localhost:8723/callback`, then copy the Client ID and Client Secret.
4. Run once in a terminal:

   ```bash
   QUICKBOOKS_CLIENT_ID=... QUICKBOOKS_CLIENT_SECRET=... npx @abhijoshi23/porter-quickbooks auth
   ```

   Your browser opens Intuit's consent page. Pick the sandbox company. The connection is saved, encrypted, to `~/.config/porter/quickbooks-sandbox.json`.

Alternative to step 4: get a refresh token from Intuit's [OAuth 2.0 Playground](https://developer.intuit.com/app/developer/playground) and run `porter-quickbooks auth --realm <companyId> --refresh-token <token>`. The token is used once straight away, so the copy you pasted stops working.

`porter-quickbooks status` shows the connection, and `porter-quickbooks logout` revokes it at Intuit and deletes the file.

### How the connection is stored

- The refresh token unlocks someone's books, so it is never written in the clear. The file is AES-256-GCM encrypted with a key derived (HKDF) from your client secret. It is useless without the secret, and a tampered file fails to decrypt.
- The file is written atomically with mode `0600`.
- Intuit rotates refresh tokens: each refresh can return a new one, and the old one stops working. Every new token is saved before it is used. If a second copy of the server already rotated the token, this copy picks up the saved one.

## Configuration

| Variable                         | Default                          | Meaning                                                                              |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `QUICKBOOKS_CLIENT_ID`           |                                  | From your Intuit app                                                                 |
| `QUICKBOOKS_CLIENT_SECRET`       |                                  | From your Intuit app; also derives the file encryption key                           |
| `QUICKBOOKS_ENVIRONMENT`         | `sandbox`                        | `sandbox`, `production` or `demo` (built-in sample company, nothing saved)           |
| `QUICKBOOKS_REDIRECT_URI`        | `http://localhost:8723/callback` | Must match the app's redirect URI                                                    |
| `QUICKBOOKS_REQUIRE_ELICITATION` | `false`                          | `true`: refuse writes from clients that can't ask the user themselves                |
| `PORTER_TIMEZONE`                | `America/Toronto`                | The business's time zone, for "today" and "overdue"                                  |
| `PORTER_CONFIRM_SECRET`          | random per process               | Signs confirmations; set it (32+ characters) when several processes serve one client |
| `PORTER_CONFIG_DIR`              | `~/.config/porter`               | Where the encrypted connection is kept                                               |
| `PORTER_TRANSPORT`               | `stdio`                          | `stdio` or `http` (Streamable HTTP)                                                  |
| `LOG_LEVEL`                      | `info`                           | Logs go to stderr. Tokens are redacted                                               |

## Development

```bash
pnpm --filter @abhijoshi23/porter-quickbooks test   # offline: an in-memory QuickBooks
```

`src/demo.ts` is a small in-memory QuickBooks: the OAuth token endpoint with rotating refresh tokens, the query-language subset this server sends, CompanyInfo, Preferences, the Profit and Loss report, and invoice creation with `requestid` idempotency. Its sample company includes:

- partly paid and long-overdue invoices;
- a customer whose balance nets an unapplied payment;
- two customers called Smith;
- an item with no price, and an item inside a category;
- a memo and a customer name carrying prompt-injection text.

The integration tests run every tool over both protocol eras, with clients that do and don't support elicitation.
