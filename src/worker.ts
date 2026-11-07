/**
 * The worker the hook starts, detached: under the session's lock it reads the rollout once the stopped turn is written,
 * sends each turn that can no longer change, keeps what Telmoni could not take, then sends what others left.
 */

import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RunRecord } from 'telmoni';

import type { Stop } from './payload.js';
import { keyFile, stateDir } from './paths.js';
import { recordTurn, runIdOf } from './record.js';
import { kindOf, shortId, writeLog } from './shared/log.js';
import {
  type Destination,
  Sender,
  type SenderOptions,
  isDone,
  verdictLine,
} from './shared/send.js';
import { type Settings, destinationOf, resolveSettings } from './shared/settings.js';
import {
  ensurePrivateDir,
  markedIds,
  readStateFile,
  withLock,
  writeStateFile,
} from './shared/state.js';
import { tagRun } from './shared/tags.js';
import { type RolloutRead, type Row, readRollout } from './transcript.js';
import { type Turn, cut, isComplete } from './turns.js';

/** The run ids a session remembers sending, newest last. */
export const SENT_MAX = 500;
/** The runs a session keeps for Telmoni, oldest first: past this, the oldest go. */
export const PENDING_MAX = 200;

/** A run Telmoni could not take yet, with the Codex version it is sent as. */
export interface Kept {
  run: RunRecord;
  release?: string;
}

/** A session's file, `<session>.json`. */
export interface State {
  /** Where in the rollout the first turn not yet done with begins, in bytes; turns before it were sent, or passed over. */
  offset?: number;
  sent: string[];
  /** Runs Telmoni could not take yet, with their conversation where content is on. */
  pending: Kept[];
  /** The once-a-session lines already logged. */
  warned: string[];
  /** Where its runs go, as a digest of the endpoint under the key: kept runs go nowhere else. */
  destination?: string;
}

export interface WorkOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** The home folder `.codex` is under; the person's own unless a test names one. */
  home?: string | undefined;
  /** The SDK's transport and wait, for a test. */
  hooks?: SenderOptions['hooks'];
  /** How long the rollout must stay still before it is read, and the longest to wait for the stopped turn's close. */
  settleMs?: number | undefined;
  settleMaxMs?: number | undefined;
  /** How long to wait for another hook at work on the same session. */
  lockWaitMs?: number | undefined;
}

type Log = (line: string) => void;

const NO_KEY = 'no key: set TELMONI_API_KEY, or write ~/.codex/telmoni.json';

/** Everything one stop sets off; it never throws, every fault a line in the log. */
export async function work(stop: Stop, options: WorkOptions): Promise<void> {
  const dir = stateDir(options.env, options.home);
  const log: Log = (line) => writeLog(dir, `${shortId(stop.sessionId)} ${line}`);
  try {
    ensurePrivateDir(dir, { tighten: true });
    const settings = resolveSettings({
      env: options.env,
      keyFiles: [keyFile(options.env, options.home)],
    });
    let destination: string | undefined;
    const took = await withLock(dir, stop.sessionId, options.lockWaitMs ?? 60_000, async () => {
      const state = load(dir, stop.sessionId, log);
      if (state === undefined) return;
      try {
        destination = await own(stop, state, settings, options, dir, log);
      } finally {
        save(dir, stop.sessionId, state);
      }
    });
    if (!took) log('another hook holds the session: its turns wait for the next');
    if (destination !== undefined)
      await leftovers(dir, stop.sessionId, destination, settings, options);
  } catch (error) {
    log(`fault: ${kindOf(error)}`);
  }
}

