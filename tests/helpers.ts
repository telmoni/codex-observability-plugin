/**
 * Fixtures, all synthetic: a rollout written as Codex 0.167 writes one, the `Stop` and `SessionEnd` payloads it hands a
 * hook, a home folder of the test's own, a stand-in for Telmoni, and the marked phrases nothing of a session may leak
 * past.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport } from 'telmoni';
import { afterAll, expect } from 'vitest';

import { type Stop, readStop } from '../src/payload.js';
import { stateDir } from '../src/paths.js';
import { type WorkOptions, work } from '../src/worker.js';

export const SESSION = '019a6f2e-5c00-7d2a-9b1e-4f0c3a2b1d10';
export const KEY = 'tm_test_0123456789abcdef';
/** The session's start: the clock moves a second a line unless told otherwise. */
export const T0 = Date.parse('2026-11-06T22:00:00.000Z');

/**
 * Phrases planted wherever a session says something, or names a place: none may reach an export, the state or the log
 * while content is off.
 */
export const SECRETS = {
  prompt: 'SECRET-PROMPT-7f3a',
  instructions: 'SECRET-INSTRUCTIONS-0a1b',
  reply: 'SECRET-REPLY-91bc',
  reasoning: 'SECRET-REASONING-2d4e',
  encrypted: 'SECRET-ENCRYPTED-3e5f',
  code: 'SECRET-CODE-5a6b',
  command: 'SECRET-COMMAND-6b7c',
  output: 'SECRET-OUTPUT-c8d9',
  diff: 'SECRET-DIFF-7c8d',
  path: 'secret-file-8d9e.ts',
  mcp: 'SECRET-MCP-ARGS-9e0f',
  query: 'SECRET-QUERY-0f1a',
  error: 'SECRET-ERROR-e0f1',
  summary: 'SECRET-SUMMARY-3c4d',
  lastReply: 'SECRET-LAST-REPLY-6a7b',
  workspace: 'secret-workspace-8c9d',
  repository: 'secret-repository-1b2c',
} as const;

/** Fails on any marked phrase, the key, or the rollout's or workspace's path in `text`. */
export function assertMetadataOnly(text: string, also: readonly string[] = []): void {
  for (const secret of [...Object.values(SECRETS), KEY, ...also]) {
    expect(text.includes(secret), `"${secret}" leaked`).toBe(false);
  }
}

export interface Tokens {
  input: number;
  cached?: number;
  cacheWrite?: number;
  output: number;
  reasoning?: number;
}

let ids = 0;

