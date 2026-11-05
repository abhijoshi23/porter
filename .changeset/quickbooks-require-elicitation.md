---
'@abhijoshi23/porter-quickbooks': minor
---

`create_invoice` now requires a client that can ask the user (elicitation) by default: `QUICKBOOKS_REQUIRE_ELICITATION` defaults to `true`, and clients without it get a refusal that explains how to opt in. Set it to `false` to allow the preview-then-confirmation-token flow. Write tools no longer carry a concrete example call that a model could replay. See ADR-004's 2026-11-05 amendment.
