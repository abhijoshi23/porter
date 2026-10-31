# porter-opendata

An MCP server that gives AI assistants access to **Canadian open data**:

- **Catalogues:** Ontario Data Catalogue, City of Toronto Open Data and the federal Open Government Portal, searched together. You can preview any CSV and run **sandboxed SQL** over it.
- **Statistics Canada:** about 8,000 official tables. You ask in plain English ("unemployment rate", "Kitchener-Cambridge-Waterloo") and every result comes with a citation.

No API keys needed.

## Tools

| Tool                 | Use it to…                                                  | Example prompt                                                             |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `search_datasets`    | Find datasets across the three catalogues                   | "Find Toronto data about library branches"                                 |
| `get_dataset`        | Get a dataset's description, licence and files (resources)  | "What files are in that dataset, and what's the licence?"                  |
| `preview_resource`   | See a CSV's columns, types, row count and first rows        | "Show me the first rows of the branches CSV"                               |
| `query_resource`     | Run one read-only DuckDB `SELECT` over a CSV (table `data`) | "Which ward has the most library branches?"                                |
| `statcan_find_table` | Search StatCan tables by keyword                            | "Find the labour force table by census metropolitan area"                  |
| `statcan_get_table`  | List a table's dimensions, member names and footnotes       | "What geographies does table 14-10-0459-01 cover?"                         |
| `statcan_get_series` | Get one time series for a place and date range              | "How has unemployment in Kitchener-Cambridge-Waterloo changed since 2019?" |

All tools are **read-only**. Dataset IDs look like `toronto:library-branch-general-information` and work across every tool.

**Also provided:**

- **Resource:** `opendata://{portal}/{name}` returns a dataset's metadata as JSON, so you can attach it to a conversation directly.
- **Prompt:** `compare_cities(metric, since?)` compares one indicator across Kitchener-Cambridge-Waterloo, Hamilton and Toronto.

### Design notes

- **Geography is ambiguous on purpose.** "Waterloo" can mean the city, Waterloo Region, the Kitchener-Cambridge-Waterloo census metropolitan area (CMA), or a town in Quebec. The server never guesses: if a name matches several places, it returns the options, each labelled from the table's own hierarchy (`in Waterloo, Ontario`, `contains 7 sub-areas`). Members that share a name can be chosen with `id:<n>`. When a match is exact but similar places exist, the result says so.
- **Defaults are explicit.** If you leave a dimension out (for example "Data type"), the series uses the obvious default ("Seasonally adjusted"), and the `resolved` field shows what was chosen and why.
- **Suppressed data is never shown as a number.** StatCan values flagged as suppressed or too unreliable (`x`, `F`, `..`) become `null`, along with the flag's meaning.
- **Results are cited.** Every StatCan series includes the table number, DOI and Statistics Canada Open Licence. Every dataset includes its portal licence.

## Install

**Claude Code:**

```bash
claude mcp add --transport stdio porter-opendata -- npx -y @abhijoshi23/porter-opendata
```

**Claude Desktop / Cursor / VS Code** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "porter-opendata": { "command": "npx", "args": ["-y", "@abhijoshi23/porter-opendata"] }
  }
}
```

> Publishing to npm happens in Milestone 8. Until then, build from source and point the command at `packages/server-opendata/dist/bin.js`.

## Configuration

| Variable                 | Default           | Meaning                                                                  |
| ------------------------ | ----------------- | ------------------------------------------------------------------------ |
| `PORTER_CACHE_DIR`       | `~/.cache/porter` | Where downloaded CSVs and the StatCan table list are cached between runs |
| `PORTER_MAX_DOWNLOAD_MB` | `100`             | Largest file `preview_resource` / `query_resource` will download         |
| `PORTER_SQL_TIMEOUT_MS`  | `5000`            | Time limit per SQL query                                                 |
| `PORTER_SQL_MAX_ROWS`    | `200`             | Maximum rows returned per query                                          |
| `PORTER_TRANSPORT`       | `stdio`           | `stdio` or `http` (Streamable HTTP)                                      |
| `LOG_LEVEL`              | `info`            | Logs go to stderr                                                        |

## Try it in MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the official tool for exercising a server by hand. From the repo root:

```bash
pnpm build
cd packages/server-opendata

# Interactive UI (opens a browser): pick a tool, fill in arguments, see the raw result
npx -y @modelcontextprotocol/inspector@2.13.0 -e LOG_LEVEL=warn node dist/bin.js

# Or from the terminal, without a UI
npx -y @modelcontextprotocol/inspector@2.13.0 --cli -e LOG_LEVEL=silent node dist/bin.js --method tools/list

npx -y @modelcontextprotocol/inspector@2.13.0 --cli -e LOG_LEVEL=silent node dist/bin.js \
  --method tools/call --tool-name statcan_get_series \
  --tool-arg productId=14100459 \
  --tool-arg geography=Hamilton \
  --tool-arg 'members={"Labour force characteristics":"Unemployment rate"}' \
  --tool-arg startDate=2026-01
```

Things to look for in the UI:

1. **Tools tab:** every tool shows `readOnlyHint: true` and an output schema.
2. **Run `statcan_get_series` with `productId = 98100002`** (2021 Census, municipalities) **and `geography = "Waterloo"`.** You get the exact options back instead of a guess:

   > "Waterloo (in La Haute-Yamaska, Quebec) [id:1327]", "Waterloo (in Ontario; contains 7 sub-areas) [id:2864]", "Waterloo (in Waterloo, Ontario) [id:2868]"

   Those are a Quebec town, the Region of Waterloo, and the City of Waterloo. Call again with `geography = "id:2868"` to choose the city.

3. **Run `query_resource` with `sql = "COPY data TO '/tmp/x.csv'"`.** It's refused, which shows the sandbox in action.
4. **Resources tab → templates:** read `opendata://toronto/library-branch-general-information`.
5. **Prompts tab:** `compare_cities` with `metric = "unemployment rate"`.

Note that the Inspector doesn't forward your shell environment to the server. Pass settings with `-e KEY=value`.

## Data sources and licences

| Source                    | API                                                    | Licence                                                                                          |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Ontario Data Catalogue    | `data.ontario.ca/api/3` (CKAN)                         | [Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario) |
| City of Toronto Open Data | `ckan0.cf.opendata.inter.prod-toronto.ca/api/3` (CKAN) | [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/)                  |
| Open Government Portal    | `open.canada.ca/data/api/3` (CKAN)                     | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)     |
| Statistics Canada         | `www150.statcan.gc.ca/t1/wds/rest` (Web Data Service)  | [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence)     |

Individual datasets may carry their own licence; `get_dataset` always reports the dataset's actual licence.

## Security

- **SQL sandbox:** one statement only, `SELECT` only, no file, network or extension access (DuckDB `enable_external_access=false` with the configuration locked), memory and time limits, and a row cap. See [docs/security.md](../../docs/security.md).
- **Prompt injection:** publisher text is untrusted. It is cleaned, capped in length, kept in fields documented as external, and never copied into summaries.

## Development

```bash
pnpm --filter @abhijoshi23/porter-opendata test             # offline: replays recorded HTTP fixtures
PORTER_FIXTURES=record pnpm --filter @abhijoshi23/porter-opendata test   # re-record against live APIs
```

After re-recording, re-trim the StatCan table-list fixture to keep the repo small; the trimming is described in the fixture's `_note` field.