/** A UUID version 7 as Codex mints a turn's or a session's id, its time the clock's. */
export function uuid7(at: number): string {
  ids += 1;
  const hex = at.toString(16).padStart(12, '0') + ids.toString(16).padStart(20, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A session's rollout, written a line at a time as Codex 0.167 writes it. */
export class Rollout {
  readonly path: string;
  readonly cwd: string;
  /** The lines written so far, in order. */
  readonly lines: Array<Record<string, unknown>> = [];
  /** The turn being written, and every turn begun, by id. */
  turnId: string | undefined;
  readonly turns: string[] = [];
  model = 'gpt-6-sol';
  effort = 'high';
  #clock = T0;
  #ordinal = 0;

  constructor(
    home: string,
    readonly sessionId: string = SESSION,
    meta: Record<string, unknown> = {},
  ) {
    const folder = join(home, '.codex', 'sessions', '2026', '11', '06');
    mkdirSync(folder, { recursive: true });
    this.path = join(folder, `rollout-2026-11-06T22-00-00-${sessionId}.jsonl`);
    this.cwd = join(home, SECRETS.workspace);
    mkdirSync(this.cwd, { recursive: true });
    this.#line('session_meta', {
      id: sessionId,
      session_id: sessionId,
      timestamp: new Date(this.#clock).toISOString(),
      cwd: this.cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.167.0',
      model_provider: 'openai',
      source: 'cli',
      git: {
        branch: 'main',
        commit_hash: 'abc123',
        repository_url: `https://github.com/someone/${SECRETS.repository}.git`,
      },
      history_mode: 'full',
      ...meta,
    });
  }

  /** The clock, in ms: the time the next line is written at. */
  get now(): number {
    return this.#clock;
  }

  wait(seconds: number): this {
    this.#clock += seconds * 1000;
    return this;
  }

  #line(type: string, payload: Record<string, unknown>, step = 1000): void {
    const line = {
      timestamp: new Date(this.#clock).toISOString(),
      ordinal: this.#ordinal++,
      type,
      payload,
    };
    this.lines.push(line);
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.#clock += step;
  }

  #event(payload: Record<string, unknown>, step?: number): void {
    this.#line('event_msg', payload, step);
  }

  #item(payload: Record<string, unknown>, step?: number): void {
    this.#line(
      'response_item',
      {
        ...payload,
        internal_chat_message_metadata_passthrough: {
          turn_id: this.turnId,
          create_time: this.#clock / 1000,
        },
      },
      step,
    );
  }

  #completed(item: Record<string, unknown>, ms: number): void {
    this.#event(
      {
        type: 'item_completed',
        thread_id: this.sessionId,
        turn_id: this.turnId,
        started_at_ms: this.#clock,
        completed_at_ms: this.#clock + ms,
        item: { id: `item_${this.lines.length}`, ...item },
      },
      ms + 1000,
    );
  }

  /** A turn's opening: its start, its context, the instructions Codex hands the model, and the prompt. */
  prompt(text: string = SECRETS.prompt): string {
    this.turnId = uuid7(this.#clock);
    this.turns.push(this.turnId);
    const started = Math.floor(this.#clock / 1000);
    this.#event({
      type: 'task_started',
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      started_at: started,
      model_context_window: 400000,
      collaboration_mode_kind: 'default',
      turn_attribution: { turn_id: this.turnId, root_turn_id: this.turnId, turn_trigger: 'user' },
    });
    if (this.turns.length === 1) {
      this.#item({
        type: 'message',
        id: `msg_dev_${this.lines.length}`,
        role: 'developer',
        content: [{ type: 'input_text', text: SECRETS.instructions }],
      });
      this.#line('world_state', {
        full: true,
        state: { agents_md: { text: SECRETS.instructions } },
      });
    }
    this.#line('turn_context', {
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      summary: 'auto',
      approval_policy: 'on-request',
      sandbox_policy: { type: 'workspace-write' },
    });
    this.#event({
      type: 'thread_settings_applied',
      thread_id: this.sessionId,
      thread_settings: {
        model: this.model,
        model_provider_id: 'openai',
        reasoning_effort: this.effort,
        cwd: this.cwd,
      },
    });
    this.#item({
      type: 'message',
      id: `msg_user_${this.lines.length}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
    });
    this.#completed(
      { type: 'UserMessage', content: [{ type: 'text', text, text_elements: [] }] },
      0,
    );
    return this.turnId;
  }

  /**
   * One model response: its reasoning and words, the `exec` it calls with code where `tool` is set, then its tokens'
   * record, written as the response ends.
   */
  reply(options: { tokens?: Tokens; tool?: boolean; text?: string } = {}): this {
    const tokens = options.tokens ?? { input: 15000, cached: 12000, output: 120, reasoning: 40 };
    this.#completed({ type: 'Reasoning', summary_text: [SECRETS.reasoning] }, 0);
    this.#item({
      type: 'reasoning',
      id: `rs_${this.lines.length}`,
      summary: [{ type: 'summary_text', text: SECRETS.reasoning }],
      encrypted_content: SECRETS.encrypted,
    });
    const words = options.text ?? SECRETS.reply;
    this.#completed(
      { type: 'AgentMessage', content: [{ type: 'output_text', text: words }], phase: 'final' },
      0,
    );
    this.#item({
      type: 'message',
      id: `msg_${this.lines.length}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: words }],
    });
    if (options.tool === true)
      this.#item({
        type: 'custom_tool_call',
        id: `ctc_${this.lines.length}`,
        call_id: `call_${this.lines.length}`,
        name: 'exec',
        input: SECRETS.code,
        status: 'completed',
      });
    const usage = {
      input_tokens: tokens.input,
      cached_input_tokens: tokens.cached ?? 0,
      cache_write_input_tokens: tokens.cacheWrite ?? 0,
      output_tokens: tokens.output,
      reasoning_output_tokens: tokens.reasoning ?? 0,
      total_tokens: tokens.input + tokens.output,
    };
    this.#line('token_usage_record', {
      response_id: `resp_${this.lines.length}`,
      session_id: this.sessionId,
      thread_id: this.sessionId,
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      usage,
      turn_token_usage: usage,
      thread_token_usage: usage,
    });
    this.#event({
      type: 'token_count',
      info: { last_token_usage: usage, total_token_usage: usage, model_context_window: 400000 },
      rate_limits: null,
    });
    return this;
  }

  /** A command the `exec` ran, lasting `ms`. */
  command(
    options: { exitCode?: number; ms?: number; status?: string; source?: string } = {},
  ): this {
    const exitCode = options.exitCode ?? 0;
    this.#completed(
      {
        type: 'CommandExecution',
        command: ['bash', '-lc', SECRETS.command],
        cwd: this.cwd,
        process_id: '41234',
        source: options.source ?? 'unified_exec_startup',
        status: options.status ?? (exitCode === 0 ? 'completed' : 'failed'),
        aggregated_output: SECRETS.output,
        exit_code: exitCode,
        duration: { secs: Math.floor((options.ms ?? 1500) / 1000), nanos: 0 },
        parsed_cmd: [{ type: 'unknown', cmd: SECRETS.command }],
      },
      options.ms ?? 1500,
    );
    return this;
  }

  /** A patch the `exec` applied to one file. */
  edit(options: { status?: string } = {}): this {
    this.#completed(
      {
        type: 'FileChange',
        changes: { [join(this.cwd, SECRETS.path)]: { type: 'update', unified_diff: SECRETS.diff } },
        status: options.status ?? 'completed',
        stdout: SECRETS.output,
        stderr: '',
      },
      200,
    );
    return this;
  }

  /** An MCP server's tool the model called. */
  mcp(server: string, tool: string, options: { error?: boolean } = {}): this {
    this.#completed(
      {
        type: 'McpToolCall',
        server,
        tool,
        status: options.error === true ? 'failed' : 'completed',
        arguments: { q: SECRETS.mcp },
        result:
          options.error === true ? null : { content: [{ type: 'text', text: SECRETS.output }] },
        error: options.error === true ? { message: SECRETS.error } : null,
      },
      800,
    );
    return this;
  }

  /** A web search, which Codex 0.167 writes as an extension's item. */
  search(): this {
    this.#completed(
      {
        type: 'Extension',
        kind: 'web.search',
        query: SECRETS.query,
        action: { type: 'search', queries: [SECRETS.query] },
        results: [{ type: 'result', title: SECRETS.output, url: 'https://example.com/' }],
      },
      900,
    );
    return this;
  }

  /** The `exec`'s output, handed back to the model. */
  toolOutput(): this {
    this.#item({
      type: 'custom_tool_call_output',
      id: `ctco_${this.lines.length}`,
      call_id: `call_${this.lines.length}`,
      output: [{ type: 'input_text', text: SECRETS.output }],
    });
    return this;
  }

  /** Any other item Codex completes, lasting `ms`. */
  item(item: Record<string, unknown>, ms = 100): this {
    this.#completed(item, ms);
    return this;
  }

  /** The turn's close, the last reply in it, and the error that ended it where `error` names its kind. */
  complete(options: { error?: unknown } = {}): this {
    this.#event({
      type: 'task_complete',
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      last_agent_message: options.error === undefined ? SECRETS.lastReply : null,
      ...(options.error === undefined
        ? {}
        : { error: { message: SECRETS.error, codex_error_info: options.error } }),
      started_at: Math.floor(T0 / 1000),
      completed_at: Math.floor(this.#clock / 1000),
      duration_ms: 1000,
      time_to_first_token_ms: 400,
    });
    return this;
  }

  /** The turn stopped by the person, replaced, or out of its budget. */
  abort(reason = 'interrupted'): this {
    this.#item({
      type: 'message',
      id: `msg_abort_${this.lines.length}`,
      role: 'user',
      content: [{ type: 'input_text', text: '<turn_aborted>' }],
    });
    this.#event({ type: 'turn_aborted', turn_id: this.turnId, reason });
    return this;
  }

  /**
   * The history compacted, as Codex 0.167 writes it: the summary's own model call, the summary with the context it
   * resets, then the compaction's item, timed from before that call.
   */
  compact(): this {
    const started = this.#clock;
    this.wait(2);
    const usage = {
      input_tokens: 90000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 900,
      reasoning_output_tokens: 0,
      total_tokens: 90900,
    };
    this.#line('token_usage_record', {
      response_id: `resp_${this.lines.length}`,
      session_id: this.sessionId,
      thread_id: this.sessionId,
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      usage,
      turn_token_usage: usage,
      thread_token_usage: usage,
    });
    this.#line('compacted', {
      message: SECRETS.summary,
      replacement_history: [],
      compaction_response_id: `resp_${this.lines.length}`,
    });
    this.#line('world_state', { full: true, state: {} });
    this.#line('turn_context', {
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
    });
    this.#event({ type: 'token_count', info: null, rate_limits: null });
    const ended = this.#clock;
    this.#event({
      type: 'item_completed',
      thread_id: this.sessionId,
      turn_id: this.turnId,
      started_at_ms: started,
      completed_at_ms: ended,
      item: { type: 'ContextCompaction', id: uuid7(started) },
    });
    return this;
  }

  /** A whole turn: the prompt, a response running `commands` through the `exec`, its output, and the last reply. */
  turn(commands = 1): string {
    const id = this.prompt();
    if (commands > 0) {
      this.reply({ tool: true });
      for (let i = 0; i < commands; i++) this.command();
      this.toolOutput();
    }
    this.reply();
    this.complete();
    return id;
  }

  /** Codex's `Stop` payload for the turn being written, the last reply in it, as a hook reads it on stdin. */
  stopPayload(options: { turnId?: string } = {}): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      transcript_path: this.path,
      cwd: this.cwd,
      hook_event_name: 'Stop',
      model: this.model,
      permission_mode: 'default',
      turn_id: options.turnId ?? this.turnId,
      stop_hook_active: false,
      last_assistant_message: SECRETS.lastReply,
    };
  }

  /** Codex's `SessionEnd` payload. */
  endPayload(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      transcript_path: this.path,
      cwd: this.cwd,
      hook_event_name: 'SessionEnd',
      model: this.model,
      reason: 'other',
    };
  }

  /** The stop the hook keeps, at the clock's time, with the rollout's size as it finds it. */
  stop(options: { turnId?: string; at?: number } = {}): Stop {
    return this.#kept(this.stopPayload(options), options.at);
  }

  end(options: { at?: number } = {}): Stop {
    return this.#kept(this.endPayload(), options.at);
  }

  #kept(payload: Record<string, unknown>, at: number | undefined): Stop {
    const stop = readStop(payload, at ?? this.#clock);
    if (stop === undefined) throw new Error('the payload names no stop');
    if (existsSync(this.path)) stop.size = statSync(this.path).size;
    return stop;
  }
}

