/**
 * What has been sent of each thread — `<session_id>.json` in the plugin's
 * folder for a session's own thread, `<session_id>.<thread_id>.json` for a
 * subagent's beside it — and the lock that keeps two hooks of one thread from
 * sending the same turns at once.
 */

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { isId } from './input.js';
import type { Opening } from './rollout.js';

export interface ThreadState {
  /** Where in the rollout the first turn not yet sent begins, in bytes. */
  offset: number;
  /**
   * The rollout the offset is into, and its file's identity: a thread moved
   * to a new rollout, or a rollout replaced where it lies, is read again
   * from its start, and `sent` keeps what was sent from being sent again.
   */
  path?: string;
  ino?: number;
  /** The turns sent, oldest first. */
  sent?: string[];
  /**
   * The running total the rollout last gave, at the offset: a legacy rollout
   * repeats it whenever Codex's rate limits refresh, which is no new response.
   */
  countKey?: string;
  /** The model the rollout last named, at the offset, for a turn that names none. */
  model?: string;
  /** The latest turn to open at or before the offset, and where: the rollout read again from its start where it no longer opens there. */
  opening?: Opening;
  /** Whether a missing key has been logged for this thread, so it is logged once. */
  warnedNoKey?: boolean;
}

/** The sent turns kept: a session's whole history, but for the longest ever run. */
const MAX_SENT = 5_000;

/** A session's own thread is filed under the session; a subagent's beside it, under both. */
export function stateName(sessionId: string, threadId: string): string {
  return sessionId === threadId ? sessionId : `${sessionId}.${threadId}`;
}

/** The subagent threads of `sessionId` a hook has read, by their thread ids. */
export function subagentsOf(dir: string, sessionId: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // Nothing read yet.
  }
  const prefix = `${sessionId}.`;
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => name.slice(prefix.length, -'.json'.length))
    .filter(isId)
    .sort();
}

export function readState(dir: string, name: string): ThreadState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Partial<Record<keyof ThreadState, unknown>>;
    const offset = parsed.offset;
    const state: ThreadState = { offset: Number.isSafeInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0 };
    if (typeof parsed.path === 'string') state.path = parsed.path;
    if (Number.isSafeInteger(parsed.ino) && (parsed.ino as number) > 0) state.ino = parsed.ino as number;
    if (Array.isArray(parsed.sent)) state.sent = parsed.sent.filter((id): id is string => typeof id === 'string');
    if (typeof parsed.countKey === 'string') state.countKey = parsed.countKey;
    if (typeof parsed.model === 'string') state.model = parsed.model;
    const opening = parsed.opening as Partial<Record<keyof Opening, unknown>> | null | undefined;
    if (Number.isSafeInteger(opening?.at) && (opening?.at as number) >= 0 && typeof opening?.turnId === 'string') {
      state.opening = { at: opening.at as number, turnId: opening.turnId };
    }
    if (parsed.warnedNoKey === true) state.warnedNoKey = true;
    return state;
  } catch {
    return { offset: 0 };
  }
}

export function writeState(dir: string, name: string, state: ThreadState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.json`);
  const kept = state.sent === undefined ? state : { ...state, sent: state.sent.slice(-MAX_SENT) };
  // Written aside and renamed over, so a hook killed mid-write leaves the
  // last state whole rather than half of the new one.
  writeFileSync(`${path}.tmp`, JSON.stringify(kept), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** A lock not freshened for this long was left by a hook that died holding it. */
const STALE_MS = 60_000;

/**
 * Holds the thread's lock while `work` runs, waiting up to `waitMs` for it; false, `work` not run, if it never comes free.
 * `staleMs`, how long an untouched lock stands, is the tests' to shorten.
 */
export async function withLock(
  dir: string,
  name: string,
  waitMs: number,
  work: () => Promise<void>,
  staleMs = STALE_MS,
): Promise<boolean> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.lock`);
  // Written into the lock, so a hook lets go of its own and never of one another hook took from it after a sleep of the machine.
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
      } catch {
        // Freed between the two calls.
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }
  // Kept fresh while held, every ten seconds by default, so only a dead hook's lock goes stale however long it waits.
  const freshen = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // Taken away: the release below leaves it alone.
    }
  }, staleMs / 6);
  freshen.unref();
  try {
    await work();
  } finally {
    clearInterval(freshen);
    try {
      if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
    } catch {
      // Gone already.
    }
  }
  return true;
}
