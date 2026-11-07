/**
 * Codex's rollout of a session (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`): a JSON object a line, each
 * `{timestamp, type, payload}`. Every field the plugin reads is read here, and the conversation itself only where asked.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import { mcpToolName, toolName } from './names.js';

/** A model response's tokens as Codex counts them: the input holds the cache's reads, the output the reasoning. */
export interface Tokens {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

/** A tool call, of the `item_completed` Codex writes for one. */
export interface ToolUse {
  name: string;
  /** When it began and ended, in ms, as Codex timed it. */
  start: number;
  end: number;
  failed: boolean;
  /** Refused by the person. */
  declined: boolean;
  /** Content, read only where asked. */
  arguments?: unknown;
  result?: unknown;
}

interface Line {
  /** Where the line begins in the file, in bytes. */
  offset: number;
  /** Its `timestamp`, in ms; undefined where it has none to read. */
  at: number | undefined;
  /** The turn it names, where it names one. */
  turnId?: string;
}

export type Row = Line &
  (
    | { kind: 'turn_started' }
    | { kind: 'turn_context'; model?: string; effort?: string }
    /** The turn's close, the kind of the error that ended it where one did. */
    | { kind: 'turn_complete'; errorType?: string; lastReply?: string }
    | { kind: 'turn_aborted'; reason?: string; errorType?: string }
    | { kind: 'settings'; model?: string; provider?: string; effort?: string }
    | { kind: 'usage'; tokens: Tokens }
    | { kind: 'tool'; tool: ToolUse }
    /** A compaction, from its start to its end, as Codex timed it. */
    | { kind: 'compaction'; start: number; end: number }
    /** The summary a compaction left: content alone. */
    | { kind: 'summary'; text?: string }
    /** What the person typed: the content, where asked, as text. */
    | { kind: 'prompt'; text?: string }
    /** A reply's words, its reasoning or a tool it called, as the model wrote them: content alone. */
    | { kind: 'said'; part: Record<string, unknown> }
    /** A tool's output handed back to the model; its words only where asked. */
    | { kind: 'tool_output'; text?: string }
  );

/** The session as the rollout's first line names it. */
export interface Session {
  /** Codex's version, sent as the run's release. */
  cliVersion?: string;
  /** The provider of the session's models, as Codex ids it (`openai`, `azure`). */
  provider?: string;
}

/** A rollout past this is read as none: the worker reads it from the turn it is at, every hook. */
export const MAX_READ_BYTES = 256 * 1024 * 1024;
/** The first line, the session's, is read up to this; a longer one is read as no session. */
const MAX_FIRST_LINE_BYTES = 4 * 1024 * 1024;
/** Codex's own kind for an error: a word of snake case. */
const KIND = /^[a-z][a-z0-9_]{0,63}$/;

export type RolloutRead =
  | {
      rows: Row[];
      session: Session;
      /** Where the last line read whole ends, in bytes: what follows it, Codex is still writing. */
      end: number;
    }
  | { problem: string };

/**
 * The rollout's rows from byte `from` on, with the session its first line names. A line that is not a JSON object with
 * a type, as a line half written is, is passed over.
 */
export function readRollout(
  path: string,
  options: { content: boolean; from: number },
): RolloutRead {
  let fd: number;
  try {
    // Never waiting on a pipe put in its place.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === 'ENOENT' ? 'no rollout yet' : 'rollout unreadable' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'rollout not a file' };
    const size = stat.size;
    const from = Math.min(Math.max(0, options.from), size);
    if (size - from > MAX_READ_BYTES) return { problem: 'rollout past 256 MiB unread' };
    const session = readSession(firstLine(fd, size));
    const bytes = Buffer.alloc(size - from);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    const rows: Row[] = [];
    let end = from;
    for (let start = 0; start < read;) {
      const newline = bytes.indexOf(0x0a, start);
      // A line not yet ended is one Codex is still writing.
      if (newline === -1 || newline >= read) break;
      const line = bytes.toString('utf8', start, newline);
      const offset = from + start;
      start = newline + 1;
      end = from + start;
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const row = readRow(value, offset, options.content);
      if (row !== undefined) rows.push(row);
    }
    return { rows, session, end };
  } catch {
    return { problem: 'rollout unreadable' };
  } finally {
    closeSync(fd);
  }
}

function firstLine(fd: number, size: number): unknown {
  const bytes = Buffer.alloc(Math.min(size, MAX_FIRST_LINE_BYTES));
  const read = readSync(fd, bytes, 0, bytes.length, 0);
  const newline = bytes.subarray(0, read).indexOf(0x0a);
  if (newline === -1) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8', 0, newline));
  } catch {
    return undefined;
  }
}

function readSession(value: unknown): Session {
  const session: Session = {};
  const line = object(value);
  if (line?.type !== 'session_meta') return session;
  const meta = object(line.payload) ?? {};
  const version = plain(meta.cli_version);
  if (version !== undefined) session.cliVersion = version;
  const provider = plain(meta.model_provider);
  if (provider !== undefined) session.provider = provider;
  return session;
}

