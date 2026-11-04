/** Which Porter server a task needs. Each maps to a built binary (see servers.ts). */
export type ServerId = 'opendata' | 'transit' | 'tenders' | 'quickbooks';

export interface ToolCall {
  /** Bare tool name, e.g. `next_departures` (driver prefixes like `mcp__porter-transit__` are stripped). */
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** First ~300 characters of the result text, for reading failed runs. */
  resultPreview: string;
}

/** Everything a driver observed while a model worked on one task. Drivers produce it; checks read it. */
export interface Trace {
  calls: ToolCall[];
  /** The model's final answer to the user. */
  answer: string;
  turns: number;
  durationMs: number;
  /** Why the run ended abnormally. */
  error?: string;
  /**
   * True when the failure is the harness's or the machine's (timeout, API error, laptop
   * asleep), not the model's. Such attempts are reported but left out of pass rates.
   * A model looping until the turn limit is the model's failure, not infrastructure.
   */
  infraError?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

/** A deterministic assertion over a trace. No LLM judge: reproducible, and free. */
export interface Check {
  name: string;
  run: (t: Trace) => CheckResult;
}

export interface Task {
  /** Stable id, e.g. `transit/go-kitchener-union`. Results are compared across runs by id. */
  id: string;
  servers: ServerId[];
  /** What a user would type. */
  prompt: string;
  /** What this task tests, for the report. */
  intent: string;
  checks: Check[];
}

export interface Driver {
  /** e.g. `claude-code:haiku`, `ollama:qwen2.5-coder:7b`. */
  readonly label: string;
  run(task: Task, servers: ServerLaunch[]): Promise<Trace>;
}

export interface ServerLaunch {
  id: ServerId;
  /** MCP server name as clients see it, e.g. `porter-transit`. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
