/**
 * A Codex rollout — JSON Lines of `{"timestamp", "ordinal"?, "type", "payload"}` records in two dialects, legacy and
 * paginated (`session_meta.history_mode`) — read as far as the turns' metadata goes, each line picked field by field and the rest dropped.
 */

import { closeSync, openSync, readSync } from 'node:fs';

/** Codex's count of one response's tokens: input with its cached part inside it, output with its reasoning inside it. */
export interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/** How a tool call ended, where Codex says it did not simply answer. */
export type Outcome = 'failed' | 'cancelled';

/** What the first line, `session_meta`, says of the thread. */
export interface Meta {
  threadId: string;
  sessionId: string;
  /** When the thread was made, in milliseconds since the epoch. */
  created: number | undefined;
  /** Whether it was forked or spawned from another thread, whose history its rollout may begin with. */
  derived: boolean;
  /** In a paginated subagent's rollout, the first ordinal of its own history; the records before it are its parent's. */
  ownFrom: number | undefined;
  /** Whoever serves the model, as Codex names its provider. */
  provider: string | undefined;
  /** The Codex that wrote the rollout (`cli_version`), sent as each run's release. */
  version?: string;
}

/** What a line says, as far as the plugin reads it. */
export type Event =
  // A turn opens.
  | { kind: 'start'; turnId: string }
  // A turn ends, failed where Codex gives its error's kind.
  | { kind: 'complete'; turnId: string; errorType: string | undefined }
  // A turn is cut short: interrupted, or past a budget.
  | { kind: 'aborted'; turnId: string | undefined; reason: string | undefined; errorType: string | undefined }
  // The model a turn runs on.
  | { kind: 'context'; turnId: string | undefined; model: string | undefined }
  // The model wrote something, a reply or its reasoning.
  | { kind: 'output' }
  // The model called a tool.
  | { kind: 'call'; callId: string; name: string; inPlace: boolean; outcome: Outcome | undefined }
  // The tool's answer went back.
  | { kind: 'result'; callId: string }
  // The model was given something, a prompt or an instruction.
  | { kind: 'input' }
  // Codex's own record of a tool's completion, its outcome and times.
  | {
      kind: 'done';
      callId: string;
      name: string | undefined;
      outcome: Outcome | undefined;
      startMs: number | undefined;
      endMs: number | undefined;
      durationMs: number | undefined;
    }
  // The tokens of one response, written as it completed (Codex 0.153 on).
  | { kind: 'usage'; turnId: string | undefined; responseId: string | undefined; usage: Usage }
  // A running total, as legacy rollouts give tokens: `key` names it, and `usage` is the last response's share where that reads true.
  | { kind: 'count'; key: string; usage: Usage | undefined }
  // The thread itself, on the first line.
  | { kind: 'meta'; meta: Meta }
  | { kind: 'other' };

export interface Line {
  /** Where the line begins, and where the line after it does, in bytes. */
  start: number;
  end: number;
  /** When Codex wrote it, in milliseconds since the epoch: when it was written, not when what it records happened. */
  time: number | undefined;
  /** Its place in a paginated rollout. */
  ordinal: number | undefined;
  event: Event;
}

type Fields = Record<string, unknown>;

const OTHER: Event = { kind: 'other' };

/** The object `value` is, or undefined: a line, the hook's input and the settings file are read field by field. */
export function fieldsOf(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** A turn's, a call's, a response's or a thread's id, as the rollout and the hook's input give one. */
export const TURN_ID = /^[\w.:-]{1,128}$/;
const ID = TURN_ID;

/** A turn's, a call's, a response's or a thread's id. */
function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

/** A control character, or half of a character: a lone surrogate is no text ingest can decode, and it refuses the whole export holding one. */
const UNNAMEABLE = /[\u0000-\u001f\u007f]|\p{Cs}/u;

/** A name: a model's, a tool's, a server's. Never longer than a name runs, never with a control character or a lone surrogate in it. */
export function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name !== '' && name.length <= 256 && !UNNAMEABLE.test(name) ? name : undefined;
}

const KIND = /^[a-z][a-z0-9_]{0,63}$/;

/** One of Codex's own words for a kind: `interrupted`, `context_window_exceeded`. */
function kindOf(value: unknown): string | undefined {
  return typeof value === 'string' && KIND.test(value) ? value : undefined;
}

const PROVIDER = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Codex's provider ids where the GenAI conventions, and the price table, name the same service otherwise; any other goes as Codex gives it. */
const PROVIDERS: ReadonlyMap<string, string> = new Map([['azure', 'azure.ai.openai']]);

