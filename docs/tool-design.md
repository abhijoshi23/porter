# Tool design rules

These rules apply to every Porter server. Where possible, `@abhijoshi23/porter-toolkit` enforces them in code.

1. **Design around user tasks, not endpoints.** Fewer, well-named tools beat many thin API wrappers. If a model has to call three tools to answer an ordinary question, consider one tool.
2. **Descriptions say _when_ to use the tool and _what_ it returns.** Include units, date formats (ISO 8601, `America/Toronto` unless stated) and a short example.
3. **Inputs use enums and sensible defaults.** Every field has a `.describe()`.
4. **Outputs return IDs that chain into the next tool** (`list_cities` → `id` → `get_city`).
5. **Read-only by default.** `defineTool` defaults to `readOnlyHint: true, destructiveHint: false`. A write tool opts out explicitly, defaults to `dryRun: true`, and needs confirmation (see `mcp-notes.md` P2).
6. **Never flood the context.** Paginate with opaque cursors (`paginationInput`, `paginate`) and cap rows and bytes (`truncateRows`), with a "refine with X" hint.
7. **Errors are for the model.** Throw `PorterError` subclasses with a `hint`. They become `isError: true` results the model can act on. Unexpected errors are reported generically and logged to stderr.
8. **Structured and readable.** Every result has `structuredContent` (validated against `output`) and a one- or two-sentence `summary`. The text block carries summary + JSON, because many clients only show `content` to the model.
9. **Cite sources.** Results built from public data include `sourceUrl` and `licence`.
10. **Upstream text is untrusted.** Dataset descriptions and tender text are data, never instructions (see `security.md`, Milestone 2+).

## Changelog (tool names, descriptions, and how eval scores moved)

Each entry: what the evals showed, what changed, and what moved. Runs are in `packages/evals/results/`. Numbers are pass rate, then failed tool calls per task (wasted round trips), on 14 tasks.

### 2026-11-02 · Round 1: first eval run

**Baseline** (`20-50_claude-code-haiku`): Haiku 12/14 (86%), 3.4 calls and 0.71 failed calls per task. qwen2.5-coder:7b 6/14 (43%).

Bugs the evals uncovered before scoring even started:

- **Census tables were unreachable.** `statcan_get_series` read data by vector, and census tables have none (`vectorId: 0`). Its default window also ended "5 years before today", which excluded the 2021 Census. It now reads by coordinate when there's no vector and anchors the window to the table's latest data.
- **`preview_resource` crashed after a search.** On open.canada.ca, CKAN's `package_search` returns relative resource URLs (`package_show` returns absolute ones), and search results were cached. URLs are now resolved against the portal, http(s) only.

What the traces showed, and the change:

| Finding (from traces)                                                                                                                                  | Change                                                                                                                                                                       | Effect                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Every model passed `agency: "GO Transit"`, not `go`.                                                                                                   | Agency names and aliases accepted (`GO Transit`, `Grand River Transit`, `Metrolinx`). Ambiguous ones like "Toronto" are still rejected.                                      | One fewer failed call per agency mix-up              |
| "Finch Station" matched 36 TTC stops. The station in the data is just "Finch". GO "Union Station" matched the train station and the bus terminal.      | Station words ("station", "GO") are optional when matching stations. With exactly one station or rail stop among the matches, it wins, and the label says what else matched. | GO Kitchener→Union 4 → 1 call; TTC Finch→Union 4 → 1 |
| HSR "King and James": Haiku called `find_stops`, then `next_departures` once per corner (5 calls). A text tip in the summary didn't change this.       | `find_stops` returns one place per intersection, with a `stop` value (`ids:a,b,c`) to pass on.                                                                               | 5 → 1.3 calls                                        |
| GO Kitchener→Union: the default 3 h window was empty, so the model retried with 12 h. qwen widened `windowMinutes` 7 times.                            | `plan_simple_trip` and `next_departures` look ahead up to 24 h when the window is empty, and say so.                                                                         | Retries gone for Haiku                               |
| StatCan errors came one at a time (ambiguous place, then missing member). Models also passed our own option labels back verbatim, which were rejected. | One error lists every problem. Labels are accepted as printed, with `[id:n]` or with their "(in …)" context.                                                                 | Opendata failed calls 0.83 → 0.44                    |

**After** (`21-33_claude-code-haiku`, 3 attempts per task): Haiku 39/42 (93%), 2.7 calls and **0.21 failed calls per task**. An intermediate run of the same code scored 41/42, so the 93–98% spread is run-to-run variance. All three remaining failures are call budgets: Haiku chose to explore further (once 11 calls on the 504, uncovering that it runs as a replacement bus). qwen2.5-coder:7b: 7/14 (50%), 0.36 failed calls per task. Its remaining failures are model limits: repeating identical calls until the turn limit, picking a projection table over the census, and dropping citations the tools returned.

Harness fixes made during the round: infrastructure errors (the laptop sleeping mid-run, timeouts, API errors) are now reported but kept out of pass rates, and runs go through `caffeinate`. The first after-fix run was discarded because the machine slept. A check that compared the model's _argument_ (`stop: "UN"`) was changed to check the _outcome_, because the server now resolves "Union Station" correctly itself. `--rescore` re-applies fixed checks to saved traces.
