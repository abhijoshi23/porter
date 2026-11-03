# porter-tenders

An MCP server for **Government of Canada tenders**. It lets AI assistants search what federal departments are buying on [CanadaBuys](https://canadabuys.canada.ca), read a notice, and pull out what decides whether to bid.

It covers about 900 open notices, plus closed and cancelled notices from the current and previous fiscal years. No API keys are needed, and it has no native dependencies.

## Tools

| Tool                   | Use it to…                                                                                                           | Example prompt                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `search_tenders`       | Find open or recently closed notices by topic, region, buyer and closing date                                        | "Find open IT consulting tenders in Ontario"                    |
| `get_tender`           | Read one notice by reference number, solicitation number or URL: status, closing, amendments, documents              | "Is solicitation TR-2026-01 still open?"                        |
| `summarize_tender_fit` | Bid/no-bid read: security level, Indigenous set-aside, mandatory criteria, site visit, deadlines, each with evidence | "We hold Reliability clearance. Can we bid on cb-586-68219268?" |

All tools are **read-only**: they can't submit bids or register suppliers.

**Prompt:** `tender_scan(business, region?, clearance?)` finds open tenders for a business and gives a bid/no-bid read on the best three.

### Design notes

- **Everyday words reach coded notices.** Notices are coded with UNSPSC commodity codes, and their text rarely says "IT consulting". The server maps 23 everyday topics to code families, checked against the descriptions in the live files. "IT consulting" therefore also finds notices coded 80101507 _Information technology consultation services_. Each result says which terms and topics it matched.
- **Closing times are correct across DST.** The CanadaBuys data dictionary says times are fixed UTC−05:00. The data says otherwise: closings cluster at 14:00 in July as in January, and the descriptions of those notices say "14:00 EDT". Times are read as Eastern wall-clock time, so a July closing is `14:00-04:00`, not 15:00.
- **Status comes from the clock.** The open-notices file says "Open" until it is regenerated. A notice whose closing time passed this morning is reported as closed.
- **Says what kind of notice it is.** Each notice is classed as a bid, a qualification (standing offer, supply arrangement or source list), an RFI (no contract) or an advance contract award notice (supplier pre-selected). These need different responses.
- **Fit extraction shows its evidence and its limits.** `summarize_tender_fit` uses rules, not a model, and every field quotes the sentences it came from:
  - `not_stated` means the notice is silent, which is not the same as "none".
  - "Tenders _may_ be set aside" is boilerplate (`possible`), not a set-aside.
  - Every result says the solicitation documents hold the full requirements.
- **Untrusted text stays untrusted.** Titles, descriptions and contacts are sanitized: markup, hidden comments, bidi and zero-width characters, and fake headings are removed. They appear only in fields marked as publisher-provided, never in the summary line. Links must be absolute `http(s)`.

## Install

**Claude Code:**

```bash
claude mcp add --transport stdio porter-tenders -- npx -y @abhijoshi23/porter-tenders
```

**Claude Desktop / Cursor / VS Code** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "porter-tenders": {
      "command": "npx",
      "args": ["-y", "@abhijoshi23/porter-tenders"]
    }
  }
}
```

> Publishing to npm happens in Milestone 8. Until then, build from source and point the command at `packages/server-tenders/dist/bin.js`.

**First use** downloads the open-notices file (6 MB), which takes about a second. Lookups of closed notices also download the fiscal-year files (25–40 MB each), but only the first time one is needed. Files are cached on disk across restarts.

## Configuration

| Variable                         | Default           | Meaning                                                                  |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `PORTER_TENDERS_REFRESH_HOURS`   | `6`               | How often to re-download the open and new notices                        |
| `PORTER_TENDERS_HISTORY_YEARS`   | `2`               | Fiscal years of closed notices to load on demand (0 = open notices only) |
| `PORTER_TENDERS_MAX_DOWNLOAD_MB` | `150`             | Largest single file to download                                          |
| `PORTER_CACHE_DIR`               | `~/.cache/porter` | Where downloaded files are kept                                          |
| `PORTER_TRANSPORT`               | `stdio`           | `stdio` or `http` (Streamable HTTP)                                      |
| `LOG_LEVEL`                      | `info`            | Logs go to stderr                                                        |

## Data source and licence

[CanadaBuys tender notices](https://open.canada.ca/data/en/dataset/6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2) from Public Services and Procurement Canada are published under the [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada). The server uses these files:

| File                                             | Used for                           | Refreshed by CanadaBuys |
| ------------------------------------------------ | ---------------------------------- | ----------------------- |
| `openTenderNotice-ouvertAvisAppelOffres.csv`     | Open notices                       | Daily                   |
| `newTenderNotice-nouvelAvisAppelOffres.csv`      | Today's new notices and amendments | Through the day         |
| `<fiscal year>-TenderNotice-AvisAppelOffres.csv` | Closed and cancelled notices       | Daily (current year)    |

Every result carries the source, the licence and when the file was downloaded.

## Development

```bash
pnpm --filter @abhijoshi23/porter-tenders test   # offline: fixture CSVs built in code
```

The fixtures in `src/testing/fixtures.ts` reproduce what the real files contain:

- the 67-column bilingual header, a BOM and CRLF line endings;
- multi-line quoted descriptions, HTML entities and `*`-prefixed multi-value cells;
- `cb-` notices with no URL, and a solicitation number shared by two lots;
- a newer amendment in the new-notices file;
- a notice still marked "Open" after its closing time;
- a summer (EDT) closing;
- a notice whose description carries prompt-injection text.