function providerOf(value: unknown): string | undefined {
  const name = nameOf(value);
  return name !== undefined && PROVIDER.test(name) ? (PROVIDERS.get(name) ?? name) : undefined;
}

/**
 * A turn's error by its kind, Codex's own (`context_window_exceeded`, or
 * `http_connection_failed` with its status inside), never its message.
 */
function errorTypeOf(value: unknown): string | undefined {
  const error = fieldsOf(value);
  if (error === undefined) return undefined;
  const info = error['codex_error_info'];
  const variant = fieldsOf(info);
  const keys = variant === undefined ? [] : Object.keys(variant);
  return kindOf(info) ?? (keys.length === 1 ? kindOf(keys[0]) : undefined) ?? 'other';
}

/**
 * A count, as far as a number holds one exactly: no count Codex makes runs past it, and one past 10^21 would go out in
 * exponent form, which ingest refuses with the whole export.
 */
function count(value: unknown): number {
  return typeof value === 'number' && value > 0 && value <= Number.MAX_SAFE_INTEGER ? Math.trunc(value) : 0;
}

/**
 * The latest time read as one: past it, a time and a duration after it would overflow the 64 bits of nanoseconds OTLP
 * counts in, and ingest would refuse the whole export on every hook.
 */
const LATEST_MS = Date.UTC(2200, 0, 1);

/** Milliseconds since the epoch; Codex writes 0 where it does not know. */
function msOf(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 && value <= LATEST_MS ? value : undefined;
}

/** An RFC 3339 time as Codex writes one, in milliseconds since the epoch. */
function timeOf(value: unknown): number | undefined {
  return typeof value === 'string' ? msOf(Date.parse(value)) : undefined;
}

/** A Rust `Duration` as serde writes it, `{"secs", "nanos"}`, in milliseconds. */
function durationOf(value: unknown): number | undefined {
  const duration = fieldsOf(value);
  if (duration === undefined) return undefined;
  const { secs, nanos } = duration;
  if (typeof secs !== 'number' || !(secs >= 0)) return undefined;
  const ms = secs * 1000 + (typeof nanos === 'number' && nanos > 0 && nanos < 1e9 ? nanos / 1e6 : 0);
  return ms <= LATEST_MS ? ms : undefined;
}

function usageOf(value: unknown): Usage | undefined {
  const usage = fieldsOf(value);
  if (usage === undefined) return undefined;
  return {
    input: count(usage['input_tokens']),
    cached: count(usage['cached_input_tokens']),
    cacheWrite: count(usage['cache_write_input_tokens']),
    output: count(usage['output_tokens']),
  };
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];

/**
 * A running total, `token_count`, written after each response's tools ran and again, unchanged, as rate limits refresh;
 * an estimate after a compaction or past the context window, read true only where its parts add up, new by its key.
 */
function countOf(value: unknown): Event {
  const info = fieldsOf(value);
  if (info === undefined) return { kind: 'count', key: 'none', usage: undefined };
  const total = fieldsOf(info['total_token_usage']);
  const last = fieldsOf(info['last_token_usage']);
  const numbers = (fields: Fields | undefined): number[] => USAGE_FIELDS.map((field) => count(fields?.[field]));
  const key = JSON.stringify([...numbers(total), ...numbers(last)]);
  const usage = usageOf(last);
  if (last === undefined || usage === undefined) return { kind: 'count', key, usage: undefined };
  const reads =
    count(last['total_tokens']) === usage.input + usage.output &&
    usage.input + usage.output > 0 &&
    usage.cached <= usage.input &&
    count(last['reasoning_output_tokens']) <= usage.output;
  return { kind: 'count', key, usage: reads ? usage : undefined };
}

/** A tool's name: a plain name, as every provider's tools have, cut to ingest's cap where it is sent; the model writes it, so anything else is text, kept as `unknown`. */
const TOOL_NAME = /^[\w.:@+-]+$/;

function plainTool(name: string | undefined): string | undefined {
  return name === undefined ? undefined : TOOL_NAME.test(name) ? name : 'unknown';
}

/** A namespaced tool by the name the model calls it: an MCP tool's `mcp__<server>__<tool>`. */
function toolNameOf(name: unknown, namespace: unknown): string | undefined {
  const tool = nameOf(name);
  const space = nameOf(namespace);
  if (tool === undefined || space === undefined) return plainTool(tool);
  return plainTool(space.endsWith('__') ? `${space}${tool}` : `${space}__${tool}`);
}

