import type { Check, CheckResult, Task, ToolCall, Trace } from './types.js';

/**
 * Check builders. A task passes when all its checks pass. Every check is a pure function
 * of the trace, so scoring is deterministic and unit-testable without a model.
 *
 * Checks are written against live data (schedules and statistics change), so they test
 * behaviour, not exact values that will drift: "called next_departures for HSR", "said the
 * time is scheduled, not live", "cited the DOI".
 */

/** An argument matcher: exact value, a regex for strings, or a predicate. */
export type ArgMatcher = string | number | boolean | RegExp | ((v: unknown) => boolean);

function matches(m: ArgMatcher, v: unknown): boolean {
  if (m instanceof RegExp) return typeof v === 'string' && m.test(v);
  if (typeof m === 'function') return m(v);
  if (typeof m === 'string' && typeof v === 'string') return m.toLowerCase() === v.toLowerCase();
  return m === v;
}

function describeArgs(args: Record<string, ArgMatcher>): string {
  return Object.entries(args)
    .map(
      ([k, v]) =>
        `${k}=${v instanceof RegExp ? v.toString() : typeof v === 'function' ? '<fn>' : JSON.stringify(v)}`,
    )
    .join(', ');
}

const callsMatching = (t: Trace, tool: string, args?: Record<string, ArgMatcher>) =>
  t.calls.filter(
    (c) =>
      c.name === tool &&
      !c.isError &&
      Object.entries(args ?? {}).every(([k, m]) => matches(m, c.args[k])),
  );

const ok = (name: string, pass: boolean, detail?: string): CheckResult => ({
  name,
  pass,
  ...(detail ? { detail } : {}),
});

/**
 * The tool was called successfully at least once, with arguments matching `args` and,
 * if given, a result matching `result`. Checking the result matters when the server
 * resolves for the model (a stop name to the right station): the outcome is what counts.
 */
export function called(
  tool: string,
  args?: Record<string, ArgMatcher>,
  o: { result?: RegExp } = {},
): Check {
  const name = `called ${tool}${args ? `(${describeArgs(args)})` : ''}${o.result ? ` → ${o.result}` : ''}`;
  return {
    name,
    run: (t) => {
      const hit = callsMatching(t, tool, args).filter(
        (c) => !o.result || o.result.test(c.resultPreview),
      );
      const same = t.calls.filter((c) => c.name === tool);
      return ok(
        name,
        hit.length > 0,
        hit.length
          ? undefined
          : same.length
            ? `calls were: ${same.map((c) => JSON.stringify(c.args) + (c.isError ? ' (error)' : '')).join('; ')}`
            : 'never called',
      );
    },
  };
}

export function notCalled(tool: string): Check {
  const name = `did not call ${tool}`;
  return { name, run: (t) => ok(name, !t.calls.some((c) => c.name === tool)) };
}

/** Efficiency: at most `n` tool calls in total. */
export function maxCalls(n: number): Check {
  const name = `at most ${n} tool calls`;
  return { name, run: (t) => ok(name, t.calls.length <= n, `${t.calls.length} calls`) };
}

/** The first call to `a` happens before the first successful call to `b` (chaining). */
export function before(a: string, b: string): Check {
  const name = `${a} before ${b}`;
  return {
    name,
    run: (t) => {
      const ia = t.calls.findIndex((c) => c.name === a);
      const ib = t.calls.findIndex((c) => c.name === b && !c.isError);
      return ok(name, ia !== -1 && ib !== -1 && ia < ib);
    },
  };
}

/** The final answer matches the regex. */
export function answer(re: RegExp, label?: string): Check {
  const name = label ?? `answer matches ${re}`;
  return {
    name,
    run: (t) =>
      ok(
        name,
        re.test(t.answer),
        re.test(t.answer) ? undefined : `answer: ${t.answer.slice(0, 200)}`,
      ),
  };
}

export function answerNot(re: RegExp, label?: string): Check {
  const name = label ?? `answer does not match ${re}`;
  return { name, run: (t) => ok(name, !re.test(t.answer)) };
}

/** Passes if any of the alternatives passes, e.g. "picked the CMA" or "asked which Waterloo". */
export function anyOf(label: string, ...alts: Check[]): Check {
  return {
    name: label,
    run: (t) => {
      const rs = alts.map((c) => c.run(t));
      const pass = rs.some((r) => r.pass);
      return ok(
        label,
        pass,
        pass ? `via ${rs.find((r) => r.pass)!.name}` : rs.map((r) => r.name).join(' | '),
      );
    },
  };
}

/** The run finished with an answer (no crash, timeout or empty reply). */
export const answered: Check = {
  name: 'produced an answer',
  run: (t) => ok('produced an answer', !t.error && t.answer.trim().length > 0, t.error),
};

export interface TaskScore {
  taskId: string;
  pass: boolean;
  checks: CheckResult[];
}

export function score(task: Task, trace: Trace): TaskScore {
  const checks = [answered, ...task.checks].map((c) => c.run(trace));
  return { taskId: task.id, pass: checks.every((c) => c.pass), checks };
}

export function defineTask(t: Task): Task {
  return t;
}

/** Strips `mcp__<server>__` (Claude Code) or `<server>__` prefixes. */
export function bareToolName(name: string): string {
  const m = /^(?:mcp__)?[\w-]+?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

export type { ToolCall };
