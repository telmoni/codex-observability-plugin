import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HookEvent, HookInput } from '../src/input';
import { MAX_CALLS, runIdOf } from '../src/record';
import { readMeta } from '../src/rollout';
import { Sender } from '../src/send';
import { type Deps, sync } from '../src/session';
import type { Settings } from '../src/settings';
import { readState, stateName, subagentsOf, withLock, writeState } from '../src/state';
import { CONTENT, FakeIngest, fixture, fixtureLines, payloadOf, tempDir } from './helpers';

let dir: { path: string; remove: () => void };
let settings: Settings;
let sent: RunRecord[];
let answers: boolean[];
let logged: string[];

beforeEach(() => {
  dir = tempDir();
  settings = { apiKey: 'tm_test', endpoint: undefined, dir: join(dir.path, 'telmoni'), keyFileName: '~/.codex/telmoni.json' };
  sent = [];
  answers = [];
  logged = [];
});

afterEach(() => {
  dir.remove();
});

const deps = (overrides: Partial<Deps> = {}): Deps => ({
  sender: () => ({
    send: (record) => {
      const ok = answers.shift() ?? true;
      if (ok) sent.push(record);
      return Promise.resolve(ok);
    },
    close: () => Promise.resolve(),
  }),
  log: (line) => void logged.push(line),
  closeWaitMs: 0,
  pollMs: 10,
  ...overrides,
});

const paginated = fixtureLines('paginated');
const SESSION = readMeta(fixture('paginated'))!.sessionId;

/** Where in a fixture's lines a turn opens, and where its closing line is. */
function opening(lines: typeof paginated, turnId: string): number {
  return lines.findIndex(({ record }) => payloadOf(record)['type'] === 'task_started' && payloadOf(record)['turn_id'] === turnId);
}
function closing(lines: typeof paginated, turnId: string): number {
  return lines.findIndex(
    ({ record }) => ['task_complete', 'turn_aborted'].includes(payloadOf(record)['type'] as string) && payloadOf(record)['turn_id'] === turnId,
  );
}
const turnIds = paginated.flatMap(({ record }) => (payloadOf(record)['type'] === 'task_started' ? [payloadOf(record)['turn_id'] as string] : []));
const [A, B, C, , E, F] = turnIds as [string, string, string, string, string, string];

/** The rollout as Codex would have written it by the end of the `count`th line. */
function writtenThrough(count: number, lines = paginated, name = 'rollout.jsonl'): string {
  const path = join(dir.path, name);
  writeFileSync(path, lines.slice(0, count).map(({ text }) => `${text}\n`).join(''));
  return path;
}

function hook(event: HookEvent, path: string, turnId?: string, overrides: Partial<Deps> = {}, input: Partial<HookInput> = {}): Promise<void> {
  const hookInput: HookInput = { event, sessionId: SESSION, threadId: SESSION, rolloutPath: path, ...input };
  if (turnId !== undefined) hookInput.turnId = turnId;
  return sync(hookInput, settings, deps(overrides));
}

const runIds = (...turns: string[]): string[] => turns.map((turn) => runIdOf(SESSION, turn));

