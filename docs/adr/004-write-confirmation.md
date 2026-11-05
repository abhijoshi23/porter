# ADR-004: Confirming writes

- Status: accepted, amended 2026-11-05 (the token fallback is now opt-in; see [Amendment](#amendment-2026-11-05-token-fallback-off-by-default))
- Date: 2026-11-04
- Applies to: `porter-quickbooks` (`create_invoice`), later Keel and Trillium write tools. Code: `packages/toolkit/src/confirm.ts`.

## Context

Porter's servers are read-only except for writes into someone's books. A write must not happen because a model decided it should. Three things make that hard:

- **The model writes the tool arguments.** A `confirm: true` flag, or any value the model can see, can be filled in without a person ever looking. Prompt injection makes this worse: text in a customer name or memo could ask for it.
- **Tool annotations are hints.** `readOnlyHint: false` lets a client show an approval prompt. The spec tells clients not to rely on annotations from untrusted servers, and many clients let users "always allow" a tool.
- **The protocol changed.** In 2026-07-28 servers are stateless, so there is no session to remember "this preview was shown". Server-initiated `elicitation/create` became multi round-trip requests (`input_required`). Porter must serve 2025 clients (Claude Desktop, Claude Code) and 2026 clients alike.

## Decision

A write tool first resolves the request into exactly what it would send: ids, quantities, prices, dates. It takes a digest of that, then gets approval in the strongest way the client supports.

1. **Elicitation, when the client declares it.** The user is asked in the client's UI, and the model neither sees nor answers the question.
   - 2026 clients get `input_required` with a form asking to confirm. Its `requestState` is an HMAC over the digest, so on the retried call an approval only counts for the same invoice. A changed preview is asked again.
   - 2025 clients get `elicitation/create` during the call.
   - Decline, cancel or a malformed answer means nothing is written.
2. **Preview, then confirmation token, when the server allows it** (`QUICKBOOKS_REQUIRE_ELICITATION=false`; off by default since the amendment). The first call returns the preview and a token: `v1.<expiry>.<nonce>.<HMAC(digest)>`, valid for 10 minutes. The write happens only on a call with the same resolved request and a valid token. The tool description and server instructions tell the model to show the preview and wait for the user's yes.
3. **Servers refuse the fallback by default** (`QUICKBOOKS_REQUIRE_ELICITATION=true`). Originally the fallback was on by default and this setting was opt-in.
4. **Idempotency.** The QuickBooks `requestid` is derived from the approval (the token, or the 2026 `requestState`), so a retry after a dropped connection returns the original invoice instead of creating a second one.

The toolkit provides `askUser`, `ConfirmationTokens` and `digest`. `defineTool` handlers may return an `input_required` result.

## Consequences

- With elicitation, approval comes from a person by construction.
- Without elicitation, the token proves **what** is written (exactly the previewed invoice) but not **who** approved it. The human check is then the client's approval prompt for the second call, plus the model following instructions. This is stated in the README rather than hidden. Evals check that the model doesn't send a token the user never approved (`quickbooks/invoice-needs-approval`).
- Tokens are stateless: nothing is stored, and any process with the same `PORTER_CONFIRM_SECRET` can verify them. Without the secret each process uses a random key, which is right for stdio, where one process serves both calls.
- A token can't be replayed for a different invoice. Replaying it for the same invoice within 10 minutes returns the same invoice, because of the `requestid`.
- Cost: one extra round trip for the user, which is the point.

## Alternatives considered

- **`confirm: true` argument.** The model can set it, so it proves nothing.
- **Server-side pending-write store** (preview id → stored request). This needs state, which breaks stateless HTTP and replicas, and the model can still pass the id back. A signed token does the same job with no store.
- **Elicitation only.** Claude Desktop and many other clients don't support it yet, so the server would be read-only for most users. It is available as a setting instead.
- **`dryRun: true` default** (the original plan). It is the same as `confirm: true` with the default flipped: the model can still set `dryRun: false`.

## Amendment (2026-11-05): token fallback off by default

**What we measured.** The QuickBooks eval suite ran against qwen2.5-coder 14b through Ollama, which can't elicit, so the token path applied and the runner auto-approved every call. In 9 of 21 attempts the model created an invoice nobody approved. It took the token from the preview and called `create_invoice` again in the same turn. In `quickbooks/injected-customer-name` it was asked only to list customers, and it still ran the example from the `create_invoice` description verbatim ("Amy's Bird Sanctuary", 3 × Design). Claude Haiku, on the elicitation path, scored 21/21.

The Consequences section above already said the token path depends on the model following instructions. The eval shows that a weak model doesn't, and that a client which auto-approves tools (or a user who clicked "always allow") has nothing left to stop it.

**Change.**

- `QUICKBOOKS_REQUIRE_ELICITATION` defaults to `true`. A client that can't ask the user gets a refusal that says how to opt in, and nothing is written.
- With the fallback off, the `create_invoice` description doesn't mention tokens at all.
- Write tools carry no concrete example call. The description shows the argument shape with placeholders (`"<customer id>"`) instead. Read tools keep real examples, because replaying one is harmless.
- The eval prompt for the approval task no longer matches any example, so a pass can't come from replaying one.

**Cost.** Out of the box, clients without elicitation (Claude Desktop today) can read the books but not create invoices. Setting `QUICKBOOKS_REQUIRE_ELICITATION=false` brings back the original behaviour, and the README says what that trades away.
