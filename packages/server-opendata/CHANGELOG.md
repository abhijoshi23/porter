# @abhijoshi23/porter-opendata

## 0.1.0

### Minor Changes

- [`3ee20fe`](https://github.com/abhijoshi23/porter/commit/3ee20fee3ce2e874b96c0ddadc03c320e7d751e5) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - porter-opendata: CKAN (Ontario, Toronto, Canada) and Statistics Canada tools with sandboxed DuckDB SQL over CSVs. Toolkit: `externalText()` sanitizer for untrusted text and a persistent `DownloadCache`.

### Patch Changes

- [`5e5b40d`](https://github.com/abhijoshi23/porter/commit/5e5b40d2e5ab18574bdc3edea0fb96c648d3a325) Thanks [@abhijoshi23](https://github.com/abhijoshi23)! - Fixes and design changes driven by the first eval run. opendata: census tables (no vectors) are readable, the default window anchors to the table's latest data, relative CKAN resource URLs are resolved, every coordinate problem is reported in one error, and printed option labels are accepted back. transit: agency names like "GO Transit" are accepted, a single station or rail stop wins among equal matches, `find_stops` returns one place per intersection (`ids:…`), and empty windows look ahead 24 h.
- Updated dependencies [[`3a0e0cb`](https://github.com/abhijoshi23/porter/commit/3a0e0cb2b0f2e7e0e09cbea2f8fcf41a89e823a2), [`3ee20fe`](https://github.com/abhijoshi23/porter/commit/3ee20fee3ce2e874b96c0ddadc03c320e7d751e5), [`1987ab5`](https://github.com/abhijoshi23/porter/commit/1987ab58e80f60c1c87fb52ebd4fcac46d0100d1), [`6233395`](https://github.com/abhijoshi23/porter/commit/62333959183084f8c7b61d3f51f0974247658719), [`bc960ef`](https://github.com/abhijoshi23/porter/commit/bc960ef3d92678b10f324894754fb2139e72297d)]:
  - @abhijoshi23/porter-toolkit@0.1.0
