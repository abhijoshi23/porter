import type { Driver, Task, Trace } from '../types.js';

/**
 * Returns prepared traces instead of running a model. Used to test the runner, checks and
 * report deterministically (and in CI, where no model is available).
 */
export class ScriptedDriver implements Driver {
  readonly label = 'scripted';

  constructor(private readonly traces: Record<string, Trace | ((attempt: number) => Trace)>) {}

  private seen = new Map<string, number>();

  async run(task: Task): Promise<Trace> {
    const n = (this.seen.get(task.id) ?? 0) + 1;
    this.seen.set(task.id, n);
    const t = this.traces[task.id];
    if (!t) return { calls: [], answer: '', turns: 0, durationMs: 0, error: 'no scripted trace' };
    return typeof t === 'function' ? t(n) : t;
  }
}