/** The session's own turns; the destination it sent to, where every run it kept went. */
async function own(
  stop: Stop,
  state: State,
  settings: Settings,
  options: WorkOptions,
  dir: string,
  log: Log,
): Promise<string | undefined> {
  const warned = new Set(state.warned);
  const once = (line: string): void => {
    if (!warned.has(line)) log(line);
    warned.add(line);
  };
  try {
    if (settings.keyFileProblem !== undefined)
      return void once(`key file not read: ${settings.keyFileProblem}; nothing is sent`);
    if (settings.apiKey === undefined) return void once(NO_KEY);
    const destination = destinationOf(settings);
    if (
      state.destination !== undefined &&
      state.destination !== destination &&
      state.pending.length > 0
    ) {
      log(`${state.pending.length} kept turns dropped: the key or the endpoint changed`);
      state.pending = [];
    }
    state.destination = destination;

    const read = await settled(stop, state.offset ?? 0, settings.captureContent, options);
    if ('problem' in read) return void log(read.problem);
    const sessionEnded = stop.event === 'SessionEnd';
    let turns = cut(read.rows);
    if (state.offset === undefined) {
      // A session first heard of is recorded from the turn this stop ended: its history before stays home.
      const ended = turns.find((turn) => turn.id === stop.turnId);
      state.offset = ended?.open.offset ?? read.end;
      turns = turns.filter((turn) => turn.open.offset >= (state.offset ?? 0));
    }

    let sender: Sender;
    try {
      sender = new Sender(sendingTo(settings), { hooks: options.hooks });
    } catch (error) {
      if (error instanceof TypeError) return void once(`endpoint refused: ${error.message}`);
      throw error;
    }
    try {
      await sendKept(state, sender, dir, stop.sessionId, log);
      const release = read.session.cliVersion;
      const fallback = { model: stop.model, provider: read.session.provider, effort: undefined };
      let next = 0;
      for (const turn of turns) {
        next += 1;
        if (!isComplete(turn, sessionEnded)) {
          // A turn begun after the hook ran is at work, as it should be: only one begun before it is held.
          if (turn.open.offset < (stop.size ?? Number.POSITIVE_INFINITY))
            log(`held ${shortId(runIdOf(stop.sessionId, turn.id))}: its turn is not over yet`);
          break;
        }
        state.offset = turns[next]?.open.offset ?? read.end;
        const runId = runIdOf(stop.sessionId, turn.id);
        if (state.sent.includes(runId)) continue;
        const record = recordTurn(turn, {
          sessionId: stop.sessionId,
          ...lastSettings(read.rows, turn, fallback),
          sessionEnded,
          content: settings.captureContent,
        });
        if (record === undefined) continue;
        tagRun(record, stop.cwd, warned, log);
        const kept: Kept = release === undefined ? { run: record } : { run: record, release };
        // Behind a kept run, in order: Telmoni gets a session's turns as they came.
        if (state.pending.length > 0 || !(await deliver(sender, kept, log)))
          state.pending.push(kept);
        else remember(state, record.runId);
        save(dir, stop.sessionId, state);
      }
    } finally {
      await sender.close();
    }
    if (state.pending.length > PENDING_MAX) {
      const dropped = state.pending.length - PENDING_MAX;
      state.pending.splice(0, dropped);
      log(`${dropped} kept turns dropped, the oldest: past ${PENDING_MAX} waiting`);
    }
    return state.pending.length === 0 ? destination : undefined;
  } finally {
    state.warned = [...warned];
  }
}

/**
 * The rollout from `from` once Codex has closed the stopped turn, which it does only after its `Stop` hooks return: read
 * when it has stayed still for `settleMs` and holds the close, or at `settleMaxMs` as it is, the turn then held.
 */
