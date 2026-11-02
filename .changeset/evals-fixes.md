---
'@abhijoshi23/porter-opendata': patch
'@abhijoshi23/porter-transit': patch
---

Fixes and design changes driven by the first eval run. opendata: census tables (no vectors) are readable, the default window anchors to the table's latest data, relative CKAN resource URLs are resolved, every coordinate problem is reported in one error, and printed option labels are accepted back. transit: agency names like "GO Transit" are accepted, a single station or rail stop wins among equal matches, `find_stops` returns one place per intersection (`ids:…`), and empty windows look ahead 24 h.
