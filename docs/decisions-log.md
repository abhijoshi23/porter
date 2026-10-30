# Decisions log

Short record of choices made along the way. Bigger, interview-worthy choices get an ADR in `docs/adr/`.

| Date | Decision | Why |
|---|---|---|
| 2026-10-30 | Project name is **Porter** (not "Portage"). | Owner's choice. |
| 2026-10-30 | GitHub `abhijoshi23`. npm packages are `@abhijoshi23/porter-*`, and registry names are `io.github.abhijoshi23/porter-*`. | GitHub auth on the MCP Registry requires the `io.github.<user>/` prefix. |
| 2026-10-30 | **Zero cost** is a hard constraint. | Owner's requirement. See "Cost plan" below. |
| 2026-10-30 | Proposals P1–P10 from `mcp-notes.md` are adopted by default. | No objection raised. Revisit if the owner disagrees. |

## Cost plan ($0)

| Need | Free choice | Notes |
|---|---|---|
| Repo, CI, CodeQL, Dependabot | GitHub public repo + Actions | Free and unlimited for public repos |
| Package hosting | npm public scoped packages | Free. Needs an npm account, ideally with username `abhijoshi23`. |
| MCP Registry | `mcp-publisher` with GitHub login | Free |
| Data sources | CKAN, StatCan, CanadaBuys, GTFS (GRT/HSR/TTC) | No key needed |
| GO realtime | Metrolinx Open Data key | Free registration, optional |
| QuickBooks | Intuit Developer sandbox | Free developer account |
| Eval LLM | **Default: Claude Code headless** (`claude -p --mcp-config … --output-format stream-json`), which uses the owner's existing Claude login instead of a paid API key. **Fallback: Ollama** running a local model, fully offline and free. | The runner has a pluggable "driver", so adding a paid API later is a one-file change. Small task suites keep subscription usage low. |
| Remote demo hosting | **Cloudflare Workers free tier** (SDK v2 `createMcpHandler` is fetch-native and stateless). Fallback: Render free web service. | Fly.io and Railway no longer have real free tiers. Decide in Milestone 7. |
| OAuth authorization server | WorkOS AuthKit or Auth0 free tier | Decide in Milestone 7 |
| Demo GIFs | VHS / asciinema / macOS screen recording | Free |
