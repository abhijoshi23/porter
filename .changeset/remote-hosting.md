---
'@abhijoshi23/porter-toolkit': minor
'@abhijoshi23/porter-opendata': minor
'@abhijoshi23/porter-quickbooks': patch
---

Remote hosting (ADR-005). Toolkit: `createMcpFetchHandler`, one fetch-native HTTP handler for Node and Cloudflare Workers with Host/Origin checks, a per-client rate limit and OAuth 2.1 resource-server mode (`jwtVerifier`, RFC 9728 metadata, audience-bound JWTs; enable with `PORTER_OAUTH_ISSUER` and `PORTER_OAUTH_RESOURCE`). `serverFactory` accepts a function to build a definition per request, `createLogger` takes an optional line sink, and `ConfirmationTokens` creates its key on first use. Opendata: a `./remote` entry with the disk-free tools (no DuckDB). QuickBooks: accepts a shared `tokens` signer, and the refusal for clients that can't be asked now says "this connection".
