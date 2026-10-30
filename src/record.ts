/**
 * A turn as a run record: the turn a run of `codex`, each response a model call with its model and the tokens Codex
 * counted for it, and each tool call by its name, from the model's asking to its completion, failed or cancelled as Codex says.
 */

import { createHash } from 'node:crypto';

import type { ModelCallRecord, RunRecord, ToolCallRecord } from 'telmoni';

import type { Usage } from './rollout.js';
import type { Turn } from './turns.js';

export const AGENT = 'codex';

/** The plugin's own namespace for run ids, so no other tool's ids can meet them. */
const NAMESPACE = '188e660b-8a52-464f-ad0e-81f2a9339eee';

/** A version 5 UUID (RFC 9562): the same turn always gets the same run id. */
export function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The run id of a turn of a session. */
export function runIdOf(sessionId: string, turnId: string): string {
  return uuid5(NAMESPACE, `${sessionId}/${turnId}`);
}

/**
 * Why a turn with no closing of its own is sent: a hook named it as it
 * stopped, or as it was interrupted, or the session ended with it open.
 */
export type Ending = 'stopped' | 'interrupted' | 'session-ended';

export interface Context {
  sessionId: string;
  /** Whoever serves the model, as Codex names its provider. */
  provider: string | undefined;
  /** The model the hook names, for a turn whose rollout names none. */
  model: string | undefined;
  /** The Codex that wrote the turn, sent as the run's release. */
  release?: string;
}

interface RunOutcome {
  errorType?: string;
  cancelled?: boolean;
}

function outcomeOf(turn: Turn, ending: Ending | undefined): RunOutcome {
  const { closing } = turn;
  if (closing !== undefined) {
    if (closing.errorType !== undefined) return { errorType: closing.errorType };
    if (!closing.aborted) return {};
    // A budget stops a turn as an error would; an interruption, a turn replaced or a review ended is cancelled.
    return closing.reason === 'budget_limited' ? { errorType: 'budget_limited' } : { cancelled: true };
  }
  // With no closing of its own, a turn a Stop hook named had done its work; any other was cut short, interrupted or replaced.
  return ending === 'stopped' ? {} : { cancelled: true };
}

/**
 * Codex's count as the SDK takes one, which is OpenAI's own: input with the
 * cache's reads and writes inside it, and output with the reasoning inside it.
 */
function usageOf(usage: Usage): NonNullable<ModelCallRecord['usage']> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadInputTokens: usage.cached,
    cacheWriteInputTokens: usage.cacheWrite,
  };
}

/** Ingest's caps, as the SDK's: a tool's name to 145 characters, a model's to 128, each cut rather than sent past it. */
const NAME_MAX = 145;
const MODEL_MAX = 128;

/** `name` cut to `max` characters, as ingest counts them: never inside one. */
function cut(name: string, max: number): string {
  const characters = [...name];
  return characters.length <= max ? name : characters.slice(0, max).join('');
}

/** A file's path, which a local model's name, set in a person's configuration, may be: never sent. */
const PATH = /^(?:[/\\]|~(?:[/\\]|$)|\.{1,2}[/\\]|[A-Za-z]:[/\\]|file:)/i;

/** A path ending in a local model's weights, from anywhere: the file's name is the model's, and is sent without its folders. */
const MODEL_FILE = /[/\\]([^/\\]+\.(?:gguf|ggml|bin|safetensors|llamafile))$/i;

/** A model's name as Codex gives it, cut to ingest's cap: a model file's own name for its path, `unknown` for any other path. */
function modelOf(name: string): string {
  const trimmed = name.trim();
  const file = MODEL_FILE.exec(trimmed)?.[1];
  if (file !== undefined) return cut(file, MODEL_MAX);
  return PATH.test(trimmed) ? 'unknown' : cut(trimmed, MODEL_MAX);
}


/** Whether the turn holds any of the model's work, which is what makes it a run. */
export function hasWork(turn: Turn): boolean {
  return turn.responses.length > 0;
}

/** The turn as a run, or nothing where it holds no time to place it at. */
export function recordOf(turn: Turn, context: Context, ending?: Ending): RunRecord | undefined {
  const start = turn.start;
  if (start === undefined) return undefined;
  const outcome = outcomeOf(turn, ending);
  const until = Math.max(start, turn.closing?.at ?? turn.last ?? start);
  const items: Array<ModelCallRecord | ToolCallRecord> = [];
  turn.responses.forEach((response, index) => {
    const call: ModelCallRecord = {
      type: 'model_call',
      model: modelOf(response.model ?? turn.model ?? context.model ?? 'unknown'),
      start: response.start,
      end: Math.max(response.start, response.end),
    };
    if (context.provider !== undefined) call.provider = context.provider;
    // One count per response, never two: Codex's record of it where it wrote one, its share of the running total where it wrote none.
    const usage = response.recorded ?? response.counted;
    if (usage !== undefined) {
      call.usage = usageOf(usage);
    } else if (index === turn.responses.length - 1) {
      // The response the turn ended on, never completed: cut off with it.
      if (outcome.errorType !== undefined) call.errorType = outcome.errorType;
      if (outcome.cancelled) call.cancelled = true;
    }
    items.push(call);
  });
  for (const tool of turn.calls.values()) {
    const from = tool.ranFrom ?? tool.start;
    const to = tool.ranTo ?? (tool.ranMs !== undefined ? from + tool.ranMs : tool.answeredAt);
    const call: ToolCallRecord = { type: 'tool_call', name: cut(tool.name, NAME_MAX), start: from, end: Math.max(from, to ?? until) };
    // Declined, or never answered because the turn was interrupted, or ended, first.
    if (to === undefined || tool.outcome === 'cancelled') call.cancelled = true;
    else if (tool.outcome === 'failed') call.errorType = 'ToolError';
    items.push(call);
  }
  // In the order they started, so the record and the ids derived from each span's place come out the same however the lines were written.
  const order = new Map(items.map((item, index) => [item, index]));
  items.sort((a, b) => Number(a.start) - Number(b.start) || order.get(a)! - order.get(b)!);
  const inside = items;
  const record: RunRecord = {
    runId: runIdOf(context.sessionId, turn.id),
    agent: AGENT,
    sessionId: context.sessionId,
    // A clock set back mid-turn writes a call before the turn's opening: the run still holds every call, first start to last end.
    start: inside.reduce((earliest, item) => Math.min(earliest, Number(item.start)), start),
    end: inside.reduce((latest, item) => Math.max(latest, Number(item.end)), until),
    inside,
  };
  if (outcome.errorType !== undefined) record.errorType = outcome.errorType;
  if (outcome.cancelled) record.cancelled = true;
  return record;
}
