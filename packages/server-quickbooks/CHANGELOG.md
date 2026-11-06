# @abhijoshi23/porter-quickbooks

## 0.1.0

### Minor Changes

- [`1987ab5`](https://github.com/abhijoshi23/porter/commit/1987ab58e80f60c1c87fb52ebd4fcac46d0100d1) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-quickbooks: QuickBooks Online as an owner's assistant. Receivables with aging (`who_owes_me`), profit and loss with period comparison, invoice and customer lookups, and `create_invoice`, which writes only after the user approves. Connection via `porter-quickbooks auth`, stored encrypted; `QUICKBOOKS_ENVIRONMENT=demo` serves a sample company. Toolkit: write confirmation (`askUser` over elicitation in both protocol eras, `ConfirmationTokens`, `digest`), handlers may return `input_required`, test clients can answer elicitations, and `HttpClient` can return error responses (`returnErrors`).

- [`141d744`](https://github.com/abhijoshi23/porter/commit/141d744732f8786cce39539e5d05bbd14eace4d1) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - `create_invoice` now requires a client that can ask the user (elicitation) by default: `QUICKBOOKS_REQUIRE_ELICITATION` defaults to `true`, and clients without it get a refusal that explains how to opt in. Set it to `false` to allow the preview-then-confirmation-token flow. Write tools no longer carry a concrete example call that a model could replay. See ADR-004's 2026-11-05 amendment.

### Patch Changes

- Updated dependencies [[`3a0e0cb`](https://github.com/abhijoshi23/porter/commit/3a0e0cb2b0f2e7e0e09cbea2f8fcf41a89e823a2), [`3ee20fe`](https://github.com/abhijoshi23/porter/commit/3ee20fee3ce2e874b96c0ddadc03c320e7d751e5), [`1987ab5`](https://github.com/abhijoshi23/porter/commit/1987ab58e80f60c1c87fb52ebd4fcac46d0100d1), [`6233395`](https://github.com/abhijoshi23/porter/commit/62333959183084f8c7b61d3f51f0974247658719), [`bc960ef`](https://github.com/abhijoshi23/porter/commit/bc960ef3d92678b10f324894754fb2139e72297d)]:
  - @abhijoshi23/porter-toolkit@0.1.0
