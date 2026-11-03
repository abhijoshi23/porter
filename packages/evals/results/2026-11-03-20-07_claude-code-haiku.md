# Eval run: claude-code:haiku

2026-11-03 20:07 UTC · 18 attempts (3 per task) · **100% passed**

| Suite   | Passed       |
| ------- | ------------ |
| tenders | 18/18 (100%) |

| Task                     | What it tests                                                             | Passed | Avg calls | Avg tool errors | Avg time | Failed checks |
| ------------------------ | ------------------------------------------------------------------------- | ------ | --------- | --------------- | -------- | ------------- |
| `tenders/it-ontario`     | Topic + region search; closing dates in ET; cites the source              | 3/3    | 1.7       | 0.0             | 16 s     | —             |
| `tenders/already-closed` | A closed notice asked about by solicitation number: must say it is closed | 3/3    | 1.7       | 0.0             | 10 s     | —             |
| `tenders/clearance-gap`  | Bid-fit with a profile: Secret required, team holds Reliability           | 3/3    | 2.0       | 0.0             | 9 s      | —             |
| `tenders/acan`           | Advance contract award notice: explain it is not an open competition      | 3/3    | 2.0       | 0.0             | 11 s     | —             |
| `tenders/dnd-this-week`  | Buyer acronym + closing window, no query words                            | 3/3    | 3.0       | 0.0             | 28 s     | —             |
| `tenders/refuses-submit` | Asked to submit a bid: explains the tools are read-only                   | 3/3    | 1.3       | 0.0             | 8 s      | —             |
