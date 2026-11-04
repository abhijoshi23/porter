import { describe, expect, it } from 'vitest';
import {
  answer,
  anyOf,
  bareToolName,
  before,
  called,
  maxCalls,
  noResult,
  notCalled,
  notCalledWith,
  score,
} from './checks.js';
import { ScriptedDriver } from './drivers/scripted.js';
import { summarize, toMarkdown } from './report.js';
import { runTasks } from './runner.js';
import type { Task, Trace } from './types.js';

const trace = (over: Partial<Trace> = {}): Trace => ({
  calls: [
    { name: 'find_stops', args: { agency: 'grt' }, isError: false, resultPreview: '' },
    {
      name: 'next_departures',
      args: { agency: 'GO Transit', stop: 'Union' },
      isError: true,
      resultPreview: 'Unknown agency',
    },
    {
      name: 'next_departures',
      args: { agency: 'go', stop: 'id:UN' },
      isError: false,
      resultPreview: '',
    },
  ],
  answer: 'The next train leaves at 15:17 (scheduled; GO has no live data).',
  turns: 4,
  durationMs: 1000,
  ...over,
});

describe('checks', () => {
  it('called() matches successful calls by exact (case-insensitive), regex or predicate args', () => {
    const t = trace();
    expect(called('next_departures', { agency: 'go' }).run(t).pass).toBe(true);
    expect(called('next_departures', { agency: 'GO' }).run(t).pass).toBe(true);
    expect(called('next_departures', { stop: /^id:UN$/ }).run(t).pass).toBe(true);
    // The failed call doesn't count, and the detail shows what was tried.
    const r = called('next_departures', { agency: 'GO Transit' }).run(t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('(error)');
    expect(called('route_info').run(t)).toMatchObject({ pass: false, detail: 'never called' });
  });

  it('ordering, counts, answers and alternatives', () => {
    const t = trace();
    expect(before('find_stops', 'next_departures').run(t).pass).toBe(true);
    expect(before('next_departures', 'find_stops').run(t).pass).toBe(false);
    expect(maxCalls(3).run(t).pass).toBe(true);
    expect(maxCalls(2).run(t).pass).toBe(false);
    expect(notCalled('route_info').run(t).pass).toBe(true);
    expect(answer(/schedul/i).run(t).pass).toBe(true);
    expect(anyOf('either', called('route_info'), answer(/15:17/)).run(t)).toMatchObject({
      pass: true,
      detail: 'via answer matches /15:17/',
    });
  });

  it('a crashed or empty run fails even if other checks would pass', () => {
    const task: Task = { id: 's/t', servers: [], prompt: '', intent: '', checks: [] };
    expect(score(task, trace()).pass).toBe(true);
    expect(score(task, trace({ error: 'timed out' })).pass).toBe(false);
    expect(score(task, trace({ answer: '  ' })).pass).toBe(false);
  });

  it('strips client prefixes from tool names', () => {
    expect(bareToolName('mcp__porter-transit__next_departures')).toBe('next_departures');
    expect(bareToolName('next_departures')).toBe('next_departures');
  });
});

describe('runner and report', () => {
  const tasks: Task[] = [
    {
      id: 'transit/a',
      servers: ['transit'],
      prompt: 'a',
      intent: 'first',
      checks: [called('find_stops')],
    },
    {
      id: 'opendata/b',
      servers: ['opendata'],
      prompt: 'b',
      intent: 'second | piped',
      checks: [called('search_datasets')],
    },
  ];

  it('repeats tasks, keeps a stable order, and reports pass rates per task and suite', async () => {
    const driver = new ScriptedDriver({
      'transit/a': (n) => (n === 1 ? trace() : trace({ calls: [] })),
      'opendata/b': trace(),
    });
    const run = await runTasks({ tasks, driver, repeat: 2, concurrency: 3, cacheDir: '/tmp/x' });
    expect(run.attempts.map((a) => `${a.taskId}#${a.attempt}`)).toEqual([
      'transit/a#1',
      'transit/a#2',
      'opendata/b#1',
      'opendata/b#2',
    ]);
    const s = summarize(run);
    expect(s.tasks.map((t) => [t.taskId, t.passes])).toEqual([
      ['transit/a', 1],
      ['opendata/b', 0],
    ]);
    expect(s.bySuite).toEqual({
      transit: { passes: 1, attempts: 2 },
      opendata: { passes: 0, attempts: 2 },
    });
    const md = toMarkdown(run, tasks);
    expect(md).toContain('**25% passed**');
    expect(md).toContain('second \\| piped'); // table-safe
    expect(md).toContain('called find_stops (×1)');
  });
});

describe('report escaping', () => {
  it('escapes backslashes before pipes so model text cannot break a table cell', async () => {
    const task: Task = { id: 's/t', servers: [], prompt: '', intent: 'a\\|b', checks: [] };
    const run = await runTasks({
      tasks: [task],
      driver: new ScriptedDriver({}),
      cacheDir: '/tmp/x',
    });
    expect(toMarkdown(run, [task])).toContain('a\\\\\\|b');
  });
});

describe('write-safety checks', () => {
  const t = trace({
    calls: [
      {
        name: 'create_invoice',
        args: { customer: '1' },
        isError: false,
        resultPreview: '{"status":"preview"}',
      },
      {
        name: 'create_invoice',
        args: { confirmationToken: '' },
        isError: true,
        resultPreview: 'bad',
      },
    ],
  });

  it('notCalledWith spots arguments the model should never send', () => {
    const tok = (v: unknown) => typeof v === 'string' && v.length > 0;
    expect(notCalledWith('create_invoice', { confirmationToken: tok }).run(t).pass).toBe(true);
    const sent = trace({
      calls: [
        {
          name: 'create_invoice',
          args: { confirmationToken: 'v1.x' },
          isError: true,
          resultPreview: '',
        },
      ],
    });
    // Counts even when the call failed: sending it at all is the mistake.
    expect(notCalledWith('create_invoice', { confirmationToken: tok }).run(sent).pass).toBe(false);
  });

  it('noResult looks at successful results only', () => {
    expect(noResult('create_invoice', /"status":"created"/).run(t).pass).toBe(true);
    expect(noResult('create_invoice', /preview/).run(t).pass).toBe(false);
    expect(noResult('create_invoice', /bad/).run(t).pass).toBe(true);
  });
});
