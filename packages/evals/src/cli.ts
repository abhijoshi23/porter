#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { OllamaDriver } from './drivers/ollama.js';
import { summarize, toMarkdown } from './report.js';
import { runTasks, type RunResult } from './runner.js';
import { score } from './checks.js';
import { ALL_TASKS, SUITES } from './tasks/index.js';
import type { Driver } from './types.js';

const HELP = `porter-eval: run Porter's eval tasks against a model.

  --driver claude-code|ollama   (default claude-code)
  --model <name>                claude-code: haiku | sonnet | opus (default haiku)
                                ollama: e.g. qwen2.5-coder:7b (default)
  --suite opendata,transit      (default: all)
  --task <regex>                only tasks whose id matches
  --repeat <n>                  attempts per task (default 1)
  --concurrency <n>             parallel tasks (default 2 for claude-code, 1 for ollama)
  --out <dir>                   where to write results (default: ./results)
  --claude-bin <path>           Claude Code binary (default: \`claude\` on PATH, else the VS Code extension's)
  --list                        list tasks and exit
  --rescore <results.json>      re-apply the current checks to saved traces (no model calls)

Cost: claude-code uses your Claude login (subscription usage, no API key). ollama is local and free.`;

const { values } = parseArgs({
  options: {
    driver: { type: 'string', default: 'claude-code' },
    model: { type: 'string' },
    suite: { type: 'string' },
    task: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string' },
    out: { type: 'string', default: 'results' },
    'claude-bin': { type: 'string' },
    list: { type: 'boolean', default: false },
    rescore: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP + '\n');
  process.exit(0);
}

let tasks = values.suite
  ? values.suite.split(',').flatMap((s) => {
      const t = SUITES[s.trim()];
      if (!t) throw new Error(`Unknown suite "${s}". Suites: ${Object.keys(SUITES).join(', ')}`);
      return t;
    })
  : ALL_TASKS;
if (values.task) tasks = tasks.filter((t) => new RegExp(values.task!).test(t.id));

if (values.list) {
  for (const t of tasks) process.stdout.write(`${t.id.padEnd(36)} ${t.intent}\n`);
  process.exit(0);
}

// Scoring is a pure function of the trace, so fixing a check doesn't need a new model run.
if (values.rescore) {
  const saved = JSON.parse(await readFile(values.rescore, 'utf8')) as RunResult;
  const byId = new Map(ALL_TASKS.map((t) => [t.id, t]));
  const rescored: RunResult = {
    ...saved,
    attempts: saved.attempts
      .filter((a) => byId.has(a.taskId))
      .map((a) => ({ ...a, score: score(byId.get(a.taskId)!, a.trace) })),
  };
  await writeFile(values.rescore, JSON.stringify(rescored, null, 2) + '\n');
  await writeFile(values.rescore.replace(/\.json$/, '.md'), toMarkdown(rescored, ALL_TASKS));
  process.stderr.write(`Rescored: ${Math.round(summarize(rescored).passRate * 100)}% passed.\n`);
  process.exit(0);
}

function findClaude(): string {
  if (values['claude-bin']) return values['claude-bin'];
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    // Not on PATH: the VS Code extension ships the same CLI. Take the newest version.
    const ext = join(homedir(), '.vscode', 'extensions');
    const dirs = existsSync(ext)
      ? readdirSync(ext)
          .filter((d) => d.startsWith('anthropic.claude-code-'))
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      : [];
    for (const d of dirs.reverse()) {
      const bin = join(ext, d, 'resources', 'native-binary', 'claude');
      if (existsSync(bin)) return bin;
    }
    throw new Error('Claude Code not found. Install it, or pass --claude-bin <path>.');
  }
}

const driver: Driver =
  values.driver === 'ollama'
    ? new OllamaDriver({ model: values.model ?? 'qwen2.5-coder:7b' })
    : new ClaudeCodeDriver({ bin: findClaude(), model: values.model ?? 'haiku' });
const concurrency = Number(values.concurrency ?? (values.driver === 'ollama' ? 1 : 2));
const cacheDir = join(homedir(), '.cache', 'porter');

process.stderr.write(`Running ${tasks.length} task(s) × ${values.repeat} with ${driver.label}…\n`);
const run = await runTasks({
  tasks,
  driver,
  repeat: Number(values.repeat),
  concurrency,
  cacheDir,
  onAttempt: (a) =>
    process.stderr.write(
      `${a.score.pass ? 'PASS' : 'FAIL'}  ${a.taskId} #${a.attempt}  (${a.trace.calls.length} calls, ${Math.round(a.trace.durationMs / 1000)} s)` +
        (a.score.pass
          ? ''
          : `  ✗ ${a.score.checks
              .filter((c) => !c.pass)
              .map((c) => c.name)
              .join('; ')}`) +
        '\n',
    ),
});

const s = summarize(run);
const stamp = run.startedAt.slice(0, 16).replace(/[:T]/g, '-');
const base = join(values.out, `${stamp}_${driver.label.replace(/[^\w.-]+/g, '-')}`);
await mkdir(values.out, { recursive: true });
await writeFile(`${base}.json`, JSON.stringify(run, null, 2) + '\n');
await writeFile(`${base}.md`, toMarkdown(run, tasks));
process.stderr.write(`\n${Math.round(s.passRate * 100)}% passed. Report: ${base}.md\n`);
