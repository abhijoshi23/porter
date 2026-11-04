---
'@abhijoshi23/porter-quickbooks': minor
'@abhijoshi23/porter-toolkit': minor
---

porter-quickbooks: QuickBooks Online as an owner's assistant. Receivables with aging (`who_owes_me`), profit and loss with period comparison, invoice and customer lookups, and `create_invoice`, which writes only after the user approves. Connection via `porter-quickbooks auth`, stored encrypted; `QUICKBOOKS_ENVIRONMENT=demo` serves a sample company. Toolkit: write confirmation (`askUser` over elicitation in both protocol eras, `ConfirmationTokens`, `digest`), handlers may return `input_required`, test clients can answer elicitations, and `HttpClient` can return error responses (`returnErrors`).
