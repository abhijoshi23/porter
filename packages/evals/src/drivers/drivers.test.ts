import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { parseStreamJson } from './claude-code.js';
import { OllamaDriver, textToolCalls, type ChatFn, type ToolHost } from './ollama.js';

describe('Claude Code stream-json parsing', () => {
  it('pairs tool_use with tool_result and takes the final result text', () => {
    const lines = [
      { type: 'system', subtype: 'init', tools: ['mcp__porter-transit__next_departures'] },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'mcp__porter-transit__next_departures',
              input: { agency: 'GO Transit', stop: 'Union' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              is_error: true,
              content: [{ type: 'text', text: 'Unknown agency "GO Transit".' }],
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu2',
              name: 'mcp__porter-transit__next_departures',
              input: { agency: 'go', stop: 'id:UN' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'LW at 15:17' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Next: 15:17 (scheduled).' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 3,
        result: 'Next: 15:17 (scheduled).',
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 20 },
      },
    ];
    const t = parseStreamJson(['not json', ...lines.map((l) => JSON.stringify(l))].join('\n'));
    expect(t.calls).toEqual([
      {
        name: 'next_departures',
        args: { agency: 'GO Transit', stop: 'Union' },
        isError: true,
        resultPreview: 'Unknown agency "GO Transit".',
      },
      {
        name: 'next_departures',
        args: { agency: 'go', stop: 'id:UN' },
        isError: false,
        resultPreview: 'LW at 15:17',
      },
    ]);
    expect(t).toMatchObject({
      answer: 'Next: 15:17 (scheduled).',
      turns: 3,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(t.error).toBeUndefined();
  });

  it('flags runs that ended in error', () => {
    const t = parseStreamJson(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 30 }),
    );
    expect(t.error).toContain('error_max_turns');
  });
});

describe('Ollama driver', () => {
  const task: Task = {
    id: 'transit/x',
    servers: ['transit'],
    prompt: 'Next GO train from Kitchener?',
    intent: '',
    checks: [],
  };

  function fakeHost(log: string[]): ToolHost {
    return {
      tools: [{ name: 'plan_simple_trip', description: 'trips', inputSchema: { type: 'object' } }],
      instructions: ['Ontario transit.'],
      call: async (name, args) => {
        log.push(`${name} ${JSON.stringify(args)}`);
        return args.agency === 'go'
          ? { text: 'KI 06:07 → 07:47', isError: false }
          : { text: 'Unknown agency', isError: true };
      },
      close: async () => undefined,
    };
  }

  it('runs the tool loop, including text-encoded tool calls, until the model answers', async () => {
    const replies = [
      // qwen2.5-coder style: the call as JSON text, no tool_calls
      {
        role: 'assistant',
        content:
          '```json\n{"name": "plan_simple_trip", "arguments": {"agency": "GO Transit"}}\n```',
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'plan_simple_trip', arguments: { agency: 'go' } } }],
      },
      { role: 'assistant', content: 'The 06:07 train arrives 07:47 (scheduled).' },
    ] as const;
    const seen: unknown[] = [];
    const chat: ChatFn = async (req) => {
      seen.push(req.messages.map((m) => m.role));
      return {
        message: replies[seen.length - 1]! as never,
        prompt_eval_count: 100,
        eval_count: 10,
      };
    };
    const log: string[] = [];
    const driver = new OllamaDriver({ model: 'm', chat, connect: async () => fakeHost(log) });
    const t = await driver.run(task, []);
    expect(log).toEqual([
      'plan_simple_trip {"agency":"GO Transit"}',
      'plan_simple_trip {"agency":"go"}',
    ]);
    expect(t.calls.map((c) => c.isError)).toEqual([true, false]);
    expect(t).toMatchObject({
      answer: 'The 06:07 train arrives 07:47 (scheduled).',
      turns: 3,
      usage: { inputTokens: 300, outputTokens: 30 },
    });
    // The system prompt carries the server instructions, like Claude Code does.
    expect(seen[0]).toEqual(['system', 'user']);
  });

  it('stops at the turn limit with an error', async () => {
    const chat: ChatFn = async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'plan_simple_trip', arguments: { agency: 'x' } } }],
      },
    });
    const t = await new OllamaDriver({
      model: 'm',
      chat,
      maxTurns: 2,
      connect: async () => fakeHost([]),
    }).run(task, []);
    expect(t.error).toContain('turn limit');
    expect(t.calls).toHaveLength(2);
  });

  it('only treats text as a tool call when it is pure JSON naming a real tool', () => {
    const known = new Set(['plan_simple_trip']);
    expect(textToolCalls('{"name":"plan_simple_trip","arguments":{"a":1}}', known)).toHaveLength(1);
    expect(textToolCalls('{"name":"rm_rf","arguments":{}}', known)).toEqual([]);
    expect(textToolCalls('The answer is {"name":"plan_simple_trip"}', known)).toEqual([]);
    expect(textToolCalls('not json', known)).toEqual([]);
  });
});
