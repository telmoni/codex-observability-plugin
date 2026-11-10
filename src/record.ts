/**
 * A turn as a trace: its model calls with their tokens, its tool calls and its compactions, each with the times Codex
 * wrote, and with content on, the conversation as the GenAI conventions' messages.
 */

import { createHash } from 'node:crypto';

import type {
  CallRecord,
  ModelCallRecord,
  RecordOutcome,
  StepRecord,
  ToolCallRecord,
  TraceRecord,
} from 'telmoni';

import { effortOf, modelOf, providerOf } from './names.js';
import type { Tokens } from './transcript.js';
import type { Turn } from './turns.js';

export const AGENT = 'codex';

export interface RecordOptions {
  sessionId: string;
  /** The model, provider and effort the session last named before the turn, for a turn whose context names none. */
  model: string | undefined;
  provider: string | undefined;
  effort: string | undefined;
  /** Whether the session ended with the turn still open. */
  sessionEnded: boolean;
  content: boolean;
}

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** A version 5 UUID (RFC 9562) of `name` under `namespace`, as its 32 hex digits. */
function uuid5(name: string, namespace: string): string {
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name)
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  return digest.subarray(0, 16).toString('hex');
}

const NAMESPACE = uuid5('https://telmoni.com/codex-observability-plugin', NAMESPACE_URL);

/** The trace's id, the same however often its turn is built, so a turn sent twice is stored once. */
export function traceIdOf(sessionId: string, turnId: string): string {
  return uuid5(`${sessionId}:${turnId}`, NAMESPACE);
}

type Message = { role: string; parts: Array<Record<string, unknown>> };

function text(role: string, content: string | undefined): Message[] | undefined {
  return content === undefined ? undefined : [{ role, parts: [{ type: 'text', content }] }];
}

