# porter-transit

An MCP server for **Ontario public transit**. It gives AI assistants schedules and live predictions for:

| Agency                     | id    | Area                                           | Live predictions              |
| -------------------------- | ----- | ---------------------------------------------- | ----------------------------- |
| Grand River Transit        | `grt` | Kitchener, Waterloo, Cambridge (incl. ION LRT) | Yes, when the feed is current |
| Hamilton Street Railway    | `hsr` | Hamilton                                       | Yes                           |
| Toronto Transit Commission | `ttc` | Toronto subway, streetcar and bus              | Yes                           |
| GO Transit                 | `go`  | GTHA regional trains and buses                 | No (needs a Metrolinx key)    |

No API keys needed.

## Tools

| Tool               | Use it to…                                                            | Example prompt                                       |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `list_agencies`    | See which agency serves a place, feed dates, licences                 | "Which transit agency covers Cambridge?"             |
| `find_stops`       | Find stops by name or near a point, with stop-sign codes and routes   | "Bus stops near 43.4643, -80.5204"                   |
| `next_departures`  | Upcoming departures from a stop or station, live where available      | "When's the next bus at King and James in Hamilton?" |
| `plan_simple_trip` | Direct rides between two stops (no transfers), earliest arrival first | "Next train from Kitchener GO to Union?"             |
| `route_info`       | A route's directions, stops and span of service on a date             | "What time does the last 504 King run tonight?"      |
| `service_alerts`   | Current detours, closures and delays, by route or stop                | "Any detours on HSR route 1?"                        |

All tools are **read-only**. Stops can be given as a name ("King / Victoria"), the code printed on the stop sign ("2939"), or `id:<stopId>` from a previous result.

**Prompt:** `commute_check(agency, from, to)` plans a direct ride and checks alerts on it.

### Design notes

- **Live or scheduled is always explicit.** Each departure has a `status` (`predicted`, `scheduled`, `canceled`, `skipped`), and `realtime.status` says whether live data was used and, if not, why. A stale feed is ignored, never presented as live. (On 2026-11-02 GRT's realtime endpoint was serving a February snapshot.)
- **Transit time is handled properly.** Trips after midnight (GTFS times like `25:10:00`, up to TTC's `31:01:49`) are found from the previous service day. Times are measured from "noon minus 12 h" as GTFS defines, so the DST-change days are right. Holiday additions and removals (`calendar_dates.txt`) are applied.
- **Places, not stop IDs.** A station includes all its platforms. Same-name stops close together count as one place (every bay of a terminal, or all corners of "KING at JAMES" / "JAMES at KING"). Different places with the same name are returned as labelled options, never guessed.
- **Honest limits.** `plan_simple_trip` finds direct rides only and says so when a transfer is needed.
- **Cited.** Every result carries the agency's data licence (and Hamilton's required attribution).

## Install

**Claude Code:**

```bash
claude mcp add --transport stdio porter-transit -- npx -y @abhijoshi23/porter-transit
```

**Claude Desktop / Cursor / VS Code** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "porter-transit": {
      "command": "npx",
      "args": ["-y", "@abhijoshi23/porter-transit"],
      "env": { "PORTER_TRANSIT_AGENCIES": "grt,hsr" }
    }
  }
}
```

> Publishing to npm happens in Milestone 8. Until then, build from source and point the command at `packages/server-transit/dist/bin.js`.

**First use of an agency** downloads its schedule (GRT 2 MB, HSR 5 MB, GO 12 MB, TTC 68 MB) and builds a local database (a few seconds; TTC about 2.5 s). If that takes longer than 25 s, the tool answers "still preparing, try again shortly" and keeps going in the background. Afterwards the database is reused across restarts and re-checked daily.

## Configuration

| Variable                            | Default           | Meaning                                                                  |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `PORTER_TRANSIT_AGENCIES`           | `grt,hsr,ttc,go`  | Which agencies to serve. Leave out TTC if you don't need it (68 MB).     |
| `PORTER_CACHE_DIR`                  | `~/.cache/porter` | Where feeds and schedule databases are kept                              |
| `PORTER_TRANSIT_REFRESH_HOURS`      | `24`              | How often to check for a new schedule                                    |
| `PORTER_TRANSIT_BUILD_WAIT_MS`      | `25000`           | How long a call waits for a first-time download before "still preparing" |
| `PORTER_TRANSIT_REALTIME_MAX_AGE_S` | `300`             | Live data older than this is ignored and reported as stale               |
| `PORTER_TRANSIT_MAX_DOWNLOAD_MB`    | `200`             | Largest GTFS zip to download                                             |
| `PORTER_TRANSIT_MAX_UNZIPPED_MB`    | `1024`            | Cap on unzipped size (zip-bomb guard)                                    |
| `PORTER_TRANSPORT`                  | `stdio`           | `stdio` or `http` (Streamable HTTP)                                      |
| `LOG_LEVEL`                         | `info`            | Logs go to stderr                                                        |

## Try it in MCP Inspector

```bash
pnpm build
cd packages/server-transit