function readRow(value: unknown, offset: number, content: boolean): Row | undefined {
  const line = object(value);
  if (line === undefined || typeof line.type !== 'string') return undefined;
  const payload = object(line.payload);
  if (payload === undefined) return undefined;
  const at = timeOf(line.timestamp);
  const base: Line = { offset, at };
  const turnId =
    plain(payload.turn_id) ??
    plain(object(payload.internal_chat_message_metadata_passthrough)?.turn_id);
  if (turnId !== undefined) base.turnId = turnId;

  switch (line.type) {
    case 'turn_context': {
      const row: Row = { ...base, kind: 'turn_context' };
      const model = text(payload.model);
      if (model !== undefined) row.model = model;
      const effort = plain(payload.effort);
      if (effort !== undefined) row.effort = effort;
      return row;
    }
    case 'token_usage_record': {
      const tokens = tokensOf(payload.usage);
      return tokens === undefined ? undefined : { ...base, kind: 'usage', tokens };
    }
    case 'compacted':
      return { ...base, kind: 'summary', ...(content ? said('text', text(payload.message)) : {}) };
    case 'event_msg':
      return readEvent(payload, base, content);
    case 'response_item':
      return readItem(payload, base, content);
    default:
      return undefined;
  }
}

function readEvent(
  payload: Record<string, unknown>,
  base: Line,
  content: boolean,
): Row | undefined {
  switch (payload.type) {
    case 'task_started':
      return { ...base, kind: 'turn_started' };
    case 'task_complete': {
      const row: Row = {
        ...base,
        kind: 'turn_complete',
        ...(content ? said('lastReply', text(payload.last_agent_message)) : {}),
      };
      const errorType = errorTypeOf(payload.error);
      if (errorType !== undefined) row.errorType = errorType;
      return row;
    }
    case 'turn_aborted': {
      const row: Row = { ...base, kind: 'turn_aborted' };
      const reason = plain(payload.reason);
      if (reason !== undefined) row.reason = reason;
      const errorType = errorTypeOf(payload.error);
      if (errorType !== undefined) row.errorType = errorType;
      return row;
    }
    case 'thread_settings_applied': {
      const settings = object(payload.thread_settings) ?? {};
      const row: Row = { ...base, kind: 'settings' };
      const model = text(settings.model);
      if (model !== undefined) row.model = model;
      const provider = plain(settings.model_provider_id);
      if (provider !== undefined) row.provider = provider;
      const effort = plain(settings.reasoning_effort);
      if (effort !== undefined) row.effort = effort;
      return row;
    }
    case 'item_completed':
      return readTurnItem(payload, base, content);
    default:
      return undefined;
  }
}

/** A turn item Codex finished: a tool call by its kind, a compaction, or the prompt. */
function readTurnItem(
  payload: Record<string, unknown>,
  base: Line,
  content: boolean,
): Row | undefined {
  const item = object(payload.item);
  if (item === undefined) return undefined;
  const start = count(payload.started_at_ms) ?? base.at;
  const end = count(payload.completed_at_ms) ?? base.at;
  if (start === undefined || end === undefined) return undefined;
  const status = plain(item.status);
  const tool = (name: string, failed: boolean, args?: unknown, result?: unknown): Row => {
    const use: ToolUse = {
      name,
      start,
      end: Math.max(start, end),
      failed: failed || status === 'failed',
      declined: status === 'declined',
    };
    if (content && args !== undefined) use.arguments = args;
    if (content && result !== undefined) use.result = result;
    return { ...base, kind: 'tool', tool: use };
  };
  switch (item.type) {
    case 'UserMessage':
      return { ...base, kind: 'prompt', ...(content ? said('text', typed(item.content)) : {}) };
    case 'ContextCompaction':
      return { ...base, kind: 'compaction', start, end: Math.max(start, end) };
    case 'CommandExecution': {
      // A command the person ran themselves (`!cmd`) is no call of the agent's.
      if (item.source === 'user_shell') return undefined;
      const exit = integer(item.exit_code);
      return tool(
        'shell',
        exit !== undefined && exit !== 0,
        { command: item.command },
        item.aggregated_output,
      );
    }
    case 'FileChange':
      return tool(
        'apply_patch',
        false,
        { changes: item.changes },
        joined(item.stdout, item.stderr),
      );
    case 'McpToolCall':
      return tool(
        mcpToolName(plain(item.server), plain(item.tool)),
        object(item.error) !== undefined,
        item.arguments,
        item.result ?? object(item.error)?.message,
      );
    case 'DynamicToolCall':
      return tool(
        toolName(plain(item.tool)),
        item.success === false,
        item.arguments,
        item.content_items ?? item.error,
      );
    case 'CollabAgentToolCall':
      return tool(toolName(plain(item.tool)), false, { prompt: item.prompt }, item.agents_states);
    case 'WebSearch':
      return tool('web_search', false, { query: item.query }, item.results);
    case 'ImageView':
      return tool('view_image', false);
    case 'ImageGeneration':
      return tool('image_generation', false, undefined, item.revised_prompt);
    case 'Extension': {
      // Codex's own tools as extensions, by kind: its standalone web search shares the hosted one's name.
      const kind = plain(item.kind);
      if (kind === undefined) return undefined;
      const failed = item.failure !== undefined && item.failure !== null;
      return kind === 'web.search'
        ? tool('web_search', failed, { query: item.query }, item.results)
        : tool(toolName(kind), failed);
    }
    default:
      return undefined;
  }
}