/** An MCP tool by its server's name and its own, which the model's name for it may have shortened. */
function mcpNameOf(server: unknown, tool: unknown): string | undefined {
  const serverName = nameOf(server);
  const toolName = nameOf(tool);
  return serverName === undefined || toolName === undefined ? undefined : plainTool(`mcp__${serverName}__${toolName}`);
}

function callOf(callId: string | undefined, name: string | undefined, inPlace: boolean, status: unknown): Event {
  // A call with no id or name to keep is still the model at work.
  if (callId === undefined || name === undefined) return { kind: 'output' };
  return { kind: 'call', callId, name, inPlace, outcome: inPlace && status === 'failed' ? 'failed' : undefined };
}

/** A `response_item`: what went to the model and what came back. */
function responseEvent(item: Fields): Event {
  switch (item['type']) {
    case 'message':
      return item['role'] === 'assistant' ? { kind: 'output' } : { kind: 'input' };
    case 'reasoning':
      return { kind: 'output' };
    case 'function_call':
    case 'custom_tool_call':
      return callOf(idOf(item['call_id']), toolNameOf(item['name'], item['namespace']), false, undefined);
    case 'local_shell_call':
      return callOf(idOf(item['call_id']) ?? idOf(item['id']), 'local_shell', false, undefined);
    case 'tool_search_call':
      return callOf(idOf(item['call_id']) ?? idOf(item['id']), 'tool_search', false, undefined);
    // The model's hosted tools run inside its response, which records them done.
    case 'web_search_call':
      return callOf(idOf(item['id']) ?? idOf(item['call_id']), 'web_search', true, item['status']);
    case 'image_generation_call':
      return callOf(idOf(item['id']), 'image_generation', true, item['status']);
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'tool_search_output': {
      const callId = idOf(item['call_id']);
      return callId === undefined ? { kind: 'input' } : { kind: 'result', callId };
    }
    default:
      // A compaction's summary is no call of its own: its tokens, where Codex counts them, are the call.
      return OTHER;
  }
}

function done(
  callId: unknown,
  outcome: Outcome | undefined,
  extra: { name?: string | undefined; startMs?: number | undefined; endMs?: number | undefined; durationMs?: number | undefined } = {},
): Event {
  const id = idOf(callId);
  if (id === undefined) return OTHER;
  return {
    kind: 'done',
    callId: id,
    name: extra.name,
    outcome,
    startMs: extra.startMs,
    endMs: extra.endMs,
    durationMs: extra.durationMs,
  };
}

/**
 * `item_completed`, which a paginated rollout writes for every item. Of a tool's item: its status, a command's exit
 * code, an MCP tool's server and name, and its times.
 */
function completionEvent(message: Fields): Event {
  const item = fieldsOf(message['item']);
  if (item === undefined) return OTHER;
  const status = item['status'];
  const times = { startMs: msOf(message['started_at_ms']), endMs: msOf(message['completed_at_ms']) };
  const duration = durationOf(item['duration']);
  switch (item['type']) {
    case 'CommandExecution': {
      // A command the person ran with `!` is theirs, not a call of the model's.
      if (item['source'] === 'user_shell') return OTHER;
      const exit = item['exit_code'];
      const failed = status === 'failed' || (typeof exit === 'number' && exit !== 0);
      return done(item['id'], status === 'declined' ? 'cancelled' : failed ? 'failed' : undefined, { ...times, durationMs: duration });
    }
    case 'McpToolCall':
      return done(item['id'], status === 'failed' ? 'failed' : undefined, {
        ...times,
        name: mcpNameOf(item['server'], item['tool']),
        durationMs: duration,
      });
    case 'FileChange':
      return done(item['id'], status === 'declined' ? 'cancelled' : status === 'failed' ? 'failed' : undefined, times);
    case 'DynamicToolCall':
      return done(item['id'], status === 'failed' || item['success'] === false ? 'failed' : undefined, {
        ...times,
        durationMs: duration,
      });
    case 'CollabAgentToolCall':
      return done(item['id'], status === 'interrupted' ? 'cancelled' : status === 'failed' ? 'failed' : undefined, times);
    case 'ImageGeneration':
      return done(item['id'], status === 'failed' ? 'failed' : undefined, times);
    case 'WebSearch':
    case 'ImageView':
    case 'FunctionCallOutput':
      return done(item['id'], undefined, times);
    case 'UserMessage':
    case 'HookPrompt':
      return { kind: 'input' };
    default:
      return OTHER;
  }
}

