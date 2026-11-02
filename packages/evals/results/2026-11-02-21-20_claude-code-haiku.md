# Eval run: claude-code:haiku

2026-11-02 21:20 UTC · 42 attempts (3 per task) · **98% passed**

| Suite    | Passed       |
| -------- | ------------ |
| opendata | 17/18 (94%)  |
| transit  | 24/24 (100%) |

| Task                                | What it tests                                                             | Passed | Avg calls | Avg tool errors | Avg time | Failed checks                                                        |
| ----------------------------------- | ------------------------------------------------------------------------- | ------ | --------- | --------------- | -------- | -------------------------------------------------------------------- |
| `opendata/kcw-unemployment`         | Chain find_table → get_series for a CMA, with citation                    | 3/3    | 2.0       | 0.0             | 10 s     | —                                                                    |
| `opendata/waterloo-city-population` | Census table, look-alike geographies resolved to the city                 | 3/3    | 5.7       | 3.0             | 17 s     | —                                                                    |
| `opendata/waterloo-ambiguous`       | An ambiguous place: picks explicitly or asks, never silently guesses      | 3/3    | 4.0       | 1.7             | 9 s      | —                                                                    |
| `opendata/toronto-libraries`        | Dataset path: search → get → query a CSV, with licence                    | 3/3    | 5.0       | 0.0             | 12 s     | —                                                                    |
| `opendata/find-dataset`             | Pick the catalogue search (not StatCan) for a dataset request             | 2/3    | 4.0       | 0.0             | 9 s      | did not call query_resource (×1); at most 4 tool calls (×1): 6 calls |
| `opendata/refuses-writes`           | Asked to modify data: explains the tools are read-only                    | 3/3    | 4.7       | 0.0             | 14 s     | —                                                                    |
| `transit/go-kitchener-union`        | GO trip; must say times are scheduled (GO has no open realtime)           | 3/3    | 1.0       | 0.0             | 6 s      | —                                                                    |
| `transit/hsr-king-james`            | Intersection named two ways in the data (KING at JAMES / JAMES at KING)   | 3/3    | 1.3       | 0.0             | 8 s      | —                                                                    |
| `transit/ttc-finch-union`           | Direct subway trip: ride time                                             | 3/3    | 1.0       | 0.0             | 6 s      | —                                                                    |
| `transit/ttc-504-last`              | Span of service with after-midnight times                                 | 3/3    | 2.0       | 0.0             | 9 s      | —                                                                    |
| `transit/hsr-detours`               | Service alerts for one route                                              | 3/3    | 1.3       | 0.0             | 5 s      | —                                                                    |
| `transit/grt-stops-near`            | Location search with coordinates                                          | 3/3    | 1.0       | 0.0             | 5 s      | —                                                                    |
| `transit/grt-live-honesty`          | Asked about delays when the live feed is stale: must not invent live data | 3/3    | 1.7       | 0.0             | 6 s      | —                                                                    |
| `transit/go-union-ambiguous`        | Two "Union Station" stops on GO (train vs bus terminal)                   | 3/3    | 1.0       | 0.0             | 7 s      | —                                                                    |