describe('a hook', () => {
  it('sends the turn a Stop names as it stands, its task_complete not yet written, and never sends it twice', async () => {
    const path = writtenThrough(closing(paginated, A));
    await hook('Stop', path, A);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A));
    expect(sent[0]!.cancelled).toBeUndefined();
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
    // Another plugin's Stop hook kept the turn going: Codex runs every Stop hook again for it.
    writtenThrough(closing(paginated, A) + 1);
    await hook('Stop', path, A);
    expect(sent).toHaveLength(1);
  });

  it('reads the stopped turn’s closing line into its run when Codex writes it while the hook waits', async () => {
    const path = writtenThrough(closing(paginated, A));
    const began = Date.now();
    const waiting = hook('Stop', path, A, { closeWaitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    appendFileSync(path, `${paginated[closing(paginated, A)]!.text}\n`);
    await waiting;
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A));
    expect(sent[0]!.end).toBe(Date.parse(paginated[closing(paginated, A)]!.record['timestamp'] as string));
  });

  it('waits on for the stopped turn’s closing line while the turn goes on, as when another plugin’s Stop hook kept it at work', async () => {
    const path = writtenThrough(closing(paginated, A));
    // The work a Stop hook that blocked asked for: calls of the same turn, before its closing line.
    const more = (i: number): string => {
      const at = (ms: number): string => new Date(Date.parse('2026-10-12T09:00:09.900Z') + i * 20 + ms).toISOString();
      return [
        { timestamp: at(0), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: `call_more_${i}` } },
        { timestamp: at(5), type: 'token_usage_record', payload: { turn_id: A, response_id: `resp_more_${i}`, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } },
        { timestamp: at(10), type: 'response_item', payload: { type: 'function_call_output', call_id: `call_more_${i}`, output: 'FAKE' } },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join('');
    };
    const waiting = hook('Stop', path, A, { closeWaitMs: 400, pollMs: 20 });
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      appendFileSync(path, more(i));
    }
    appendFileSync(path, `${paginated[closing(paginated, A)]!.text}\n`);
    await waiting;
    expect(sent.map((run) => run.runId)).toEqual(runIds(A));
    const tools = (sent[0]!.inside ?? []).flatMap((item) => (item.type === 'tool_call' ? [item.name] : []));
    expect(tools).toEqual(['exec_command', 'apply_patch', 'mcp__docs__search', 'web_search', ...Array<string>(8).fill('exec_command')]);
    expect(sent[0]!.end).toBe(Date.parse(paginated[closing(paginated, A)]!.record['timestamp'] as string));
  });

  it('gives up waiting once the named turn has been quiet for the wait, however busy the thread', async () => {
    const path = writtenThrough(opening(paginated, B) + 1);
    const began = Date.now();
    const waiting = hook('Stop', path, '01a12f99-0000-7000-8000-000000000000', { closeWaitMs: 300, pollMs: 20 });
    // Turn B's own lines keep coming, a turn the hook did not name.
    let next = opening(paginated, B) + 1;
    let done = false;
    void waiting.then(() => (done = true));
    while (!done && next < closing(paginated, B)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      appendFileSync(path, `${paginated[next++]!.text}\n`);
    }
    await waiting;
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(next).toBeLessThan(closing(paginated, B));
    expect(sent.map((run) => run.runId)).toEqual(runIds(A));
    expect(logged).toEqual(['the turn this hook named is not in its rollout; nothing of it sent']);
  });

  it('sweeps a turn that was interrupted and one an error ended at the next Stop', async () => {
    const path = writtenThrough(closing(paginated, A) + 1);
    await hook('Stop', path, A);
    writtenThrough(paginated.length);
    await hook('Stop', path, F);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
    expect(sent.map((run) => [run.cancelled, run.errorType])).toEqual([
      [undefined, undefined],
      [true, undefined],
      [undefined, 'context_window_exceeded'],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('sweeps them at the session’s end too, ending what was left open as cancelled', async () => {
    const path = writtenThrough(closing(paginated, A) + 1);
    await hook('Stop', path, A);
    writtenThrough(paginated.length);
    await hook('SessionEnd', path);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
    expect(sent.map((run) => [run.cancelled, run.errorType])).toEqual([
      [undefined, undefined],
      [true, undefined],
      [undefined, 'context_window_exceeded'],
      [undefined, undefined],
      [true, undefined],
    ]);
  });

  it('sends an interrupted turn cancelled, reading its turn_aborted as Codex writes it', async () => {
    const path = writtenThrough(closing(paginated, B));
    const waiting = hook('Interrupt', path, B, { closeWaitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    appendFileSync(path, `${paginated[closing(paginated, B)]!.text}\n`);
    await waiting;
    expect(sent.map((run) => [run.runId, run.cancelled])).toEqual([
      [runIdOf(SESSION, A), undefined],
      [runIdOf(SESSION, B), true],
    ]);
    expect(sent[1]!.end).toBe(Date.parse(paginated[closing(paginated, B)]!.record['timestamp'] as string));
  });

  it('sends the turn an Interrupt names cancelled even before its turn_aborted is written', async () => {
    await hook('Interrupt', writtenThrough(closing(paginated, B)), B);
    expect(sent.map((run) => [run.runId, run.cancelled])).toEqual([
      [runIdOf(SESSION, A), undefined],
      [runIdOf(SESSION, B), true],
    ]);
  });

  describe('a turn the next turn’s opening closed, Codex having died before its closing line', () => {
    const G = `${F.slice(0, 24)}bbbbbbbbbbbb`;
    const resumed = (): string => {
      const path = writtenThrough(paginated.length);
      appendFileSync(path, `${JSON.stringify({ timestamp: '2026-10-12T09:05:00.000Z', ordinal: 900, type: 'event_msg', payload: { type: 'task_started', turn_id: G } })}\n`);
      return path;
    };

    it('is sent as done where a Stop hook named it, its work having ended', async () => {
      await hook('Stop', resumed(), F);
      expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
      expect(sent.at(-1)!.cancelled).toBeUndefined();
      expect(logged).toEqual([]);
    });

    it('is sent cut short where no hook named it', async () => {
      await hook('Stop', resumed(), G);
      expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
      expect(sent.at(-1)!.cancelled).toBe(true);
    });
  });

  it('stops at a turn the platform did not take, and sends it again at the next hook', async () => {
    const path = writtenThrough(paginated.length);
    answers = [true, false];
    await hook('Stop', path, F);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A));
    const atB = Buffer.byteLength(paginated.slice(0, opening(paginated, B)).map(({ text }) => `${text}\n`).join(''));
    expect(readState(settings.dir, SESSION).offset).toBe(atB);
    expect(logged).toEqual([]);
    await hook('Stop', path, F);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
  });

  it('leaves what a session’s end could not send to the next hook of any session, which sends it', async () => {
    answers = [false];
    await hook('SessionEnd', writtenThrough(paginated.length));
    expect(sent).toEqual([]);
    expect(existsSync(join(settings.dir, `${SESSION}.left`))).toBe(true);
    const other = readMeta(fixture('legacy'))!.sessionId;
    const otherPath = join(dir.path, 'other.jsonl');
    writeFileSync(otherPath, readFileSync(fixture('legacy'), 'utf8'));
    await hook('Stop', otherPath, undefined, {}, { sessionId: other, threadId: other });
    const ids = sent.map((record) => record.runId);
    expect(ids).toEqual(expect.arrayContaining(runIds(A, B, C)));
    expect(sent.some((record) => record.sessionId === other)).toBe(true);
    expect(existsSync(join(settings.dir, `${SESSION}.left`))).toBe(false);
  });

  it('keeps what a session’s end left while the platform stays away', async () => {
    answers = [false];
    await hook('SessionEnd', writtenThrough(paginated.length));
    const other = readMeta(fixture('legacy'))!.sessionId;
    const otherPath = join(dir.path, 'other.jsonl');
    writeFileSync(otherPath, readFileSync(fixture('legacy'), 'utf8'));
    await hook('Stop', otherPath, undefined, { sender: () => ({ send: (record) => Promise.resolve(record.sessionId === other), close: () => Promise.resolve() }) }, { sessionId: other, threadId: other });
    expect(existsSync(join(settings.dir, `${SESSION}.left`))).toBe(true);
  });

  it('reads on from where the last hook stopped, never before it', async () => {
    const path = writtenThrough(paginated.length);
    const atE = Buffer.byteLength(paginated.slice(0, opening(paginated, E)).map(({ text }) => `${text}\n`).join(''));
    writeState(settings.dir, SESSION, { offset: atE, path, sent: [] });
    await hook('Stop', path, F);
    expect(sent.map((run) => run.runId)).toEqual(runIds(E, F));
  });

  it('reads a rollout replaced where it lies again from its start, sending none of its turns twice', async () => {
    const path = writtenThrough(paginated.length);
    await hook('SessionEnd', path);
    expect(sent).toHaveLength(5);
    // A turn after the session was resumed, in a rollout Codex rewrote whole.
    const G = `${F.slice(0, 24)}aaaaaaaaaaaa`;
    const again = paginated
      .slice(opening(paginated, F))
      .map(({ text }) => text.replaceAll(F, G).replaceAll('resp_f', 'resp_g').replaceAll('call_exec_f1', 'call_exec_g1'));
    again.push(JSON.stringify({ timestamp: '2026-10-12T09:02:00.000Z', ordinal: 999, type: 'event_msg', payload: { type: 'task_complete', turn_id: G } }));
    const replaced = join(dir.path, 'replaced.jsonl');
    writeFileSync(replaced, [...paginated.map(({ text }) => text), ...again].map((text) => `${text}\n`).join(''));
    renameSync(replaced, path);
    await hook('Stop', path, G);
    expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
  });

  describe('a rollout changed where the last hook left it', () => {
    const G = `${F.slice(0, 24)}cccccccccccc`;
    /** Turn G, after the session was resumed; `padding` bytes of output make its rollout as long as needed. */
    const turnG = (padding = 0): string =>
      [
        { timestamp: '2026-10-12T09:03:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: G } },
        { timestamp: '2026-10-12T09:03:00.005Z', type: 'turn_context', payload: { turn_id: G, model: 'gpt-5.5-codex' } },
        { timestamp: '2026-10-12T09:03:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'call_g1' } },
        { timestamp: '2026-10-12T09:03:01.050Z', type: 'token_usage_record', payload: { turn_id: G, response_id: 'resp_g1', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } },
        { timestamp: '2026-10-12T09:03:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_g1', output: `FAKE${' '.repeat(padding)}` } },
        { timestamp: '2026-10-12T09:03:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: G } },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join('');
    const sentEarlier = async (): Promise<string> => {
      const path = writtenThrough(paginated.length);
      await hook('SessionEnd', path);
      expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
      return path;
    };

    it('shrunk below that place, is read again from its start, sending none of its turns twice', async () => {
      const path = await sentEarlier();
      writeFileSync(path, `${paginated.slice(0, closing(paginated, B) + 1).map(({ text }) => `${text}\n`).join('')}${turnG()}`);
      await hook('Stop', path, G);
      expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
    });

    it('rewritten in place, its lines moved, is read again from its start, sending none of its turns twice', async () => {
      const path = await sentEarlier();
      const { ino, size } = statSync(path);
      // Its text cut shorter, and a turn after it long enough to reach past where the last hook stopped.
      const cut = paginated.map(({ text }) => `${text.replaceAll('see /home/someone/FAKE-project, mail someone@example.com, run rm -rf /home/someone/FAKE-project', 'cut')}\n`).join('');
      writeFileSync(path, `${cut}${turnG(size)}`);
      expect(statSync(path).ino).toBe(ino);
      expect(Buffer.byteLength(cut)).toBeLessThan(size);
      await hook('Stop', path, G);
      expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
    });

    it('rewritten in place past the last turn to open, its own opening where it was, is read again from its start', async () => {
      const path = await sentEarlier();
      const { size } = statSync(path);
      const atF = opening(paginated, F);
      const kept = paginated.slice(0, atF + 1).map(({ text }) => `${text}\n`).join('');
      const cut = paginated.slice(atF + 1).map(({ text }) => `${text.replaceAll('see /home/someone/FAKE-project, mail someone@example.com, run rm -rf /home/someone/FAKE-project', 'cut')}\n`).join('');
      writeFileSync(path, `${kept}${cut}${turnG(size)}`);
      // F still opens where it did: only where a line ends tells the rollout moved.
      expect(readFileSync(path).subarray(0, Buffer.byteLength(kept)).toString()).toBe(kept);
      expect(readFileSync(path)[size - 1]).not.toBe(0x0a);
      await hook('Stop', path, G);
      expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
    });

    it('rewritten in place before the last turn to open, a line still ending where the last hook stopped, is read again from its start', async () => {
      const path = await sentEarlier();
      const { size } = statSync(path);
      const cut = paginated.map(({ text }) => `${text.replaceAll('see /home/someone/FAKE-project, mail someone@example.com, run rm -rf /home/someone/FAKE-project', 'cut')}\n`).join('');
      const [startG, ...restG] = turnG().split('\n');
      // A record Codex may write one day, sized so a line ends right where the last hook stopped.
      const unknown = (pad: number): string => JSON.stringify({ timestamp: '2026-10-12T09:03:00.001Z', type: 'future_record', payload: { pad: 'x'.repeat(pad) } });
      const room = size - Buffer.byteLength(cut) - Buffer.byteLength(`${startG}\n`) - 1;
      const filler = unknown(room - Buffer.byteLength(unknown(0)));
      writeFileSync(path, `${cut}${startG}\n${filler}\n${restG.join('\n')}`);
      expect(readFileSync(path)[size - 1]).toBe(0x0a);
      await hook('Stop', path, G);
      expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
    });

    it('moved to a new file, as a revert moves a thread, is read from that file’s start, sending none of its turns twice', async () => {
      await sentEarlier();
      const moved = join(dir.path, 'rollout-moved.jsonl');
      writeFileSync(moved, `${paginated.map(({ text }) => `${text}\n`).join('')}${turnG()}`);
      await hook('Stop', moved, G);
      expect(sent.map((run) => run.runId)).toEqual([...runIds(A, B, C, E, F), runIdOf(SESSION, G)]);
    });
  });

  it('reads a long rollout in stretches, each turn once', async () => {
    const meta = paginated[0]!.text;
    const output = 'FAKE output '.repeat(10_000);
    const lines: string[] = [meta];
    const turns: string[] = [];
    for (let i = 0; i < 120; i++) {
      const at = (ms: number): string => new Date(Date.UTC(2026, 9, 12, 10) + i * 10_000 + ms).toISOString();
      const turnId = `0190a000-${(1000 + i).toString(16).padStart(4, '0')}-7000-8000-000000000000`;
      turns.push(turnId);
      lines.push(
        JSON.stringify({ timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
        JSON.stringify({ timestamp: at(5), type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-5.5-codex' } }),
        JSON.stringify({ timestamp: at(900), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: `c${i}` } }),
        JSON.stringify({ timestamp: at(950), type: 'token_usage_record', payload: { turn_id: turnId, response_id: `r${i}`, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } }),
        JSON.stringify({ timestamp: at(2000), type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output } }),
        JSON.stringify({ timestamp: at(3000), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }),
      );
    }
    const path = join(dir.path, 'rollout.jsonl');
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    expect(readFileSync(path).length).toBeGreaterThan(3 * 4 * 1024 * 1024);
    await hook('Stop', path, turns.at(-1)!);
    expect(sent.map((run) => run.runId)).toEqual(runIds(...turns));
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  }, 30_000);

  it('sends a turn of more calls than a run holds as a run of its earliest, and says how many it left out', async () => {
    const turnId = '0190a000-2000-7000-8000-000000000000';
    const at = (ms: number): string => new Date(Date.UTC(2026, 9, 12, 10) + ms).toISOString();
    const lines: string[] = [paginated[0]!.text, JSON.stringify({ timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } })];
    const asks = MAX_CALLS / 2 + 1;
    for (let i = 0; i < asks; i++) {
      lines.push(
        JSON.stringify({ timestamp: at(10 * i + 1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: `c${i}` } }),
        JSON.stringify({ timestamp: at(10 * i + 5), type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output: 'FAKE' } }),
      );
    }
    lines.push(JSON.stringify({ timestamp: at(10 * asks), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }));
    const path = join(dir.path, 'rollout.jsonl');
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    await hook('Stop', path, turnId);
    expect(sent.map((run) => [run.runId, run.inside?.length])).toEqual([[runIdOf(SESSION, turnId), MAX_CALLS]]);
    expect(logged).toEqual([`turn too long: 2 of its ${MAX_CALLS + 2} calls, the latest, not sent`]);
  }, 30_000);

  it('sends nothing without a key, and says so once', async () => {
    const path = writtenThrough(paginated.length);
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    await hook('Stop', path, F);
    expect(sent).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^no key/);
  });

  it('logs a missing key only under the thread’s lock, so no hook’s save is written over', async () => {
    const path = writtenThrough(paginated.length);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    settings.apiKey = undefined;
    await hook('Stop', path, F, { lockWaitMs: 10 });
    expect(logged).toEqual([]);
    release();
    await holder;
    await hook('Stop', path, F);
    expect(logged).toEqual([expect.stringMatching(/^no key/) as unknown]);
  });

  it('waits on no lock to say again what it said already', async () => {
    const path = writtenThrough(paginated.length);
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    await hook('Stop', path, F, { lockWaitMs: 60_000 });
    release();
    await holder;
    expect(logged).toEqual([expect.stringMatching(/^no key/) as unknown]);
  });

  it('sends nothing past a key file it passed over, and says why once', async () => {
    // The file may have named a self-hosted endpoint: its key must not go to the default instead.
    settings.apiKey = undefined;
    settings.keyFileProblem = 'open to other users; chmod 600 it';
    settings.keyFileName = '$CODEX_HOME/telmoni.json';
    await hook('Stop', writtenThrough(paginated.length), F);
    await hook('Stop', writtenThrough(paginated.length), F);
    expect(sent).toEqual([]);
    expect(logged).toEqual(['$CODEX_HOME/telmoni.json not used (open to other users; chmod 600 it): fix it, or set TELMONI_API_KEY, with TELMONI_ENDPOINT for a Telmoni of your own; nothing is sent until then']);
  });

  it('says each reason once a thread, though turns are sent and saved between', async () => {
    const path = writtenThrough(paginated.length);
    const problem = 'open to other users; chmod 600 it';
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    settings.keyFileProblem = problem;
    await hook('Stop', path, F);
    delete settings.keyFileProblem;
    settings.apiKey = 'tm_test';
    await hook('Stop', path, F);
    expect(sent.length).toBeGreaterThan(0);
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    settings.keyFileProblem = problem;
    await hook('Stop', path, F);
    expect(logged).toEqual([expect.stringMatching(/^no key/) as unknown, expect.stringMatching(/ not used \(/) as unknown]);
  });

  it('says once each why nothing is sent: no key, then a key file passed over', async () => {
    const path = writtenThrough(paginated.length);
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    settings.keyFileProblem = 'open to other users; chmod 600 it';
    await hook('Stop', path, F);
    await hook('Stop', path, F);
    expect(sent).toEqual([]);
    expect(logged).toEqual([expect.stringMatching(/^no key/) as unknown, expect.stringMatching(/^~\/\.codex\/telmoni\.json not used \(open to other users/) as unknown]);
  });

  it('says so where the turn a hook names never shows in its rollout, sending the turns that did end', async () => {
    await hook('Stop', writtenThrough(paginated.length), '01a12f99-0000-7000-8000-000000000000');
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E));
    expect(logged).toEqual(['the turn this hook named is not in its rollout; nothing of it sent']);
  });

  it('says why it read nothing where the rollout is gone or another thread’s, but not of a session that ended with it', async () => {
    await hook('Stop', join(dir.path, 'missing.jsonl'), A);
    await hook('SessionEnd', join(dir.path, 'missing.jsonl'));
    await hook('Stop', fixture('legacy'), A);
    expect(sent).toEqual([]);
    expect(logged).toEqual(['rollout not read: Error:ENOENT', 'rollout not read: its first line names no thread of this hook']);
  });
});

describe('a subagent', () => {
  const subagent = fixtureLines('subagent');
  const meta = readMeta(fixture('subagent'))!;
  const own = subagent.flatMap(({ record }) => (payloadOf(record)['type'] === 'task_started' ? [payloadOf(record)['turn_id'] as string] : [])).at(-1)!;
  const input = { sessionId: meta.sessionId, threadId: meta.threadId };

  it('has its own turns sent under the session, never its parent’s it began with', async () => {
    const path = writtenThrough(subagent.length, subagent);
    await hook('SubagentStop', path, own, {}, input);
    expect(sent.map((run) => [run.runId, run.sessionId])).toEqual([[runIdOf(meta.sessionId, own), meta.sessionId]]);
    expect(existsSync(join(settings.dir, `${stateName(meta.sessionId, meta.threadId)}.json`))).toBe(true);
    expect(stateName(meta.sessionId, meta.threadId)).toBe(`${meta.sessionId}.${meta.threadId}`);
  });

  it('has a turn it left open ended with the session', async () => {
    const path = writtenThrough(subagent.length, subagent);
    await hook('SubagentStop', path, own, {}, input);
    const next = '01a12f60-0000-7000-8000-00000000abcd';
    const at = (ms: number): string => new Date(Date.UTC(2026, 9, 12, 9, 30) + ms).toISOString();
    appendFileSync(
      path,
      [
        { timestamp: at(0), ordinal: 100, type: 'event_msg', payload: { type: 'task_started', turn_id: next } },
        { timestamp: at(10), ordinal: 101, type: 'turn_context', payload: { turn_id: next, model: 'gpt-5.5-codex-mini' } },
        { timestamp: at(900), ordinal: 102, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'call_next' } },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(''),
    );
    // The session's own rollout, which ends with no turn left open.
    const root = join(dir.path, 'root.jsonl');
    writeFileSync(root, `${JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: meta.sessionId, timestamp: at(0) } })}\n`);
    await hook('SessionEnd', root, undefined, {}, { sessionId: meta.sessionId, threadId: meta.sessionId });
    expect(sent.map((run) => [run.runId, run.cancelled])).toEqual([
      [runIdOf(meta.sessionId, own), undefined],
      [runIdOf(meta.sessionId, next), true],
    ]);
  });

  it('stopped before there was a key, has its turns sent at the session’s end once there is one', async () => {
    const path = writtenThrough(subagent.length, subagent);
    settings.apiKey = undefined;
    await hook('SubagentStop', path, own, {}, input);
    expect(sent).toEqual([]);
    settings.apiKey = 'tm_test';
    const root = join(dir.path, 'root.jsonl');
    writeFileSync(root, `${JSON.stringify({ timestamp: new Date(0).toISOString(), type: 'session_meta', payload: { id: meta.sessionId, timestamp: new Date(0).toISOString() } })}\n`);
    await hook('SessionEnd', root, undefined, {}, { sessionId: meta.sessionId, threadId: meta.sessionId });
    expect(sent.map((run) => run.runId)).toEqual([runIdOf(meta.sessionId, own)]);
  });
});

describe('a subagent whose state cannot be read', () => {
  it('is passed over at the session’s end, logged, and holds up neither the session’s turns nor another subagent’s', async () => {
    const subagent = fixtureLines('subagent');
    const meta = readMeta(fixture('subagent'))!;
    const own = subagent.flatMap(({ record }) => (payloadOf(record)['type'] === 'task_started' ? [payloadOf(record)['turn_id'] as string] : [])).at(-1)!;
    const path = writtenThrough(subagent.length, subagent);
    mkdirSync(settings.dir, { recursive: true });
    // Sorted before the subagent whose turn is still to send: a sweep that stopped at it would send nothing.
    writeFileSync(join(settings.dir, `${meta.sessionId}.000torn.json`), '{"offset":');
    writeState(settings.dir, stateName(meta.sessionId, meta.threadId), { offset: 0, path });
    const root = join(dir.path, 'root.jsonl');
    writeFileSync(root, `${JSON.stringify({ timestamp: new Date(0).toISOString(), type: 'session_meta', payload: { id: meta.sessionId, timestamp: new Date(0).toISOString() } })}\n`);
    await hook('SessionEnd', root, undefined, {}, { sessionId: meta.sessionId, threadId: meta.sessionId });
    expect(logged).toEqual(['subagent 000torn: state not read: SyntaxError']);
    expect(sent.map((run) => run.runId)).toEqual([runIdOf(meta.sessionId, own)]);
  });
});

describe('a fork', () => {
  it('has its own turns sent, never the ones it copied from its source', async () => {
    const fork = fixtureLines('fork-legacy');
    const meta = readMeta(fixture('fork-legacy'))!;
    const own = fork.flatMap(({ record }) => (payloadOf(record)['type'] === 'task_started' ? [payloadOf(record)['turn_id'] as string] : [])).at(-1)!;
    const path = writtenThrough(fork.length, fork);
    await hook('Stop', path, own, {}, { sessionId: meta.sessionId, threadId: meta.threadId });
    expect(sent.map((run) => run.runId)).toEqual([runIdOf(meta.sessionId, own)]);
  });
});

describe('a turn sent again', () => {
  let ingest: FakeIngest;
  let real: Partial<Deps>;

  beforeEach(async () => {
    ingest = new FakeIngest();
    settings.endpoint = await ingest.start();
    real = { sender: (destination) => new Sender(destination, (line) => void logged.push(line)) };
  });

  afterEach(async () => {
    await ingest.stop();
  });

  const bodies = (from = 0): string[] => ingest.received.slice(from).map((request) => request.body);

  it('after a hook died between sending it and saving that it had, is the same bytes', async () => {
    const path = writtenThrough(paginated.length);
    await hook('SessionEnd', path, undefined, real);
    const first = bodies();
    expect(first).toHaveLength(5);
    // As though the state had never been saved.
    rmSync(join(settings.dir, `${SESSION}.json`));
    await hook('SessionEnd', path, undefined, real);
    expect(bodies(first.length)).toEqual(first);
  });

  it('after Telmoni refused it, then answered again, is the same bytes, and the turns after it follow', async () => {
    const path = writtenThrough(paginated.length);
    ingest.answers.push({ status: 401 });
    await hook('SessionEnd', path, undefined, real);
    expect(bodies()).toHaveLength(1);
    expect(logged).toEqual([expect.stringMatching(/^not sent: telmoni: export refused with 401 /) as unknown]);
    await hook('SessionEnd', path, undefined, real);
    const [tried, ...after] = bodies();
    expect(after).toHaveLength(5);
    expect(after[0]).toBe(tried);
  });

  it('after Telmoni could not be reached, is sent once it can be, as the bytes it tried', async () => {
    const path = writtenThrough(paginated.length);
    const reachable = settings.endpoint;
    // Nothing listens on the discard port: every attempt the SDK makes is refused a connection.
    settings.endpoint = 'http://127.0.0.1:9';
    await hook('SessionEnd', path, undefined, real);
    expect(logged).toEqual([expect.stringMatching(/^not sent: telmoni: export failed after 3 attempts/) as unknown]);
    expect(readState(settings.dir, SESSION).offset).toBe(Buffer.byteLength(`${paginated[0]!.text}\n`));
    settings.endpoint = reachable;
    await hook('SessionEnd', path, undefined, real);
    expect(bodies().map((body) => (JSON.parse(body) as { resourceSpans: unknown[] }).resourceSpans.length)).toHaveLength(5);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  }, 30_000);

  it('after the SDK refused its endpoint, is sent once the endpoint is one it takes, the refusal logged once in its words', async () => {
    const path = writtenThrough(paginated.length);
    const reachable = settings.endpoint;
    // Plain HTTP to another machine would carry the key in the clear.
    settings.endpoint = 'http://telmoni.example';
    await hook('SessionEnd', path, undefined, real);
    await hook('SessionEnd', path, undefined, real);
    expect(logged).toEqual([
      "endpoint refused by the SDK (refusing to send the API key over unencrypted HTTP to 'telmoni.example'; use HTTPS): put another in ~/.codex/telmoni.json, or TELMONI_ENDPOINT; nothing is sent until then",
    ]);
    expect(readState(settings.dir, SESSION).offset).toBe(0);
    settings.endpoint = reachable;
    await hook('SessionEnd', path, undefined, real);
    expect(bodies()).toHaveLength(5);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });
});

describe('what a hook keeps', () => {
  it('is metadata alone, readable by the person alone: ids, offsets, the rollout it reads, a model', async () => {
    const path = writtenThrough(paginated.length);
    await hook('Stop', path, F);
    settings.apiKey = undefined;
    await hook('Stop', path, F);
    settings.keyFileProblem = 'open to other users; chmod 600 it';
    await hook('Stop', path, F);
    delete settings.keyFileProblem;
    settings.apiKey = 'tm_test';
    settings.endpoint = 'http://telmoni.example';
    await hook('Stop', path, F, { sender: (destination) => new Sender(destination, (line) => void logged.push(line)) });
    const files = readdirSync(settings.dir);
    expect(files.sort()).toEqual([`${SESSION}.json`]);
    const kept = readFileSync(join(settings.dir, `${SESSION}.json`), 'utf8');
    const allowed = ['countKey', 'ino', 'model', 'offset', 'opening', 'path', 'sent', 'warnedEndpoint', 'warnedKeyFile', 'warnedNoKey'];
    expect(Object.keys(JSON.parse(kept) as object).filter((key) => !allowed.includes(key))).toEqual([]);
    expect(JSON.parse(kept)).toMatchObject({ warnedEndpoint: true, warnedKeyFile: true, warnedNoKey: true });
    for (const text of [...CONTENT, 'telmoni.example']) expect(kept).not.toContain(text);
    if (process.platform !== 'win32') {
      expect(statSync(settings.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(settings.dir, `${SESSION}.json`)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('the state', () => {
  it('starts afresh only where none was saved, and throws on one it cannot read rather than send the thread again', () => {
    expect(readState(settings.dir, SESSION)).toEqual({ offset: 0 });
    mkdirSync(settings.dir, { recursive: true });
    for (const unreadable of ['{"offset":', '', 'null', '[]']) {
      writeFileSync(join(settings.dir, `${SESSION}.json`), unreadable);
      expect(() => readState(settings.dir, SESSION)).toThrow();
    }
  });

  it('keeps the newest sent turns, and only so many', () => {
    writeState(settings.dir, SESSION, { offset: 0, sent: Array.from({ length: 5_005 }, (_, index) => `turn-${index}`) });
    const { sent: kept } = readState(settings.dir, SESSION);
    expect(kept).toHaveLength(5_000);
    expect([kept![0], kept!.at(-1)]).toEqual(['turn-5', 'turn-5004']);
  });

  it('is written through a file named for its own process, leaving any other writer’s alone', () => {
    mkdirSync(settings.dir, { recursive: true });
    const others = [`${SESSION}.json.tmp`, `${SESSION}.json.${process.pid + 1}.tmp`].map((name) => join(settings.dir, name));
    for (const other of others) writeFileSync(other, 'theirs');
    writeState(settings.dir, SESSION, { offset: 7 });
    expect(others.map((other) => readFileSync(other, 'utf8'))).toEqual(['theirs', 'theirs']);
    expect(readState(settings.dir, SESSION)).toEqual({ offset: 7 });
  });

  it('names a session’s subagents by their own states alone, never a lock, a temporary file or another name', () => {
    mkdirSync(settings.dir, { recursive: true });
    for (const name of [`${SESSION}.json`, `${SESSION}.agent_1.json`, `${SESSION}.agent_1.lock`, `${SESSION}.agent_2.json.4242.tmp`, `${SESSION}.a.b.json`, 'other.agent_3.json']) {
      writeFileSync(join(settings.dir, name), '{}');
    }
    expect(subagentsOf(settings.dir, SESSION)).toEqual(['agent_1']);
  });

  it('that cannot be read stops the hook, left as it is and its lock let go, the turns waiting until it is gone', async () => {
    const path = writtenThrough(paginated.length);
    mkdirSync(settings.dir, { recursive: true });
    writeFileSync(join(settings.dir, `${SESSION}.json`), '{"offset":');
    await expect(hook('Stop', path, F)).rejects.toThrow(SyntaxError);
    expect(sent).toEqual([]);
    expect(readFileSync(join(settings.dir, `${SESSION}.json`), 'utf8')).toBe('{"offset":');
    rmSync(join(settings.dir, `${SESSION}.json`));
    await hook('Stop', path, F);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
  });
});

describe('two hooks of a thread at once', () => {
  it('send each turn once between them', async () => {
    const path = writtenThrough(paginated.length);
    const slow: Partial<Deps> = {
      sender: () => ({
        send: async (record) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          sent.push(record);
          return true;
        },
        close: () => Promise.resolve(),
      }),
    };
    await Promise.all([hook('Stop', path, F, slow), hook('SessionEnd', path, undefined, slow), hook('Stop', path, F, slow)]);
    expect(sent.map((run) => run.runId).sort()).toEqual(runIds(A, B, C, E, F).sort());
    expect(logged).toEqual([]);
  });
});

describe('the lock', () => {
  it('is given up past its wait at a stop, which a later hook follows, and outwaited at the session’s end', async () => {
    const path = writtenThrough(paginated.length);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    let ended = false;
    const ending = hook('SessionEnd', path, undefined, { lockWaitMs: 10 }).then(() => {
      ended = true;
    });
    await hook('Stop', path, F, { lockWaitMs: 10 });
    expect(logged).toEqual(['busy: another hook of this thread held its lock past the wait; the next hook sends']);
    // The stop gave up after the session's end began to wait, and that waits on.
    expect(ended).toBe(false);
    release();
    await Promise.all([holder, ending]);
    expect(sent.map((run) => run.runId)).toEqual(runIds(A, B, C, E, F));
    expect(logged).toHaveLength(1);
  });

  it('lets one hook of a thread work at a time, and is free once it is done', async () => {
    const lockDir = join(dir.path, 'locks');
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withLock(lockDir, SESSION, 1000, async () => {
      order.push('first in');
      await held;
      order.push('first out');
    });
    const second = withLock(lockDir, SESSION, 5000, async () => void order.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(['first in', 'first out', 'second']);
    expect(existsSync(join(lockDir, `${SESSION}.lock`))).toBe(false);
  });

  it('gives up past its wait while another holds it', async () => {
    const lockDir = join(dir.path, 'locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `${SESSION}.lock`), '');
    expect(await withLock(lockDir, SESSION, 300, async () => undefined)).toBe(false);
  });

  it('is taken from a hook that died, once a minute untouched', async () => {
    const lockDir = join(dir.path, 'locks');
    const lock = join(lockDir, `${SESSION}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lock, 'a hook that died');
    const untouched = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, untouched, untouched);
    expect(await withLock(lockDir, SESSION, 1000, async () => undefined)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('is never taken for a dead hook’s while its hook works on past the time that takes', async () => {
    const lockDir = join(dir.path, 'locks');
    const order: string[] = [];
    const staleMs = 1_000;
    const first = withLock(
      lockDir,
      SESSION,
      1000,
      async () => {
        order.push('first in');
        await new Promise((resolve) => setTimeout(resolve, staleMs * 3));
        order.push('first out');
      },
      staleMs,
    );
    // Taken as `withLock` was called, before its first wait.
    expect(order).toEqual(['first in']);
    const second = withLock(lockDir, SESSION, staleMs * 6, async () => void order.push('second'), staleMs);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });

  it('leaves in place a lock another hook took from it', async () => {
    const lockDir = join(dir.path, 'locks');
    const lock = join(lockDir, `${SESSION}.lock`);
    await withLock(lockDir, SESSION, 1000, async () => {
      // Another hook, finding this one's lock stale, took it.
      writeFileSync(lock, 'another hook');
    });
    expect(readFileSync(lock, 'utf8')).toBe('another hook');
  });
});