function readItem(payload: Record<string, unknown>, base: Line, content: boolean): Row | undefined {
  switch (payload.type) {
    case 'custom_tool_call_output':
    case 'function_call_output':
      return {
        ...base,
        kind: 'tool_output',
        ...(content ? said('text', outputText(payload.output)) : {}),
      };
    default:
      break;
  }
  if (!content) return undefined;
  switch (payload.type) {
    case 'message': {
      if (payload.role !== 'assistant') return undefined;
      const words = typed(payload.content);
      return words === undefined
        ? undefined
        : { ...base, kind: 'said', part: { type: 'text', content: words } };
    }
    case 'reasoning': {
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .map((part) => text(object(part)?.text))
            .filter((part): part is string => part !== undefined)
            .join('\n\n')
        : '';
      return summary === ''
        ? undefined
        : { ...base, kind: 'said', part: { type: 'reasoning', content: summary } };
    }
    case 'custom_tool_call':
    case 'function_call': {
      const part: Record<string, unknown> = {
        type: 'tool_call',
        name: toolName(plain(payload.name)),
      };
      const id = plain(payload.call_id);
      if (id !== undefined) part.id = id;
      const args = payload.input ?? payload.arguments;
      if (args !== undefined) part.arguments = args;
      return { ...base, kind: 'said', part };
    }
    default:
      return undefined;
  }
}

/**
 * An error's kind, never its message: Codex's `codex_error_info`, a word (`usage_limit_exceeded`) or an object named by
 * one (`{"http_connection_failed": {…}}`), else `ApiError` where it names none.
 */
function errorTypeOf(given: unknown): string | undefined {
  const error = object(given);
  if (error === undefined) return undefined;
  const info = error.codex_error_info;
  if (typeof info === 'string' && KIND.test(info)) return info;
  const key = Object.keys(object(info) ?? {})[0];
  return key !== undefined && KIND.test(key) ? key : 'ApiError';
}

function said<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, string>>);
}

/** A message's text parts, joined; images, files and other parts left out. */
function typed(given: unknown): string | undefined {
  if (typeof given === 'string') return given.trim() === '' ? undefined : given;
  if (!Array.isArray(given)) return undefined;
  const parts = given
    .map((part) => object(part))
    .filter((part) => part !== undefined && /text$/i.test(String(part.type)))
    .map((part) => text(part?.text))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** A tool's output as the model is handed it: text, or the text parts of a list of them. */
function outputText(given: unknown): string | undefined {
  if (typeof given === 'string') return given === '' ? undefined : given;
  const asObject = object(given);
  if (asObject !== undefined && typeof asObject.content === 'string') return asObject.content;
  return typed(given);
}

function joined(...given: unknown[]): string | undefined {
  const parts = given.filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function tokensOf(given: unknown): Tokens | undefined {
  const usage = object(given);
  if (usage === undefined) return undefined;
  const tokens: Tokens = {};
  const input = count(usage.input_tokens);
  if (input !== undefined) tokens.input = input;
  const cacheRead = count(usage.cached_input_tokens);
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  const cacheWrite = count(usage.cache_write_input_tokens);
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  const output = count(usage.output_tokens);
  if (output !== undefined) tokens.output = output;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function object(given: unknown): Record<string, unknown> | undefined {
  return given !== null && typeof given === 'object' && !Array.isArray(given)
    ? (given as Record<string, unknown>)
    : undefined;
}

/** A plain id or word, such as a turn's id, a version or a provider's id. */
function plain(given: unknown): string | undefined {
  return typeof given === 'string' && /^[A-Za-z0-9_.:@+-]{1,128}$/.test(given) ? given : undefined;
}

function text(given: unknown): string | undefined {
  return typeof given === 'string' && given.trim() !== '' ? given : undefined;
}

/** A `timestamp`, in ms; one naming no zone is read as UTC, as Codex writes it. */
function timeOf(given: unknown): number | undefined {
  if (typeof given !== 'string' || given === '') return undefined;
  const zoned = /(?:Z|[+-]\d\d:?\d\d)$/i.test(given) ? given : `${given}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : undefined;
}

function count(given: unknown): number | undefined {
  return typeof given === 'number' && Number.isSafeInteger(given) && given >= 0 ? given : undefined;
}

function integer(given: unknown): number | undefined {
  return typeof given === 'number' && Number.isSafeInteger(given) ? given : undefined;
}
