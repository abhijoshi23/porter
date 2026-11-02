import type { RunResult } from './runner.js';
import type { Task } from './types.js';

export interface TaskSummary {
  taskId: string;
  passes: number;
  attempts: number;
  avgCalls: number;
  avgErrors: number;
  avgSeconds: number;
  /** Checks that failed in any attempt, with how often. */
  failedChecks: { name: string; count: number; detail?: string }[];
}

export function summarize(run: RunResult): {
  tasks: TaskSummary[];
  passRate: number;
  bySuite: Record<string, { passes: number; attempts: number }>;
  infraErrors: number;
} {
  // Attempts that failed for infrastructure reasons don't count for or against a model.
  const scored = run.attempts.filter((a) => !a.trace.infraError);
  const ids = [...new Set(run.attempts.map((a) => a.taskId))];
  const tasks = ids.map((taskId) => {
    const as = scored.filter((a) => a.taskId === taskId);
    const failed = new Map<string, { count: number; detail?: string }>();
    for (const a of as) {
      for (const c of a.score.checks.filter((x) => !x.pass)) {
        const f = failed.get(c.name) ?? { count: 0 };
        f.count++;
        f.detail ??= c.detail;
        failed.set(c.name, f);
      }
    }
    const avg = (f: (a: (typeof as)[number]) => number) =>
      as.length ? as.reduce((s, a) => s + f(a), 0) / as.length : 0;
    return {
      taskId,
      passes: as.filter((a) => a.score.pass).length,
      attempts: as.length,
      avgCalls: avg((a) => a.trace.calls.length),
      avgErrors: avg((a) => a.trace.calls.filter((c) => c.isError).length),
      avgSeconds: avg((a) => a.trace.durationMs / 1000),
      failedChecks: [...failed].map(([name, f]) => ({ name, ...f })),
    };
  });
  const bySuite: Record<string, { passes: number; attempts: number }> = {};
  for (const a of scored) {
    const suite = a.taskId.split('/')[0]!;
    bySuite[suite] ??= { passes: 0, attempts: 0 };
    bySuite[suite].attempts++;
    if (a.score.pass) bySuite[suite].passes++;
  }
  const passes = scored.filter((a) => a.score.pass).length;
  return {
    tasks,
    passRate: scored.length ? passes / scored.length : 0,
    bySuite,
    infraErrors: run.attempts.length - scored.length,
  };
}

const pct = (n: number, d: number) => `${d ? Math.round((n / d) * 100) : 0}%`;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A Markdown report a reviewer can read on GitHub. */
export function toMarkdown(run: RunResult, tasks: Task[]): string {
  const s = summarize(run);
  const intent = new Map(tasks.map((t) => [t.id, t.intent]));
  const lines = [
    `# Eval run: ${run.driver}`,
    '',
    `${run.startedAt.slice(0, 16).replace('T', ' ')} UTC · ${run.attempts.length} attempts (${run.repeat} per task) · **${Math.round(s.passRate * 100)}% passed**` +
      (s.infraErrors
        ? ` · ${s.infraErrors} attempt(s) excluded for infrastructure errors (timeouts, API errors)`
        : ''),
    '',
    '| Suite | Passed |',
    '| ----- | ------ |',
    ...Object.entries(s.bySuite).map(
      ([k, v]) => `| ${k} | ${v.passes}/${v.attempts} (${pct(v.passes, v.attempts)}) |`,
    ),
    '',
    '| Task | What it tests | Passed | Avg calls | Avg tool errors | Avg time | Failed checks |',
    '| ---- | ------------- | ------ | --------- | --------------- | -------- | ------------- |',
    ...s.tasks.map(
      (t) =>
        `| \`${t.taskId}\` | ${esc(intent.get(t.taskId) ?? '')} | ${t.passes}/${t.attempts} | ${t.avgCalls.toFixed(1)} | ${t.avgErrors.toFixed(1)} | ${t.avgSeconds.toFixed(0)} s | ${esc(
          t.failedChecks
            .map(
              (f) =>
                `${f.name}${t.attempts > 1 ? ` (×${f.count})` : ''}${f.detail ? `: ${f.detail.slice(0, 120)}` : ''}`,
            )
            .join('; ') || '—',
        )} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
