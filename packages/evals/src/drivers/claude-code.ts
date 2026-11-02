import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bareToolName } from '../checks.js';
import type { Driver, ServerLaunch, Task, ToolCall, Trace } from '../types.js';

/**
 * Runs a task through Claude Code in headless mode (`claude -p`), using the owner's
 * existing Claude login, so evals cost nothing beyond the subscription.
 *
 * Isolation, so the score reflects Porter's tools and nothing else:
 * - `--tools ""` turns off Claude Code's built-in tools (Bash, Read, WebFetch…), so the
 *   model can't route around Porter by searching the web.
 * - `--strict-mcp-config --mcp-config` loads only the task's Porter servers.
 * - `--setting-sources ""` ignores user and project settings (hooks, permissions).
 * - The working directory is an empty temp dir: no CLAUDE.md, no project memory.
 * - `--no-session-persistence` leaves nothing behind.
 * Not `--bare`: it would require an API key (paid) instead of the login.
 *
 * Output is `--output-format stream-json --verbose`: one JSON object per line, with the
 * assistant's tool_use blocks, the user-side tool_result blocks, and a final `result`.
 */
export class ClaudeCodeDriver implements Driver {
  readonly label: string;

  constructor(private readonly o: { bin: string; model: string; timeoutMs?: number }) {
    this.label = `claude-code:${o.model}`;
  }

  async run(task: Task, servers: ServerLaunch[]): Promise<Trace> {
    const dir = await mkdtemp(join(tmpdir(), 'porter-eval-'));
    const config = {
      mcpServers: Object.fromEntries(
        servers.map((s) => [s.name, { command: s.command, args: s.args, env: s.env }]),
      ),
    };
    await writeFile(join(dir, 'mcp.json'), JSON.stringify(config));
    const args = [
      '-p',
      task.prompt,
      '--model',
      this.o.model,
      '--mcp-config',
      'mcp.json',
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      ...servers.map((s) => `mcp__${s.name}__*`),
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    const started = Date.now();
    try {
      const { stdout, code, timedOut, stderr } = await exec(
        this.o.bin,
        args,
        dir,
        this.o.timeoutMs ?? 300_000,
      );
      const trace = parseStreamJson(stdout);
      trace.durationMs = Date.now() - started;
      if (timedOut) {
        trace.error = 'timed out';
        trace.infraError = true;
      } else if (code !== 0 && !trace.answer) {
        trace.error = `exit ${code}: ${stderr.slice(0, 300)}`;
        trace.infraError = true;
      }
      return trace;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function exec(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // stdin closed: headless mode otherwise waits 3 s for piped input.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** Turns Claude Code's stream-json lines into a Trace. Exported for tests. */
export function parseStreamJson(stdout: string): Trace {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  let answer = '';
  let lastText = '';
  let turns = 0;
  let usage: Trace['usage'];
  let error: string | undefined;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let o: {
      type?: string;
      subtype?: string;
      message?: { content?: Block[] | string };
      result?: string;
      num_turns?: number;
      is_error?: boolean;
      usage?: Record<string, number>;
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // not every line is guaranteed to be JSON (e.g. warnings)
    }
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === 'assistant') {
      for (const b of content) {
        if (b.type === 'tool_use' && b.id && b.name) {
          calls.set(b.id, {
            name: bareToolName(b.name),
            args: b.input ?? {},
            isError: false,
            resultPreview: '',
          });
          order.push(b.id);
        } else if (b.type === 'text' && b.text) {
          lastText = b.text;
        }
      }
    } else if (o.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const c = calls.get(b.tool_use_id);
        if (!c) continue;
        c.isError = Boolean(b.is_error);
        c.resultPreview = resultText(b.content).slice(0, 300);
      }
    } else if (o.type === 'result') {
      answer = typeof o.result === 'string' ? o.result : lastText;
      turns = o.num_turns ?? 0;
      if (o.is_error) error = `run ended with ${o.subtype ?? 'error'}`;
      if (o.usage) {
        usage = {
          inputTokens:
            (o.usage.input_tokens ?? 0) +
            (o.usage.cache_creation_input_tokens ?? 0) +
            (o.usage.cache_read_input_tokens ?? 0),
          outputTokens: o.usage.output_tokens ?? 0,
        };
      }
    }
  }
  // Claude Code reports transport problems as the answer text, e.g. "API Error: Your
  // computer went to sleep mid-response." That's the machine, not the model.
  const apiError = /^API Error\b/.test(answer.trim());
  if (apiError) error = answer.trim().slice(0, 200);
  return {
    calls: order.map((id) => calls.get(id)!),
    answer: apiError ? '' : answer || lastText,
    ...(apiError ? { infraError: true } : {}),
    turns,
    durationMs: 0,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
  };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c.text ?? '').join('\n');
  }
  return '';
}
