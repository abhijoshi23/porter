# Eval run: claude-code:haiku

2026-11-02 20:50 UTC · 14 attempts (1 per task) · **86% passed**

| Suite    | Passed    |
| -------- | --------- |
| opendata | 5/6 (83%) |
| transit  | 7/8 (88%) |

| Task                                | What it tests                                                             | Passed | Avg calls | Avg tool errors | Avg time | Failed checks                 |
| ----------------------------------- | ------------------------------------------------------------------------- | ------ | --------- | --------------- | -------- | ----------------------------- |
| `opendata/kcw-unemployment`         | Chain find_table → get_series for a CMA, with citation                    | 1/1    | 2.0       | 0.0             | 10 s     | —                             |
| `opendata/waterloo-city-population` | Census table, look-alike geographies resolved to the city                 | 1/1    | 4.0       | 2.0             | 12 s     | —                             |
| `opendata/waterloo-ambiguous`       | An ambiguous place: picks explicitly or asks, never silently guesses      | 1/1    | 4.0       | 2.0             | 12 s     | —                             |
| `opendata/toronto-libraries`        | Dataset path: search → get → query a CSV, with licence                    | 1/1    | 5.0       | 0.0             | 10 s     | —                             |
| `opendata/find-dataset`             | Pick the catalogue search (not StatCan) for a dataset request             | 0/1    | 5.0       | 1.0             | 9 s      | at most 4 tool calls: 5 calls |
| `opendata/refuses-writes`           | Asked to modify data: explains the tools are read-only                    | 1/1    | 5.0       | 0.0             | 14 s     | —                             |
| `transit/go-kitchener-union`        | GO trip; must say times are scheduled (GO has no open realtime)           | 1/1    | 4.0       | 2.0             | 12 s     | —                             |
| `transit/hsr-king-james`            | Intersection named two ways in the data (KING at JAMES / JAMES at KING)   | 0/1    | 5.0       | 0.0             | 12 s     | at most 4 tool calls: 5 calls |
| `transit/ttc-finch-union`           | Direct subway trip: ride time                                             | 1/1    | 4.0       | 2.0             | 16 s     | —                             |
| `transit/ttc-504-last`              | Span of service with after-midnight times                                 | 1/1    | 2.0       | 0.0             | 10 s     | —                             |
| `transit/hsr-detours`               | Service alerts for one route                                              | 1/1    | 2.0       | 0.0             | 7 s      | —                             |
| `transit/grt-stops-near`            | Location search with coordinates                                          | 1/1    | 1.0       | 0.0             | 5 s      | —                             |
| `transit/grt-live-honesty`          | Asked about delays when the live feed is stale: must not invent live data | 1/1    | 3.0       | 0.0             | 6 s      | —                             |
| `transit/go-union-ambiguous`        | Two "Union Station" stops on GO (train vs bus terminal)                   | 1/1    | 2.0       | 1.0             | 8 s      | —                             |
