import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Driver, ServerLaunch, Task, ToolCall, Trace } from '../types.js';

/**
 * Runs a task against a local model through Ollama: free and fully offline. Ollama has
 * no MCP support, so this driver is the agent loop:
 *
 *   1. Start the task's Porter servers over stdio (a real MCP client, like Claude Desktop).
 *   2. Send the model the prompt, the servers' `instructions` as the system prompt, and
 *      every tool's name, description and JSON Schema in Ollama's `tools` format.
 *   3. When the model asks for tool calls, run them over MCP and send back the result
 *      text. Repeat until it answers without a tool call, or `maxTurns` is reached.
 *
 * Small local models sometimes write the call as JSON in the message text instead of
 * using `tool_calls` (qwen2.5-coder does this). If the whole reply is such JSON naming a
 * real tool, it is treated as a tool call. Without this fallback those models would score
 * zero for a formatting quirk, which says nothing about Porter's tool design.
 */

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
  tool_name?: string;
}

export type ChatFn = (req: {
  model: string;
  messages: OllamaMessage[];
  tools: unknown[];
}) => Promise<{ message: OllamaMessage; prompt_eval_count?: number; eval_count?: number }>;

export interface ToolHost {
  tools: { name: string; description?: string; inputSchema: unknown }[];
  instructions: string[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export class OllamaDriver implements Driver {
  readonly label: string;

  constructor(
    private readonly o: {
      model: string;
      host?: string;
      maxTurns?: number;
      /** Injected in tests. */
      chat?: ChatFn;
      connect?: (servers: ServerLaunch[]) => Promise<ToolHost>;
    },
  ) {
    this.label = `ollama:${o.model}`;
  }

  async run(task: Task, servers: ServerLaunch[]): Promise<Trace> {
    const started = Date.now();
    const chat = this.o.chat ?? ollamaChat(this.o.host ?? 'http://127.0.0.1:11434');
    const host = await (this.o.connect ?? connectStdio)(servers);
    const calls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const toolNames = new Set(host.tools.map((t) => t.name));
      const tools = host.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
      }));
      const messages: OllamaMessage[] = [
        {
          role: 'system',
          content:
            'You are a helpful assistant with tools. Use them to answer; do not make up data.\n\n' +
            host.instructions.join('\n\n'),
        },
        { role: 'user', content: task.prompt },
      ];
      for (let turn = 1; turn <= (this.o.maxTurns ?? 10); turn++) {
        const res = await chat({ model: this.o.model, messages, tools });
        inputTokens += res.prompt_eval_count ?? 0;
        outputTokens += res.eval_count ?? 0;
        const msg = res.message;
        const requested = msg.tool_calls?.length
          ? msg.tool_calls
          : textToolCalls(msg.content, toolNames);
        messages.push({
          role: 'assistant',
          content: msg.content,
          ...(requested.length ? { tool_calls: requested } : {}),
        });
        if (requested.length === 0) {
          return {
            calls,
            answer: msg.content,
            turns: turn,
            durationMs: Date.now() - started,
            usage: { inputTokens, outputTokens },
          };
        }
        for (const tc of requested) {
          const name = tc.function.name;
          const args = parseArgs(tc.function.arguments);
          const r = toolNames.has(name)
            ? await host.call(name, args)
            : {
                text: `Unknown tool "${name}". Available: ${[...toolNames].join(', ')}.`,
                isError: true,
              };
          calls.push({ name, args, isError: r.isError, resultPreview: r.text.slice(0, 300) });
          messages.push({ role: 'tool', tool_name: name, content: r.text });
        }
      }
      return {
        calls,
        answer: '',
        turns: this.o.maxTurns ?? 10,
        durationMs: Date.now() - started,
        error: 'reached the turn limit without answering',
        usage: { inputTokens, outputTokens },
      };
    } catch (err) {
      return {
        calls,
        answer: '',
        turns: 0,
        durationMs: Date.now() - started,
        error: String(err),
        infraError: true,
      };
    } finally {
      await host.close();
    }
  }
}

function parseArgs(a: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof a !== 'string') return a ?? {};
  try {
    return JSON.parse(a) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The fallback described above. Exported for tests. */
export function textToolCalls(
  content: string,
  known: Set<string>,
): NonNullable<OllamaMessage['tool_calls']> {
  const body = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  if (!body.startsWith('{') && !body.startsWith('[')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: NonNullable<OllamaMessage['tool_calls']> = [];
  for (const it of items) {
    const o = it as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof o?.name !== 'string' || !known.has(o.name)) return [];
    const args = (o.arguments ?? o.parameters ?? {}) as Record<string, unknown>;
    out.push({ function: { name: o.name, arguments: args } });
  }
  return out;
}

function ollamaChat(host: string): ChatFn {
  return async (req) => {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...req,
        stream: false,
        // Deterministic, and a context big enough for tool schemas plus results
        // (Ollama's default context is too small and silently truncates).
        options: { temperature: 0, num_ctx: 16_384 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    return (await res.json()) as Awaited<ReturnType<ChatFn>>;
  };
}

async function connectStdio(servers: ServerLaunch[]): Promise<ToolHost> {
  const clients = await Promise.all(
    servers.map(async (s) => {
      const client = new Client({ name: 'porter-eval', version: '0' });
      await client.connect(
        new StdioClientTransport({
          command: s.command,
          args: s.args,
          env: { ...process.env, ...s.env } as Record<string, string>,
        }),
      );
      return client;
    }),
  );
  const owners = new Map<string, Client>();
  const tools: ToolHost['tools'] = [];
  for (const c of clients) {
    for (const t of (await c.listTools()).tools) {
      owners.set(t.name, c);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  }
  return {
    tools,
    instructions: clients.map((c) => c.getInstructions() ?? '').filter(Boolean),
    async call(name, args) {
      const r = await owners.get(name)!.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[])
        .map((b) => b.text ?? '')
        .join('\n');
      return { text, isError: Boolean(r.isError) };
    },
    async close() {
      await Promise.all(clients.map((c) => c.close()));
    },
  };
}