/** An `event_msg`. */
function messageEvent(message: Fields): Event {
  switch (message['type']) {
    case 'task_started':
    case 'turn_started': {
      const turnId = idOf(message['turn_id']);
      return turnId === undefined ? OTHER : { kind: 'start', turnId };
    }
    case 'task_complete':
    case 'turn_complete': {
      const turnId = idOf(message['turn_id']);
      return turnId === undefined ? OTHER : { kind: 'complete', turnId, errorType: errorTypeOf(message['error']) };
    }
    case 'turn_aborted':
      return {
        kind: 'aborted',
        turnId: idOf(message['turn_id']),
        reason: kindOf(message['reason']),
        errorType: errorTypeOf(message['error']),
      };
    case 'token_count':
      return countOf(message['info']);
    case 'user_message':
      return { kind: 'input' };
    case 'item_completed':
      return completionEvent(message);
    // A legacy rollout's tool completions, which a paginated one writes as items.
    case 'mcp_tool_call_end': {
      const invocation = fieldsOf(message['invocation']);
      const result = fieldsOf(message['result']);
      const ok = fieldsOf(result?.['Ok']);
      const failed = result !== undefined && ('Err' in result || ok?.['isError'] === true || ok?.['is_error'] === true);
      return done(message['call_id'], failed ? 'failed' : undefined, {
        name: mcpNameOf(invocation?.['server'], invocation?.['tool']),
        durationMs: durationOf(message['duration']),
      });
    }
    case 'patch_apply_end': {
      const status = message['status'];
      const failed = status === 'failed' || message['success'] === false;
      return done(message['call_id'], status === 'declined' ? 'cancelled' : failed ? 'failed' : undefined);
    }
    case 'web_search_end':
      return done(message['call_id'], undefined);
    case 'image_generation_end':
      return done(message['call_id'], message['status'] === 'failed' ? 'failed' : undefined);
    default:
      return OTHER;
  }
}

/** A plain version, as Codex writes its own: never anything longer or stranger. */
const VERSION = /^[\w.+-]{1,64}$/;

function metaOf(meta: Fields): Event {
  const threadId = idOf(meta['id']);
  if (threadId === undefined) return OTHER;
  const ownFrom = meta['subagent_history_start_ordinal'];
  const present = (value: unknown): boolean => value !== null && value !== undefined;
  const version = meta['cli_version'];
  return {
    kind: 'meta',
    meta: {
      ...(typeof version === 'string' && VERSION.test(version) ? { version } : {}),
      threadId,
      sessionId: idOf(meta['session_id']) ?? threadId,
      created: timeOf(meta['timestamp']),
      derived:
        present(meta['forked_from_id']) ||
        present(meta['parent_thread_id']) ||
        present(fieldsOf(meta['source'])?.['subagent']),
      ownFrom: Number.isSafeInteger(ownFrom) && (ownFrom as number) >= 0 ? (ownFrom as number) : undefined,
      provider: providerOf(meta['model_provider']),
    },
  };
}

function recordEvent(record: Fields): Event {
  const payload = fieldsOf(record['payload']);
  if (payload === undefined) return OTHER;
  switch (record['type']) {
    case 'event_msg':
      return messageEvent(payload);
    case 'response_item':
      return responseEvent(payload);
    case 'turn_context':
      return { kind: 'context', turnId: idOf(payload['turn_id']), model: nameOf(payload['model']) };
    case 'token_usage_record': {
      const usage = usageOf(payload['usage']);
      return usage === undefined
        ? OTHER
        : { kind: 'usage', turnId: idOf(payload['turn_id']), responseId: idOf(payload['response_id']), usage };
    }
    case 'session_meta':
      return metaOf(payload);
    default:
      return OTHER;
  }
}

/** A line as the plugin keeps it; one torn by a crash, or not Codex's, says nothing. */
function lineOf(bytes: Buffer, start: number, end: number): Line {
  let record: Fields | undefined;
  try {
    record = fieldsOf(JSON.parse(bytes.toString('utf8')));
  } catch {
    record = undefined;
  }
  if (record === undefined) return { start, end, time: undefined, ordinal: undefined, event: OTHER };
  const ordinal = record['ordinal'];
  return {
    start,
    end,
    time: timeOf(record['timestamp']),
    ordinal: Number.isSafeInteger(ordinal) && (ordinal as number) >= 0 ? (ordinal as number) : undefined,
    event: recordEvent(record),
  };
}