async function settled(
  stop: Stop,
  from: number,
  content: boolean,
  options: WorkOptions,
): Promise<RolloutRead> {
  const stillMs = options.settleMs ?? 500;
  // Long enough for a compaction Codex runs after the turn, before it closes it.
  const deadline = Date.now() + (options.settleMaxMs ?? 30_000);
  const signature = (): string => {
    try {
      const { size, mtimeMs } = statSync(stop.transcriptPath);
      return `${size}:${mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  let seen = signature();
  let since = Date.now();
  // Read once each time the rollout goes still, never again until it changes.
  let read: RolloutRead | undefined;
  for (;;) {
    const now = Date.now();
    if (read === undefined && now - since >= stillMs) {
      read = readRollout(stop.transcriptPath, { content, from });
      const closed =
        'problem' in read ||
        stop.turnId === undefined ||
        read.rows.some(
          (row) =>
            row.turnId === stop.turnId &&
            (row.kind === 'turn_complete' || row.kind === 'turn_aborted'),
        );
      if (closed) return read;
    }
    if (now >= deadline) return read ?? readRollout(stop.transcriptPath, { content, from });
    await sleep(Math.min(100, Math.max(stillMs, 10)));
    const signed = signature();
    if (signed !== seen) {
      seen = signed;
      since = Date.now();
      read = undefined;
    }
  }
}

/** The model, provider and effort the session last set before `turn`, else what the hook and the rollout's first line name. */
function lastSettings(
  rows: readonly Row[],
  turn: Turn,
  fallback: { model: string | undefined; provider: string | undefined; effort: string | undefined },
): { model: string | undefined; provider: string | undefined; effort: string | undefined } {
  const set = { ...fallback };
  for (const row of rows) {
    if (row.offset >= turn.open.offset) break;
    if (row.kind !== 'settings') continue;
    if (row.model !== undefined) set.model = row.model;
    if (row.provider !== undefined) set.provider = row.provider;
    if (row.effort !== undefined) set.effort = row.effort;
  }
  return set;
}

function sendingTo(settings: Settings): Destination {
  return {
    endpoint: settings.endpoint,
    apiKey: settings.apiKey ?? '',
    captureContent: settings.captureContent,
    scrubSecrets: settings.scrubSecrets,
    scrubPii: settings.scrubPii,
  };
}

/** Sends one run and logs what became of it; true where it is done with, false where it is to go again. */
async function deliver(sender: Sender, kept: Kept, log: Log): Promise<boolean> {
  const verdict = await sender.send(kept.run, { release: kept.release });
  const line = verdictLine(verdict);
  const run = shortId(kept.run.runId);
  if (!isDone(verdict)) {
    log(`kept ${run}, ${line ?? 'not sent'}`);
    return false;
  }
  log(line === undefined ? `sent ${run}` : `${run} ${line}`);
  return true;
}

function remember(state: State, runId: string): void {
  state.sent.push(runId);
  if (state.sent.length > SENT_MAX) state.sent.splice(0, state.sent.length - SENT_MAX);
}

/** The session's kept runs, oldest first, until one is kept again; true once none is left. */
async function sendKept(
  state: State,
  sender: Sender,
  dir: string,
  id: string,
  log: Log,
): Promise<boolean> {
  for (let kept = state.pending[0]; kept !== undefined; kept = state.pending[0]) {
    if (!(await deliver(sender, kept, log))) return false;
    state.pending.shift();
    remember(state, kept.run.runId);
    save(dir, id, state);
  }
  return true;
}

/**
 * What other sessions kept, the longest waiting first, each under its own lock taken without waiting, and only where it
 * was meant for the same destination; stops at the first Telmoni still cannot take.
 */
async function leftovers(
  dir: string,
  own: string,
  destination: string,
  settings: Settings,
  options: WorkOptions,
): Promise<void> {
  for (const id of markedIds(dir, '.pending', own)) {
    const log: Log = (line) => writeLog(dir, `${shortId(id)} ${line}`);
    let blocked = false;
    await withLock(dir, id, 0, async () => {
      const state = load(dir, id, log);
      if (state === undefined || state.destination !== destination) return;
      const sender = new Sender(sendingTo(settings), { hooks: options.hooks });
      try {
        blocked = !(await sendKept(state, sender, dir, id, log));
      } finally {
        await sender.close();
        save(dir, id, state);
      }
    });
    if (blocked) return;
  }
}

/** A session's state, new where none was saved; undefined, logged, where one cannot be read: read as new, it would lose its kept runs. */
function load(dir: string, id: string, log: Log): State | undefined {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = readStateFile(dir, id);
  } catch (error) {
    log(`state unreadable (${kindOf(error)}): nothing is sent until it is fixed or moved aside`);
    return undefined;
  }
  return parseState(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseState(raw: Record<string, unknown> | undefined): State {
  const state: State = { sent: [], pending: [], warned: [] };
  if (raw === undefined) return state;
  if (typeof raw.offset === 'number' && Number.isSafeInteger(raw.offset) && raw.offset >= 0)
    state.offset = raw.offset;
  if (Array.isArray(raw.sent))
    state.sent = raw.sent.filter((id): id is string => typeof id === 'string').slice(-SENT_MAX);
  if (Array.isArray(raw.pending)) {
    for (const entry of raw.pending) {
      if (!isRecord(entry) || !isRecord(entry.run)) continue;
      const kept: Kept = { run: entry.run as unknown as RunRecord };
      if (typeof entry.release === 'string') kept.release = entry.release;
      state.pending.push(kept);
    }
  }
  if (Array.isArray(raw.warned))
    state.warned = raw.warned.filter((line): line is string => typeof line === 'string');
  if (typeof raw.destination === 'string') state.destination = raw.destination;
  return state;
}

/** Saves the state whole, and marks the session as holding kept runs while it does, so any hook finds them. */
function save(dir: string, id: string, state: State): void {
  writeStateFile(dir, id, state);
  const marker = join(dir, `${id}.pending`);
  if (state.pending.length === 0) rmSync(marker, { force: true });
  // Made once, so the longest waiting goes first.
  else if (!existsSync(marker)) writeFileSync(marker, '', { mode: 0o600 });
}
