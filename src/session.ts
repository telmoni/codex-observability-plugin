/**
 * One hook's work on one session: the turns of a thread ended since the last hook sent, each sent as a run and the
 * place after it saved, so a turn is sent once and none is skipped; at the session's end, its subagents' threads too.
 */

import { statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RunRecord } from 'telmoni';

import type { HookInput } from './input.js';
import { kindOf } from './log.js';
import { type Context, type Ending, MAX_CALLS, hasWork, recordOf } from './record.js';
import { type Meta, Reader, readMeta, readsAsBefore } from './rollout.js';
import type { Destination } from './send.js';
import type { Settings } from './settings.js';
import { type ThreadState, leftSessions, markLeft, readState, stateName, subagentsOf, withLock, writeState } from './state.js';
import { type Checkpoint, type Turn, Turns } from './turns.js';

export interface Deps {
  sender: (destination: Destination) => { send(record: RunRecord, release?: string): Promise<boolean>; close(): Promise<void> };
  log: (line: string) => void;
  /** How long a stopped turn's closing line is waited for with no news of the turn, and how often the rollout is looked at meanwhile. */
  closeWaitMs?: number;
  pollMs?: number;
  /** How long a hook but the session's end waits for another's lock; the tests' to shorten. */
  lockWaitMs?: number;
}

/**
 * Codex writes a stopped turn's closing line once every Stop hook has returned (another plugin's gets ten minutes) and
 * any compaction is done: so it is waited for while the turn's lines come, and ten minutes past the last.
 */
const CLOSE_WAIT_MS = 10 * 60_000;
const POLL_MS = 250;
/** How long a hook waits for another of the same thread to finish: past a quiet wait for a closing line. */
const LOCK_WAIT_MS = CLOSE_WAIT_MS + 2 * 60_000;
/** How often the place reached is saved while turns are sent; a turn sent again after a crash is stored once. */
const SAVE_EVERY_MS = 1_000;

type Send = (record: RunRecord, release?: string) => Promise<boolean>;

/** How long a hook waits for its thread's lock: the session's end, which no hook follows, outwaits any live holder. */
function lockWaitOf(input: HookInput, deps: Deps): number {
  return input.event === 'SessionEnd' ? Number.POSITIVE_INFINITY : (deps.lockWaitMs ?? LOCK_WAIT_MS);
}

/** Logs `line` once a thread, remembered in its state as `flag`, under the thread's lock so no hook's save is lost to it. */
async function logOnce(settings: Settings, input: HookInput, flag: 'warnedNoKey' | 'warnedKeyFile' | 'warnedEndpoint', line: string, deps: Deps): Promise<void> {
  const name = stateName(input.sessionId, input.threadId);
  // Said once already: nothing to wait for the lock for.
  if (readState(settings.dir, name)[flag] === true) return;
  await withLock(settings.dir, name, lockWaitOf(input, deps), async () => {
    const state = readState(settings.dir, name);
    if (state[flag] === true) return;
    deps.log(line);
    const next: ThreadState = { ...state, [flag]: true };
    // With its rollout, so the session's end finds a subagent that stopped before there was a key to send it with.
    if (next.path === undefined && input.rolloutPath !== undefined) next.path = input.rolloutPath;
    writeState(settings.dir, name, next);
  });
}

export async function sync(input: HookInput, settings: Settings, deps: Deps): Promise<void> {
  if (input.rolloutPath === undefined) return;
  const { apiKey, keyFileProblem } = settings;
  // The file passed over may have named the endpoint: the key never goes to the default in its place.
  if (keyFileProblem !== undefined) {
    const line = `${settings.keyFileName} not used (${keyFileProblem}): fix it, or set TELMONI_API_KEY, with TELMONI_ENDPOINT for a Telmoni of your own; nothing is sent until then`;
    await logOnce(settings, input, 'warnedKeyFile', line, deps);
    return;
  }
  if (apiKey === undefined) {
    await logOnce(settings, input, 'warnedNoKey', `no key: put it in ${settings.keyFileName}, or TELMONI_API_KEY; nothing is sent until then`, deps);
    return;
  }
  let sender: ReturnType<Deps['sender']>;
  try {
    sender = deps.sender({ endpoint: settings.endpoint, apiKey });
  } catch (error) {
    // The SDK's refusal names the endpoint's host at most, never a path, a key or anything of the session.
    if (!(error instanceof TypeError)) throw error;
    const line = `endpoint refused by the SDK (${error.message}): put another in ${settings.keyFileName}, or TELMONI_ENDPOINT`;
    await logOnce(settings, input, 'warnedEndpoint', `${line}; nothing is sent until then`, deps);
    return;
  }
  const send: Send = (record, release) => sender.send(record, release);
  try {
    const waitMs = lockWaitOf(input, deps);
    let reached: boolean;
    if (input.event === 'SessionEnd') {
      reached = await endSession(input, input.rolloutPath, settings, deps, send, waitMs);
      markLeft(settings.dir, input.sessionId, !reached);
    } else {
      reached = await readThread(input, input.rolloutPath, settings, deps, send, waitMs);
    }
    if (reached) await sendLeft(input.sessionId, settings, deps, send);
  } finally {
    await sender.close();
  }
}