const homes: string[] = [];

/** A home folder of the test's own, its `.codex` made; removed once its file's tests are done. */
export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'telmoni-codex-'));
  homes.push(home);
  mkdirSync(join(home, '.codex'), { recursive: true });
  return home;
}

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Writes `~/.codex/telmoni.json`, mode 600 unless `mode` says another. */
export function writeKeyFile(home: string, fields: Record<string, unknown>, mode = 0o600): void {
  const path = join(home, '.codex', 'telmoni.json');
  writeFileSync(path, JSON.stringify(fields), { mode });
  chmodSync(path, mode);
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Stands in for Telmoni's ingest: keeps every export and answers as told, then with a 200 naming the content mode. */
export class FakeTelmoni {
  readonly requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  answers: Array<Answer | Error> = [];
  mode: 'on' | 'off' = 'off';
  /** Out of reach: every request fails as a network does. */
  offline = false;

  readonly send: Transport = async (url, init) => {
    if (this.offline) throw new Error('offline');
    if (init.method === 'POST')
      this.requests.push({ url, headers: { ...init.headers }, body: init.body });
    const next = init.method === 'POST' ? this.answers.shift() : { status: 204 };
    if (next instanceof Error) throw next;
    const answer = next ?? { status: 200, body: { partialSuccess: null } };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Telmoni-Content-Mode': this.mode,
      ...answer.headers,
    };
    return {
      status: answer.status,
      headers: {
        get: (name: string) =>
          Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
          null,
      },
      text: () => Promise.resolve(answer.body === undefined ? '' : JSON.stringify(answer.body)),
    };
  };

  spans(): Span[] {
    return this.requests.flatMap((request) => {
      const body = JSON.parse(request.body) as {
        resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }>;
      };
      return (body.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
      );
    });
  }

  /** The resource attributes of every export, as plain values. */
  resources(): Array<Record<string, unknown>> {
    return this.requests.flatMap((request) => {
      const body = JSON.parse(request.body) as {
        resourceSpans?: Array<{ resource?: Pick<Span, 'attributes'> }>;
      };
      return (body.resourceSpans ?? []).map((resource) =>
        attributes(resource.resource ?? { attributes: [] }),
      );
    });
  }

  /** The spans of each trace, by trace id. */
  traces(): Map<string, Span[]> {
    const traces = new Map<string, Span[]>();
    for (const span of this.spans())
      traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
    return traces;
  }

  /** Everything that left but the key, which goes in its `Authorization` header alone. */
  text(): string {
    return JSON.stringify(
      this.requests.map(({ headers: { Authorization: _, ...headers }, ...request }) => ({
        ...request,
        headers,
      })),
    );
  }
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code: number };
}