/** The trace for `turn`, or undefined for a turn with no call in it or no time to place it at. */
export function recordTurn(turn: Turn, options: RecordOptions): TraceRecord | undefined {
  const known = turn.rows.map((row) => row.at).filter((at): at is number => at !== undefined);
  const start = turn.open.at ?? known[0];
  if (start === undefined) return undefined;
  const context = turn.rows.find((row) => row.kind === 'turn_context');
  const model = modelOf(context?.model ?? options.model);
  const provider = providerOf(options.provider);
  const effort = effortOf(context?.effort ?? options.effort);
  const modelCall = (from: number, to: number, tokens?: Tokens): ModelCallRecord => {
    const call: ModelCallRecord = {
      type: 'model_call',
      model,
      provider,
      start: from,
      end: Math.max(from, to),
    };
    if (effort !== undefined) call.reasoningEffort = effort;
    if (tokens !== undefined) {
      // As the conventions count it, which is as Codex does: the input with the cache's reads, the output with the reasoning.
      call.usage = {};
      if (tokens.input !== undefined) call.usage.inputTokens = tokens.input;
      if (tokens.output !== undefined) call.usage.outputTokens = tokens.output;
      if (tokens.cacheRead !== undefined) call.usage.cacheReadInputTokens = tokens.cacheRead;
      if (tokens.cacheWrite !== undefined) call.usage.cacheWriteInputTokens = tokens.cacheWrite;
      if (tokens.reasoning !== undefined) call.usage.reasoningOutputTokens = tokens.reasoning;
    }
    return call;
  };

  const inside: Array<StepRecord | CallRecord> = [];
  let prompt: string | undefined;
  let lastReply: string | undefined;
  let summary: string | undefined;
  // A model call runs from what it was handed, the prompt or the tools' output, to its tokens' record.
  let since = start;
  let handed: Message[] = [];
  let said: Array<Record<string, unknown>> = [];
  const hand = (role: string, part: Record<string, unknown>): void => {
    const last = handed.at(-1);
    if (last?.role === role) last.parts.push(part);
    else handed.push({ role, parts: [part] });
  };
  for (const row of turn.rows) {
    const at = row.at ?? since;
    switch (row.kind) {
      case 'prompt':
        since = at;
        if (row.text !== undefined) {
          prompt ??= row.text;
          hand('user', { type: 'text', content: row.text });
        }
        break;
      case 'tool_output':
        since = at;
        if (row.text !== undefined)
          hand('tool', { type: 'tool_call_response', response: row.text });
        break;
      case 'said':
        said.push(row.part);
        if (row.part.type === 'text' && typeof row.part.content === 'string')
          lastReply = row.part.content;
        break;
      case 'usage': {
        const call = modelCall(since, at, row.tokens);
        if (options.content) {
          if (handed.length > 0) call.inputMessages = handed;
          if (said.length > 0) call.outputMessages = [{ role: 'assistant', parts: said }];
        }
        inside.push(call);
        since = at;
        handed = [];
        said = [];
        break;
      }
      case 'tool': {
        const { tool } = row;
        const record: ToolCallRecord = {
          type: 'tool_call',
          name: tool.name,
          start: tool.start,
          end: tool.end,
        };
        if (tool.declined) record.cancelled = true;
        else if (tool.failed) record.errorType = 'ToolError';
        if (options.content) {
          if (tool.arguments !== undefined) record.arguments = tool.arguments;
          if (tool.result !== undefined) record.result = tool.result;
        }
        inside.push(record);
        break;
      }
      case 'summary':
        summary = row.text;
        break;
      case 'compaction': {
        // Its own model call, the summary's, ends inside the times Codex gave the compaction, and began with it.
        const within = (call: StepRecord | CallRecord): boolean =>
          call.type === 'model_call' &&
          Number(call.end) >= row.start &&
          Number(call.end) <= row.end;
        const step: StepRecord = {
          type: 'step',
          name: 'compaction',
          start: row.start,
          end: row.end,
        };
        const calls = inside.filter(within);
        for (const call of calls) call.start = Math.max(Number(call.start), row.start);
        if (calls.length > 0) step.calls = calls;
        if (options.content && summary !== undefined)
          step.outputMessages = text('assistant', summary);
        inside.splice(0, inside.length, ...inside.filter((call) => !within(call)), step);
        summary = undefined;
        since = Math.max(since, row.end);
        break;
      }
      case 'turn_complete':
        if (row.lastReply !== undefined) lastReply = row.lastReply;
        // Codex writes no record of a request that failed: the error that ended the turn is its last call.
        if (row.errorType !== undefined)
          inside.push({ ...modelCall(since, at), errorType: row.errorType });
        break;
      default:
        break;
    }
  }
  if (inside.length === 0) return undefined;
  // A reduce, not a spread: a long turn's times would pass the arguments a call can take.
  const end = [
    ...known,
    ...inside.flatMap((call) => [Number(call.start), Number(call.end)]),
  ].reduce((latest, at) => Math.max(latest, at), start);

  const record: TraceRecord = {
    traceId: traceIdOf(options.sessionId, turn.id),
    agent: AGENT,
    sessionId: options.sessionId,
    start,
    end,
    // Ordered by start, the trace's own times holding every call.
    inside: inside.sort((a, b) => Number(a.start) - Number(b.start)),
    ...outcome(turn, options.sessionEnded),
  };
  if (options.content) {
    const input = text('user', prompt);
    if (input !== undefined) record.inputMessages = input;
    const output = text('assistant', lastReply);
    if (output !== undefined) record.outputMessages = output;
  }
  return record;
}

/**
 * The trace's outcome: failed by the kind of the error that ended it, or by the budget it ran out of; cancelled where it
 * was stopped, replaced, or never closed before the session ended or another turn began.
 */
function outcome(turn: Turn, sessionEnded: boolean): RecordOutcome {
  const close = turn.close;
  if (close?.errorType !== undefined) return { errorType: close.errorType };
  if (close?.kind === 'turn_aborted')
    return close.reason === 'budget_limited'
      ? { errorType: 'budget_limited' }
      : { cancelled: true };
  if (close === undefined && (turn.followed || sessionEnded)) return { cancelled: true };
  return {};
}
