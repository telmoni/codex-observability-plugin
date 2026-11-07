/**
 * What the hook keeps of Codex's `Stop` and `SessionEnd`: the session, its rollout, the turn that stopped and the folder
 * it ran in. Never the last reply (`last_assistant_message`), nor anything else the session said.
 */

import { isAbsolute } from 'node:path';

import { isFileId } from './shared/state.js';

/** The hooks the plugin runs at: a turn's end, and the session's, after which nothing more is written to it. */
export type Event = 'Stop' | 'SessionEnd';

export interface Stop {
  sessionId: string;
  /** Codex's rollout of the session, read by the worker alone. */
  transcriptPath: string;
  event: Event;
  /** The turn a `Stop` ended, as Codex ids it. */
  turnId?: string;
  /** The session's working folder, read only to find `.telmoni-tags.json`: never kept, sent or logged. */
  cwd?: string;
  /** The model Codex names for the session, for a turn whose rollout names none. */
  model?: string;
  /** When the hook ran, in milliseconds since the epoch. */
  at: number;
  /** The rollout's size as the hook ran, which the worker waits to see written. */
  size?: number;
}

/** Longer than any model's name: a field this long is not one. */
const MODEL_MAX = 256;

/** The stop as the hook hands it to the worker, on its stdin: never its arguments, which others on the machine can read. */
export function handOff(stop: Stop): string {
  return JSON.stringify(stop);
}

/** The stop the hook handed over, held to the same rules, or undefined for anything else on stdin. */
export function takeOver(text: string): Stop | undefined {
  let given: unknown;
  try {
    given = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return undefined;
  const { sessionId, transcriptPath, event, turnId, cwd, model, at, size } = given as Record<
    string,
    unknown
  >;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const stop = readStop(
    {
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: event,
      turn_id: turnId,
      cwd,
      model,
    },
    at,
  );
  if (stop !== undefined && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0)
    stop.size = size;
  return stop;
}

/** The stop as the worker needs it, or undefined where the payload names no session or rollout to read. */
export function readStop(payload: unknown, at: number): Stop | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const given = payload as Record<string, unknown>;
  const { session_id: sessionId, transcript_path: transcriptPath, hook_event_name: event } = given;
  if (event !== 'Stop' && event !== 'SessionEnd') return undefined;
  if (!isFileId(sessionId)) return undefined;
  if (
    typeof transcriptPath !== 'string' ||
    !isAbsolute(transcriptPath) ||
    !transcriptPath.endsWith('.jsonl')
  )
    return undefined;
  const stop: Stop = { sessionId, transcriptPath, event, at };
  if (event === 'Stop' && isFileId(given.turn_id)) stop.turnId = given.turn_id;
  if (typeof given.cwd === 'string' && isAbsolute(given.cwd)) stop.cwd = given.cwd;
  const model = typeof given.model === 'string' ? given.model.trim() : '';
  if (model !== '' && model.length <= MODEL_MAX) stop.model = model;
  return stop;
}
