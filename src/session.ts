/**
 * One hook's work on one session: the turns of a thread that have ended since
 * the last hook sent, each sent as a run and the place after it saved, so a
 * turn is sent once and none is skipped. At the session's end, its
 * subagents' threads too.
 */

import { statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RunRecord } from 'telmoni';

import type { HookInput } from './input.js';
import { kindOf } from './log.js';
import { type Context, type Ending, hasWork, recordOf } from './record.js';
import { type Meta, Reader, readMeta } from './rollout.js';
import type { Destination } from './send.js';
import type { Settings } from './settings.js';
import { type ThreadState, readState, stateName, subagentsOf, withLock, writeState } from './state.js';
import { type Checkpoint, type Turn, Turns } from './turns.js';

export interface Deps {
  sender: (destination: Destination) => { send(record: RunRecord): Promise<boolean>; close(): Promise<void> };
  log: (line: string) => void;
  /** How long a stopped turn's closing line is waited for, and how often the rollout is looked at meanwhile. */
  closeWaitMs?: number;
  pollMs?: number;
}

/** How long a hook waits for another of the same thread to finish. */
const LOCK_WAIT_MS = 150_000;
/**
 * Codex writes a stopped turn's closing line once every Stop hook has
 * returned, another plugin's slow one among them, and any compaction after
 * the turn is done.
 */
const CLOSE_WAIT_MS = 60_000;
const POLL_MS = 250;
/** How often the place reached is saved while turns are sent; a turn sent again after a crash is stored once. */
const SAVE_EVERY_MS = 1_000;

type Send = (record: RunRecord) => Promise<boolean>;

export async function sync(input: HookInput, settings: Settings, deps: Deps): Promise<void> {
  if (input.rolloutPath === undefined) return;
  const { apiKey } = settings;
  if (apiKey === undefined) {
    const name = stateName(input.sessionId, input.threadId);
    const state = readState(settings.dir, name);
    if (!state.warnedNoKey) {
      deps.log('no key: put it in ~/.codex/telmoni.json, or TELMONI_API_KEY; nothing is sent until then');
      writeState(settings.dir, name, { ...state, warnedNoKey: true });
    }
    return;
  }
  let sender: ReturnType<Deps['sender']> | undefined;
  const send: Send = (record) => (sender ??= deps.sender({ endpoint: settings.endpoint, apiKey })).send(record);
  try {
    if (!(await readThread(input, input.rolloutPath, settings, deps, send))) return;
    if (input.event !== 'SessionEnd') return;
    // A subagent's thread has no end of its own: the session's is its end.
    for (const threadId of subagentsOf(settings.dir, input.sessionId)) {
      const { path } = readState(settings.dir, stateName(input.sessionId, threadId));
      if (path === undefined) continue;
      const subagent: HookInput = { event: 'SessionEnd', sessionId: input.sessionId, threadId, rolloutPath: path };
      if (!(await readThread(subagent, path, settings, deps, send))) return;
    }
  } finally {
    await sender?.close();
  }
}

/** False where a turn was not taken, and the hooks after this one are to send it. */
async function readThread(input: HookInput, path: string, settings: Settings, deps: Deps, send: Send): Promise<boolean> {
  const name = stateName(input.sessionId, input.threadId);
  let going = true;
  const locked = await withLock(settings.dir, name, LOCK_WAIT_MS, async () => {
    going = await readLocked(input, path, name, settings, deps, send);
  });
  if (!locked) deps.log('busy: another hook of this thread held its lock past the wait; the next hook sends');
  return going;
}

async function readLocked(
  input: HookInput,
  path: string,
  name: string,
  settings: Settings,
  deps: Deps,
  send: Send,
): Promise<boolean> {
  let size: number;
  let ino: number | undefined;
  let meta: Meta | undefined;
  try {
    const stat = statSync(path);
    size = stat.size;
    ino = Number.isSafeInteger(stat.ino) && stat.ino > 0 ? stat.ino : undefined;
    meta = readMeta(path);
  } catch (error) {
    // A session archived or deleted as it ended takes its rollout with it.
    const gone = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!(gone && input.event === 'SessionEnd')) deps.log(`rollout not read: ${kindOf(error)}`);
    return true;
  }
  if (meta === undefined || meta.threadId !== input.threadId) {
    deps.log('rollout not read: its first line names no thread of this hook');
    return true;
  }
  const state = readState(settings.dir, name);
  const same =
    state.path === path && (state.ino === undefined || ino === undefined || state.ino === ino) && state.offset <= size;
  const from: Checkpoint = same
    ? { offset: state.offset, countKey: state.countKey, model: state.model }
    : { offset: 0, countKey: undefined, model: undefined };
  const sent = new Set(state.sent);
  const turns = new Turns(meta, sent, input.turnId, from);
  const context: Context = { sessionId: input.sessionId, provider: meta.provider, model: input.model };
  let saved = Date.now();
  const save = (at: Checkpoint): void => {
    const next: ThreadState = { offset: at.offset, path, sent: [...sent] };
    if (ino !== undefined) next.ino = ino;
    if (at.countKey !== undefined) next.countKey = at.countKey;
    if (at.model !== undefined) next.model = at.model;
    if (state.warnedNoKey) next.warnedNoKey = true;
    writeState(settings.dir, name, next);
    saved = Date.now();
  };
  // A turn with the model's work in it is sent; one the platform did not take
  // is read again from its opening by the next hook.
  const finish = async (turn: Turn, ending?: Ending): Promise<boolean> => {
    if (hasWork(turn)) {
      const record = recordOf(turn, context, ending);
      if (record !== undefined && !(await send(record))) {
        save(turn.before);
        return false;
      }
    }
    sent.add(turn.id);
    return true;
  };
  const target = input.turnId;
  const deadline = Date.now() + (target === undefined ? 0 : (deps.closeWaitMs ?? CLOSE_WAIT_MS));
  const reader = new Reader(path, from.offset);
  try {
    for (;;) {
      const lines = reader.read();
      if (lines === undefined) {
        if (target === undefined || sent.has(target) || Date.now() >= deadline) break;
        await sleep(deps.pollMs ?? POLL_MS);
        continue;
      }
      for (const line of lines) {
        for (const turn of turns.push(line)) {
          if (!(await finish(turn))) return false;
          if (Date.now() - saved >= SAVE_EVERY_MS) save(turns.checkpoint());
        }
      }
    }
    // The turn the hook named is final as it stands, its closing line
    // unwritten yet; at the session's end, so is whatever was left open.
    const open = turns.open;
    if (open !== undefined) {
      let ending: Ending | undefined;
      if (open.id === target) ending = input.event === 'Interrupt' ? 'interrupted' : 'stopped';
      else if (input.event === 'SessionEnd') ending = 'session-ended';
      if (ending !== undefined) {
        if (!(await finish(open, ending))) return false;
        turns.release();
      }
    }
    // What a Codex that wrote its turns otherwise would look like from here.
    if (target !== undefined && !sent.has(target)) deps.log('the turn this hook named is not in its rollout; nothing of it sent');
    save(turns.checkpoint());
    return true;
  } finally {
    reader.close();
  }
}