# Interactive UI
npx -y @modelcontextprotocol/inspector@2.13.0 -e LOG_LEVEL=warn -e PORTER_TRANSIT_BUILD_WAIT_MS=120000 node dist/bin.js

# Or from the terminal
npx -y @modelcontextprotocol/inspector@2.13.0 --cli -e LOG_LEVEL=silent -e PORTER_TRANSIT_BUILD_WAIT_MS=120000 node dist/bin.js \
  --method tools/call --tool-name next_departures \
  --tool-arg agency=hsr --tool-arg 'stop=King at James' --tool-arg limit=5
```

Things to look for:

1. **`next_departures` with `agency=hsr`, `stop=King at James`.** All four corners of the intersection are combined, and departures carry `"status": "predicted"` with a delay.
2. **`next_departures` with `agency=grt`.** If GRT's realtime feed is stale, `realtime.status` is `stale` with the feed's age, and every time is marked `scheduled`.
3. **`next_departures` with `agency=go`, `stop=Union Station`.** You get two labelled options (the train station and the bus terminal) instead of a guess.
4. **`route_info` with `agency=ttc`, `route=504`.** The span of service shows times past `24:00`.
5. **`service_alerts` with `agency=hsr`.** Detour text arrives cleaned and length-capped, in fields marked as external content.

## Data sources and licences

| Agency | Static GTFS                                                    | Realtime (GTFS-RT)                       | Licence                                                                                                          |
| ------ | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GRT    | `webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1` | `…/api/tripupdates`, `…/api/alerts`      | [Region of Waterloo Open Data Licence](https://www.regionofwaterloo.ca/en/regional-government/open-data.aspx)    |
| HSR    | `opendata.hamilton.ca/GTFS-Static/google_transit.zip`          | `opendata.hamilton.ca/GTFS-RT/…`         | [City of Hamilton Open Data Licence](https://www.hamilton.ca/open-data-licence-terms-and-conditions)             |
| TTC    | Toronto Open Data, `merged-gtfs-ttc-routes-and-schedules`      | `bustime.ttc.ca/gtfsrt/trips`, `/alerts` | [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/)                                  |
| GO     | `assets.metrolinx.com/…/GO-GTFS.zip`                           | Not used (needs a key)                   | [GO Transit open data terms](https://www.gotransit.com/en/information-resources/software-developers) (Metrolinx) |

Hamilton's licence asks for this attribution, which results include: _Contains public sector Data made available under the City of Hamilton's Open Data Licence._ GO's terms don't license the GO and Metrolinx trademarks.

## Development

```bash
pnpm --filter @abhijoshi23/porter-transit test   # offline: synthetic GTFS + protobuf fixtures built in code
```

The test feed in `src/testing/fixture-feed.ts` reproduces every quirk found in the real feeds: byte-order marks (GO), `" 4:30:00"` times (HSR), hours ≥ 24, `calendar_dates`-only service (GRT, GO), station platforms and entrances (TTC), one intersection named two ways (HSR), and a stop code used twice.
