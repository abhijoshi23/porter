# porter-evals (private)

The eval runner. It measures whether models pick and chain Porter's tools correctly against live data. See [docs/evals.md](../../docs/evals.md) for the method and the latest results, and [docs/tool-design.md](../../docs/tool-design.md) for what each run changed.

```bash
pnpm build
node dist/cli.js --help
node dist/cli.js --driver claude-code --model haiku --repeat 3   # uses your Claude login, no API key
node dist/cli.js --driver ollama --model qwen2.5-coder:7b        # local and free (run `ollama serve` first)
node dist/cli.js --rescore results/<run>.json                    # re-apply changed checks to saved traces
```

Layout: `src/tasks/` (prompts and checks), `src/checks.ts` (check builders and scoring), `src/drivers/` (claude-code, ollama, scripted), `src/runner.ts`, `src/report.ts`, `results/` (committed runs).

On a laptop, wrap long runs in `caffeinate -i` (macOS) so the machine doesn't sleep mid-run.
