/**
 * What has been sent of each thread — `<session_id>.json` for a session's own thread, `<session_id>.<thread_id>.json`
 * for a subagent's beside it — and the lock that keeps two hooks of one thread from sending the same turns at once.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
   * The rollout the offset is into, and its file's identity: a thread moved to a new rollout, or a rollout replaced
   * where it lies, is read again from its start, and `sent` keeps what was sent from being sent again.
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
  /** Whether a key file passed over has been logged for this thread, so it is logged once. */
  warnedKeyFile?: boolean;
  /** Whether an endpoint the SDK refused has been logged for this thread, so it is logged once. */
  warnedEndpoint?: boolean;
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

/** What a session's end left: how long its rollout was then, and where its key sends (`destinationOf`). */
export interface Left {
  size: number;
  destination: string;
}

/**
 * Marks, or unmarks, a session whose end met a turn the platform did not take: a session's end is its last hook, so the
 * next hook of any session sends what it left.
 */
export function markLeft(dir: string, sessionId: string, left: Left | undefined): void {
  const path = join(dir, `${sessionId}.left`);
  if (left !== undefined) writeFileSync(path, JSON.stringify(left), { mode: 0o600 });
  else rmSync(path, { force: true });
}

/** What a session's end left, or nothing where its marker cannot be read. */
export function readLeft(dir: string, sessionId: string): Left | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, `${sessionId}.left`), 'utf8')) as Partial<Left> | null;
    return value !== null && Number.isSafeInteger(value.size) && typeof value.destination === 'string'
      ? { size: value.size as number, destination: value.destination }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The sessions whose end left turns unsent, the longest waiting first. */
export function leftSessions(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // Nothing read yet.
  }
  const marked = names.filter((name) => name.endsWith('.left')).map((name) => name.slice(0, -'.left'.length)).filter(isId);
  const waited = (sessionId: string): number => {
    try {
      return statSync(join(dir, `${sessionId}.left`)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return marked.sort((a, b) => waited(a) - waited(b) || a.localeCompare(b));
}

/** A thread's state: afresh only where none was saved, since one read as new would send the thread again from the top. */
export function readState(dir: string, name: string): ThreadState {
  let text: string;
  try {
    text = readFileSync(join(dir, `${name}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { offset: 0 };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('thread state is not an object');
  const parsed = value as Partial<Record<keyof ThreadState, unknown>>;
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
  if (parsed.warnedKeyFile === true) state.warnedKeyFile = true;
  if (parsed.warnedEndpoint === true) state.warnedEndpoint = true;
  return state;
}

export function writeState(dir: string, name: string, state: ThreadState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.json`);
  const kept = state.sent === undefined ? state : { ...state, sent: state.sent.slice(-MAX_SENT) };
  // Synced aside, then renamed over: a hook killed, or a machine stopped, mid-write leaves the last state whole.
  // Its own, so a hook that took a stale lock in the same instant as another never writes into this one's.
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(kept));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
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