/** A span's attributes as plain values, a count as a number. */
export function attributes(span: Pick<Span, 'attributes'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of span.attributes)
    out[key] = 'intValue' in value ? Number(value.intValue) : Object.values(value)[0];
  return out;
}

export function startMs(span: Span): number {
  return Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
}

export function endMs(span: Span): number {
  return Number(BigInt(span.endTimeUnixNano) / 1_000_000n);
}

/** Runs the worker in the test's process against `home`, no waits, Telmoni the fake. */
export async function runWorker(
  stop: Stop,
  home: string,
  telmoni: FakeTelmoni,
  env: Record<string, string> = { TELMONI_API_KEY: KEY },
  extra: Partial<WorkOptions> = {},
): Promise<void> {
  await work(stop, {
    env,
    home,
    hooks: { transport: telmoni.send, sleep: () => Promise.resolve() },
    settleMs: 0,
    settleMaxMs: 0,
    lockWaitMs: 2_000,
    ...extra,
  });
}

/** The plugin's folder for `home`, as the worker finds it with no `PLUGIN_DATA`. */
export function pluginDir(home: string): string {
  return stateDir({}, home);
}

/** Everything the plugin keeps on disk: its states, markers and log. */
export function keptText(home: string): string {
  const dir = pluginDir(home);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return '';
  }
  return names.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
}

export function logOf(home: string): string {
  try {
    return readFileSync(join(pluginDir(home), 'hook.log'), 'utf8');
  } catch {
    return '';
  }
}

export function stateOf(home: string, id: string = SESSION): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginDir(home), `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}
