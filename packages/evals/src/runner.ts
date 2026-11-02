import { score, type TaskScore } from './checks.js';
import { serverLaunches } from './servers.js';
import type { Driver, Task, Trace } from './types.js';

export interface Attempt {
  taskId: string;
  attempt: number;
  score: TaskScore;
  trace: Trace;
}

export interface RunResult {
  driver: string;
  startedAt: string;
  finishedAt: string;
  repeat: number;
  attempts: Attempt[];
}

/**
 * Runs every task `repeat` times. Model output varies run to run, so a single pass/fail
 * says little; `repeat: 3` gives a pass rate per task. Tasks run with limited
 * concurrency to keep load on public APIs (and the local machine) polite.
 */
export async function runTasks(o: {
  tasks: Task[];
  driver: Driver;
  repeat?: number;
  concurrency?: number;
  cacheDir: string;
  onAttempt?: (a: Attempt) => void;
}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const repeat = o.repeat ?? 1;
  const queue = o.tasks.flatMap((task) =>
    Array.from({ length: repeat }, (_, i) => ({ task, attempt: i + 1 })),
  );
  const attempts: Attempt[] = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const servers = serverLaunches(job.task.servers, { cacheDir: o.cacheDir });
      let trace: Trace;
      try {
        trace = await o.driver.run(job.task, servers);
      } catch (err) {
        trace = {
          calls: [],
          answer: '',
          turns: 0,
          durationMs: 0,
          error: String(err),
          infraError: true,
        };
      }
      const a = { taskId: job.task.id, attempt: job.attempt, score: score(job.task, trace), trace };
      attempts.push(a);
      o.onAttempt?.(a);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, worker));
  // Stable order for reports and diffs, whatever order workers finished in.
  const index = new Map(o.tasks.map((t, i) => [t.id, i]));
  attempts.sort((a, b) => index.get(a.taskId)! - index.get(b.taskId)! || a.attempt - b.attempt);
  return {
    driver: o.driver.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    repeat,
    attempts,
  };
}