/** A session's own thread and then its subagents', each ended with it; false where a turn was not taken. */
async function endSession(input: HookInput, path: string, settings: Settings, deps: Deps, send: Send, waitMs: number): Promise<boolean> {
  if (!(await readThread(input, path, settings, deps, send, waitMs))) return false;
  // A subagent's thread has no end of its own: the session's is its end.
  for (const threadId of subagentsOf(settings.dir, input.sessionId)) {
    let subagentPath: string | undefined;
    try {
      ({ path: subagentPath } = readState(settings.dir, stateName(input.sessionId, threadId)));
    } catch (error) {
      // One subagent's state unread holds up none of the others'.
      deps.log(`subagent ${threadId.slice(0, 8)}: state not read: ${kindOf(error)}`);
      continue;
    }
    if (subagentPath === undefined) continue;
    const subagent: HookInput = { event: 'SessionEnd', sessionId: input.sessionId, threadId, rolloutPath: subagentPath };
    if (!(await readThread(subagent, subagentPath, settings, deps, send, waitMs))) return false;
  }
  return true;
}

/** What other sessions' ends left, the longest waiting first, each lock taken without waiting, until one is still not taken. */
async function sendLeft(own: string, settings: Settings, deps: Deps, send: Send): Promise<void> {
  for (const sessionId of leftSessions(settings.dir)) {
    if (sessionId === own) continue;
    let path: string | undefined;
    try {
      ({ path } = readState(settings.dir, sessionId));
    } catch (error) {
      deps.log(`session ${sessionId.slice(0, 8)}: state not read: ${kindOf(error)}`);
      continue;
    }
    if (path === undefined) {
      markLeft(settings.dir, sessionId, false);
      continue;
    }
    const left: HookInput = { event: 'SessionEnd', sessionId, threadId: sessionId, rolloutPath: path };
    const reached = await endSession(left, path, settings, deps, send, 0);
    markLeft(settings.dir, sessionId, !reached);
    // The platform away again, or another hook at work on that session: the next hook tries again.
    if (!reached) return;
  }
}

/** False where a turn was not taken, and the hooks after this one are to send it, or where a lock taken without waiting was held. */
async function readThread(input: HookInput, path: string, settings: Settings, deps: Deps, send: Send, waitMs: number): Promise<boolean> {
  const name = stateName(input.sessionId, input.threadId);
  let going = true;
  const locked = await withLock(settings.dir, name, waitMs, async () => {
    going = await readLocked(input, path, name, settings, deps, send);
  });
  if (!locked) {
    if (waitMs === 0) return false;
    deps.log('busy: another hook of this thread held its lock past the wait; the next hook sends');
  }
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
    state.path === path &&
    (state.ino === undefined || ino === undefined || state.ino === ino) &&
    state.offset <= size &&
    readsAsBefore(path, state.offset, state.opening);
  const from: Checkpoint = same
    ? { offset: state.offset, countKey: state.countKey, model: state.model, opening: state.opening }
    : { offset: 0, countKey: undefined, model: undefined };
  const sent = new Set(state.sent);
  const turns = new Turns(meta, sent, input.turnId, from);
  const context: Context = { sessionId: input.sessionId, provider: meta.provider, model: input.model };
  if (meta.version !== undefined) context.release = meta.version;
  let saved = Date.now();
  const save = (at: Checkpoint): void => {
    const next: ThreadState = { offset: at.offset, path, sent: [...sent] };
    if (ino !== undefined) next.ino = ino;
    if (at.countKey !== undefined) next.countKey = at.countKey;
    if (at.model !== undefined) next.model = at.model;
    if (at.opening !== undefined) next.opening = at.opening;
    if (state.warnedNoKey) next.warnedNoKey = true;
    if (state.warnedKeyFile) next.warnedKeyFile = true;
    if (state.warnedEndpoint) next.warnedEndpoint = true;
    writeState(settings.dir, name, next);
    saved = Date.now();
  };
  // A turn with the model's work in it is sent; one the platform did not take is read again from its opening by the next hook.
  const finish = async (turn: Turn, ending?: Ending): Promise<boolean> => {
    if (hasWork(turn)) {
      const calls = turn.responses.length + turn.calls.size;
      if (calls > MAX_CALLS) deps.log(`turn too long: ${calls - MAX_CALLS} of its ${calls} calls, the latest, not sent`);
      const record = recordOf(turn, context, ending);
      if (record !== undefined && !(await send(record, context.release))) {
        save(turn.before);
        return false;
      }
    }
    sent.add(turn.id);
    return true;
  };
  const target = input.turnId;
  // What the hook says of the turn it names, where no closing line of the turn's own says otherwise.
  const named: Ending = input.event === 'Interrupt' ? 'interrupted' : 'stopped';
  const quietMs = target === undefined ? 0 : (deps.closeWaitMs ?? CLOSE_WAIT_MS);
  let news = Date.now();
  const reader = new Reader(path, from.offset);
  try {
    for (;;) {
      const lines = reader.read();
      if (lines === undefined) {
        if (target === undefined || sent.has(target) || Date.now() - news >= quietMs) break;
        await sleep(deps.pollMs ?? POLL_MS);
        continue;
      }
      for (const line of lines) {
        for (const turn of turns.push(line)) {
          if (!(await finish(turn, turn.id === target ? named : undefined))) return false;
          if (Date.now() - saved >= SAVE_EVERY_MS) save(turns.checkpoint());
        }
      }
      // Only the named turn's own lines put off giving up on it: another's would have closed it, and the thread's other work is no news.
      if (turns.open?.id === target) news = Date.now();
    }
    // The turn the hook named is final as it stands, its closing line unwritten; at the session's end, so is whatever was left open.
    const open = turns.open;
    if (open !== undefined) {
      let ending: Ending | undefined;
      if (open.id === target) ending = named;
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