/** How much of a rollout is read at once. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * A line longer than this is passed over unparsed: only a tool's output or a
 * compaction's summary runs so long, and the plugin reads neither.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/**
 * A rollout read forward from an offset, a stretch at a time: what lies
 * before the offset is never read, however long the rollout has grown.
 */
export class Reader {
  readonly #fd: number;
  readonly #chunk: number;
  readonly #maxLine: number;
  /** Read into afresh each time: nothing of a stretch outlives its read but the copy of a line it ends inside. */
  readonly #buffer: Buffer;
  #position: number;
  /** Where the line being read begins, and what of it the last stretch held. */
  #lineStart: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #skipping = false;

  constructor(path: string, offset: number, chunk = CHUNK_BYTES, maxLine = MAX_LINE_BYTES) {
    this.#fd = openSync(path, 'r');
    this.#chunk = chunk;
    this.#maxLine = maxLine;
    this.#buffer = Buffer.allocUnsafe(chunk);
    this.#position = offset;
    this.#lineStart = offset;
  }

  /**
   * The whole lines in the next stretch, or `undefined` once the rollout holds nothing new. A last line with no newline
   * yet is still being written: it waits for a later read.
   */
  read(): Line[] | undefined {
    const n = readSync(this.#fd, this.#buffer, 0, this.#chunk, this.#position);
    if (n === 0) return undefined;
    const base = this.#position;
    this.#position += n;
    const data = this.#buffer.subarray(0, n);
    const lines: Line[] = [];
    let from = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, from);
      if (newline === -1) {
        if (!this.#skipping && from < n) {
          if (this.#pendingBytes + (n - from) > this.#maxLine) {
            this.#skipping = true;
            this.#pending = [];
            this.#pendingBytes = 0;
          } else {
            this.#pending.push(Buffer.from(data.subarray(from)));
            this.#pendingBytes += n - from;
          }
        }
        break;
      }
      const end = base + newline + 1;
      const length = this.#pendingBytes + (newline - from);
      if (this.#skipping || length > this.#maxLine) {
        lines.push({ start: this.#lineStart, end, time: undefined, ordinal: undefined, event: OTHER });
      } else {
        const bytes =
          this.#pendingBytes === 0 ? data.subarray(from, newline) : Buffer.concat([...this.#pending, data.subarray(from, newline)]);
        lines.push(lineOf(bytes, this.#lineStart, end));
      }
      this.#skipping = false;
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#lineStart = end;
      from = newline + 1;
    }
    return lines;
  }

  close(): void {
    closeSync(this.#fd);
  }
}

/** Where a turn's opening line begins, and the turn: a place in a rollout a hook can find again. */
export interface Opening {
  at: number;
  turnId: string;
}

/**
 * Whether the rollout still reads as it did where a hook left it: a line ends at `offset`, and the turn last seen
 * opening before it opens where it did: one rewritten in place fails either, and is read again from its start.
 */
export function readsAsBefore(path: string, offset: number, opening: Opening | undefined): boolean {
  try {
    if (offset > 0) {
      const fd = openSync(path, 'r');
      try {
        const last = Buffer.alloc(1);
        if (readSync(fd, last, 0, 1, offset - 1) !== 1 || last[0] !== 0x0a) return false;
      } finally {
        closeSync(fd);
      }
    }
    if (opening === undefined) return true;
    if (opening.at > offset) return false;
    const reader = new Reader(path, opening.at, 64 * 1024);
    try {
      for (;;) {
        const lines = reader.read();
        if (lines === undefined) return false;
        const first = lines[0];
        if (first !== undefined) return first.event.kind === 'start' && first.event.turnId === opening.turnId;
      }
    } finally {
      reader.close();
    }
  } catch {
    return false;
  }
}

/** A line as long as a rollout's first may run: the session's instructions and tools are in it. */
const META_MAX_BYTES = 16 * 1024 * 1024;

/** The thread, from the rollout's first line; nothing where that is not yet whole or not Codex's. */
export function readMeta(path: string): Meta | undefined {
  const reader = new Reader(path, 0, 256 * 1024, META_MAX_BYTES);
  try {
    for (;;) {
      const lines = reader.read();
      if (lines === undefined) return undefined;
      const first = lines[0];
      if (first !== undefined) return first.event.kind === 'meta' ? first.event.meta : undefined;
    }
  } finally {
    reader.close();
  }
}
