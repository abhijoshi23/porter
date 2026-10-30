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

_Starts in Milestone 4, when the eval runner exists._
