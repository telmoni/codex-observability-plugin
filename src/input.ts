/** What a hook is handed: by Codex on stdin, or by the hook to its detached copy. */

import { isAbsolute } from 'node:path';

import { fieldsOf, nameOf } from './rollout.js';

export type HookEvent = 'Stop' | 'SubagentStop' | 'Interrupt' | 'SessionEnd';

/** The event, the session, the thread and its rollout, the turn and its model; nothing else Codex sends is read. */
export interface HookInput {
  event: HookEvent;
  /** Codex's session: its root thread's id, which a subagent's hook names too. */
  sessionId: string;
  /** The thread whose rollout is read: the session's root, or the subagent that stopped. */
  threadId: string;
  /** Absent where Codex keeps no rollout, as for an ephemeral session. */
  rolloutPath?: string;
  /** The turn that stopped or was interrupted: final, whatever its rollout says of it yet. */
  turnId?: string;
  /** The model Codex names for that turn, for a turn whose rollout names none. */
  model?: string;
}

const EVENTS = new Set<HookEvent>(['Stop', 'SubagentStop', 'Interrupt', 'SessionEnd']);

/** A session or thread id names a file here: anything but a plain id is refused. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TURN_ID = /^[\w.:-]{1,128}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function checked(candidate: Record<keyof HookInput, unknown>): HookInput | undefined {
  const { event, sessionId, threadId, rolloutPath, turnId, model } = candidate;
  if (typeof event !== 'string' || !EVENTS.has(event as HookEvent)) return undefined;
  if (!isId(sessionId) || !isId(threadId)) return undefined;
  const input: HookInput = { event: event as HookEvent, sessionId, threadId };
  if (rolloutPath !== null && rolloutPath !== undefined) {
    // A rollout Codex has compressed (`.jsonl.zst`) is not one the plugin reads.
    if (typeof rolloutPath !== 'string' || !isAbsolute(rolloutPath) || !rolloutPath.endsWith('.jsonl')) return undefined;
    input.rolloutPath = rolloutPath;
  }
  if (event !== 'SessionEnd') {
    if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) return undefined;
    input.turnId = turnId;
  }
  const named = nameOf(model);
  if (named !== undefined) input.model = named;
  return input;
}

/**
 * Codex's own input. A subagent's hook names the session's rollout as `transcript_path` and the subagent's own, the one
 * its turn is in, as `agent_transcript_path`.
 */
export function inputFrom(raw: unknown): HookInput | undefined {
  const fields = fieldsOf(raw) ?? {};
  const subagent = fields['hook_event_name'] === 'SubagentStop';
  return checked({
    event: fields['hook_event_name'],
    sessionId: fields['session_id'],
    threadId: subagent ? fields['agent_id'] : fields['session_id'],
    rolloutPath: subagent ? fields['agent_transcript_path'] : fields['transcript_path'],
    turnId: fields['turn_id'],
    model: fields['model'],
  });
}

/** The input as the hook hands it to its detached copy, checked again there. */
export function handedOff(raw: unknown): HookInput | undefined {
  const fields = fieldsOf(raw) ?? {};
  return checked({
    event: fields['event'],
    sessionId: fields['sessionId'],
    threadId: fields['threadId'],
    rolloutPath: fields['rolloutPath'],
    turnId: fields['turnId'],
    model: fields['model'],
  });
}
