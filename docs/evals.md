# Evals

Porter's claim is that a few **task-shaped tools** beat hundreds of endpoint wrappers. The eval runner (`packages/evals`) tests that claim: it gives a model a realistic request, lets it use Porter's MCP servers, and checks what it did.

## How it works

```
task (prompt + checks) ──► driver ──► model ⇄ Porter MCP servers (stdio, live data)
                                  └─► trace: tool calls, args, errors, final answer ──► checks ──► report
```

- **Tasks** (`packages/evals/src/tasks/`) are what a user would actually type: "When's the next GO train from Kitchener to Union Station?", "What's the population of Waterloo?". Each has an `intent`, the behaviour it tests.
- **Checks are deterministic**: which tools were called and with which arguments, ordering, call budget, and regexes over the final answer. There is no LLM judge. Scoring is reproducible and costs nothing, and every check is unit-tested.
- **Checks test behaviour, not drifting values.** The servers run against live data, so a transit check asserts "called `next_departures` for HSR and gave a time", not a specific departure. Where a value is stable (2021 Census populations), it's asserted exactly.
- **Honesty is scored.** Several tasks pass only if the answer says a time is _scheduled_ when no live data was used, or asks which "Waterloo" was meant instead of guessing.

### Drivers ($0)

| Driver        | How                                                                                                | Cost                           |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| `claude-code` | Claude Code headless (`claude -p … --output-format stream-json`), using the owner's existing login | Subscription usage, no API key |
| `ollama`      | Our own agent loop: a real MCP client over stdio, tools passed in Ollama's `tools` format          | Free, local, offline           |
| `scripted`    | Prepared traces, for testing the runner itself in CI                                               | —                              |

The Claude Code run is isolated so the score reflects Porter alone: built-in tools off (`--tools ""`, so no web search fallback), only the task's Porter servers (`--strict-mcp-config`), no user or project settings, and an empty working directory.

## Running

```bash
pnpm build
cd packages/evals
node dist/cli.js --list
node dist/cli.js --driver claude-code --model haiku                 # all tasks
node dist/cli.js --driver ollama --model qwen2.5-coder:7b --suite transit
node dist/cli.js --task 'waterloo' --repeat 3                       # variance on a subset
```

Each run writes `results/<time>_<driver>.json` (full traces) and a `.md` report. Model output varies between runs, so use `--repeat` before reading much into a single pass or fail.

## Results

Latest runs (2026-11-02), 14 tasks: 6 open data and 8 transit, against live data.

| Model                    | Driver                   | Passed                    | Tool calls / task | Failed calls / task |
| ------------------------ | ------------------------ | ------------------------- | ----------------- | ------------------- |
| Claude Haiku             | Claude Code headless     | **93%** (39/42, 3 × each) | 2.7               | 0.21                |
| qwen2.5-coder:7b (local) | Ollama                   | 50% (7/14)                | 3.9               | 0.36                |
| Claude Haiku, baseline   | before eval-driven fixes | 86% (12/14)               | 3.4               | 0.71                |

What changed between baseline and latest, and why, is in [tool-design.md](tool-design.md#changelog-tool-names-descriptions-and-how-eval-scores-moved). Reports with every failed check are in [`packages/evals/results/`](../packages/evals/results/).

**Reading these numbers.** Fourteen tasks is a small suite: it shows where tools trip models up, not a benchmark. Live data changes between runs (a GO train may or may not be due within the hour), and pass rates for the same code varied between 93% and 98%. The local 7B model's failures are mostly model limits (repeated identical calls, skipped citations), which tool design can only partly offset.
