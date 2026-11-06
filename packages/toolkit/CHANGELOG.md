# @abhijoshi23/porter-toolkit

## 0.1.0

### Minor Changes

- [`3a0e0cb`](https://github.com/abhijoshi23/porter/commit/3a0e0cb2b0f2e7e0e09cbea2f8fcf41a89e823a2) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - Initial toolkit: server factory (stdio + Streamable HTTP), defineTool, resilient HTTP client, pagination/truncation, in-process test client for both protocol eras, HTTP fixture record/replay.

- [`3ee20fe`](https://github.com/abhijoshi23/porter/commit/3ee20fee3ce2e874b96c0ddadc03c320e7d751e5) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-opendata: CKAN (Ontario, Toronto, Canada) and Statistics Canada tools with sandboxed DuckDB SQL over CSVs. Toolkit: `externalText()` sanitizer for untrusted text and a persistent `DownloadCache`.

- [`1987ab5`](https://github.com/abhijoshi23/porter/commit/1987ab58e80f60c1c87fb52ebd4fcac46d0100d1) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-quickbooks: QuickBooks Online as an owner's assistant. Receivables with aging (`who_owes_me`), profit and loss with period comparison, invoice and customer lookups, and `create_invoice`, which writes only after the user approves. Connection via `porter-quickbooks auth`, stored encrypted; `QUICKBOOKS_ENVIRONMENT=demo` serves a sample company. Toolkit: write confirmation (`askUser` over elicitation in both protocol eras, `ConfirmationTokens`, `digest`), handlers may return `input_required`, test clients can answer elicitations, and `HttpClient` can return error responses (`returnErrors`).

### Patch Changes

- [`6233395`](https://github.com/abhijoshi23/porter/commit/62333959183084f8c7b61d3f51f0974247658719) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-tenders: search CanadaBuys tender notices (open and recent fiscal years), read one, and summarize bid fit (security level, Indigenous set-aside, mandatory criteria, site visits, deadlines) with evidence. Toolkit: `externalText` flattens Markdown headings on every line, not only the first, and decodes typographic and accented HTML entities.

- [`bc960ef`](https://github.com/abhijoshi23/porter/commit/bc960ef3d92678b10f324894754fb2139e72297d) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-transit: GTFS schedules and GTFS-Realtime for Grand River Transit, HSR, TTC and GO Transit (next departures, direct trip planning, route details, service alerts). Toolkit: `DownloadCache.invalidate()`, and no leftover temp file when a download is aborted early.
