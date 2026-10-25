import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Telmoni } from 'telmoni';
import type { ModelCallRecord, RunRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import { AGENT, type Ending, MAX_CALLS, hasWork, recordOf, runIdOf, uuid5 } from '../src/record';
import { type Event, type Line, type Meta, Reader, type Usage, readMeta } from '../src/rollout';
import { type Turn, Turns, mintedAt } from '../src/turns';
import { CONTENT, fixture, fixtureLines, payloadOf, tempDir } from './helpers';

/** A rollout's turns, read whole: those it closed, and the one left open. */
function turnsAt(path: string, target?: string): { meta: Meta; closed: Turn[]; open: Turn | undefined } {
  const meta = readMeta(path)!;
  const turns = new Turns(meta, new Set(), target, { offset: 0, countKey: undefined, model: undefined });
  const closed: Turn[] = [];
  const reader = new Reader(path, 0);
  try {
    for (let lines = reader.read(); lines !== undefined; lines = reader.read()) {
      for (const line of lines) closed.push(...turns.push(line));
    }
  } finally {
    reader.close();
  }
  return { meta, closed, open: turns.open };
}

const turnsOf = (name: string, target?: string): ReturnType<typeof turnsAt> => turnsAt(fixture(name), target);

/** A rollout's runs, as hooks would send them: each closed turn with work, and the open one where `ending` says why. */
function runsAt(path: string, options: { target?: string; ending?: Ending } = {}): RunRecord[] {
  const { meta, closed, open } = turnsAt(path, options.target);
  const context = { sessionId: meta.sessionId, provider: meta.provider, model: undefined };
  const runs = closed.filter(hasWork).map((turn) => recordOf(turn, context)!);
  if (open !== undefined && hasWork(open) && options.ending !== undefined) runs.push(recordOf(open, context, options.ending)!);
  return runs;
}

const runsOf = (name: string, options: { target?: string; ending?: Ending } = {}): RunRecord[] => runsAt(fixture(name), options);

/** A fixture's turn ids in the order they open, read independently of the plugin. */
function turnIds(name: string): string[] {
  return fixtureLines(name).flatMap(({ record }) => {
    const payload = payloadOf(record);
    return record['type'] === 'event_msg' && payload['type'] === 'task_started' ? [payload['turn_id'] as string] : [];
  });
}

const modelCalls = (run: RunRecord): ModelCallRecord[] =>
  (run.inside ?? []).filter((item): item is ModelCallRecord => item.type === 'model_call');
const toolCalls = (run: RunRecord): ToolCallRecord[] =>
  (run.inside ?? []).filter((item): item is ToolCallRecord => item.type === 'tool_call');

const at = (seconds: number): number => Date.UTC(2026, 9, 12, 9, 0, 0) + seconds * 1000;

describe('a turn as a run', () => {
  const [A, B, C, , E, F] = turnIds('paginated') as [string, string, string, string, string, string];
  const session = readMeta(fixture('paginated'))!.sessionId;

  it('is a run of codex in the session, its id the same every time it is read', () => {
    const runs = runsOf('paginated', { target: F, ending: 'stopped' });
    expect(runs.map((run) => run.runId)).toEqual([A, B, C, E, F].map((turn) => runIdOf(session, turn)));
    for (const run of runs) {
      expect(run.agent).toBe(AGENT);
      expect(run.sessionId).toBe(session);
      expect(run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Number(run.end)).toBeGreaterThanOrEqual(Number(run.start));
      for (const item of run.inside ?? []) {
        expect(Number(item.end)).toBeGreaterThanOrEqual(Number(item.start));
        expect(Number(item.end)).toBeLessThanOrEqual(Number(run.end));
      }
    }
    expect(runsOf('paginated', { target: F, ending: 'stopped' })).toEqual(runs);
  });

  it('is final at its Stop as it stands, its task_complete not yet written', () => {
    const { open } = turnsOf('paginated', F);
    expect(open?.id).toBe(F);
    expect(open?.closing).toBeUndefined();
    const run = runsOf('paginated', { target: F, ending: 'stopped' }).at(-1)!;
    expect(run.runId).toBe(runIdOf(session, F));
    expect(run.cancelled).toBeUndefined();
    expect(run.errorType).toBeUndefined();
    expect(modelCalls(run).map((call) => call.usage?.inputTokens)).toEqual([9000, 9200]);
    expect(toolCalls(run).map((tool) => [tool.name, tool.errorType, tool.cancelled])).toEqual([['exec_command', undefined, undefined]]);
  });

  it('has a model call per response, its tokens Codex’s record of it and never the running total besides', () => {
    const recorded = fixtureLines('paginated').flatMap(({ record }) => {
      const usage = payloadOf(record)['usage'] as Record<string, number> | undefined;
      return record['type'] === 'token_usage_record' && usage !== undefined ? [usage] : [];
    });
    const calls = runsOf('paginated', { target: F, ending: 'stopped' }).flatMap(modelCalls).filter((call) => call.usage);
    // OpenAI counts the cache's reads and writes inside the input, and reasoning inside the output, as the SDK does.
    expect(calls.map((call) => call.usage)).toEqual(
      recorded.map((usage) => ({
        inputTokens: usage['input_tokens'],
        outputTokens: usage['output_tokens'],
        cacheReadInputTokens: usage['cached_input_tokens'],
        cacheWriteInputTokens: usage['cache_write_input_tokens'],
      })),
    );
    for (const call of calls) {
      expect(call.model).toBe('gpt-5.5-codex');
      expect(call.provider).toBe('openai');
    }
  });

  it('counts a legacy rollout’s tokens from its running total, each response once', () => {
    // Read independently: each total that is new and whose last share reads true.
    let previous = '';
    const shares: Array<Record<string, number>> = [];
    for (const { record } of fixtureLines('legacy')) {
      const payload = payloadOf(record);
      if (payload['type'] !== 'token_count' || payload['info'] === null) continue;
      const info = payload['info'] as Record<string, Record<string, number>>;
      const key = JSON.stringify(info);
      const last = info['last_token_usage']!;
      if (key !== previous && last['input_tokens']! + last['output_tokens']! > 0) shares.push(last);
      previous = key;
    }
    expect(shares).toHaveLength(6);
    const calls = runsOf('legacy').flatMap(modelCalls).filter((call) => call.usage);
    expect(calls.map((call) => [call.usage!.inputTokens, call.usage!.cacheReadInputTokens, call.usage!.outputTokens])).toEqual(
      shares.map((share) => [share['input_tokens'], share['cached_input_tokens'], share['output_tokens']]),
    );
    expect(calls.every((call) => call.usage!.cacheWriteInputTokens === 0 && call.model === 'gpt-5.3-codex')).toBe(true);
  });

  it('marks a tool failed or declined where Codex says so, and never reads its output for it', () => {
    const [completed] = runsOf('paginated');
    expect(toolCalls(completed!).map((tool) => [tool.name, tool.errorType, tool.cancelled])).toEqual([
      ['exec_command', 'ToolError', undefined],
      ['apply_patch', undefined, true],
      ['mcp__docs__search', 'ToolError', undefined],
      ['web_search', undefined, undefined],
    ]);
    // A legacy rollout keeps a command's exit code only in its output's text, never read: the command that exited 1 is not marked failed.
    const [legacy] = runsOf('legacy');
    expect(toolCalls(legacy!).map((tool) => [tool.name, tool.errorType])).toEqual([
      ['shell', undefined],
      ['mcp__docs__search', 'ToolError'],
      ['apply_patch', 'ToolError'],
    ]);
  });

  it('times a tool from when Codex started it to when it finished, and a response from its request to its record', () => {
    const [completed] = runsOf('paginated');
    const exec = toolCalls(completed!)[0]!;
    expect([exec.start, exec.end]).toEqual([at(1) + 2450, at(1) + 3700]);
    const [first] = modelCalls(completed!);
    // Asked as the rate-limit refresh before it was written, done as its record was.
    expect([first!.start, first!.end]).toEqual([at(1) + 20, at(1) + 2450]);
  });

  it('marks an interrupted turn cancelled, and one an error ended failed, by the error’s kind', () => {
    const [, interrupted, failed] = runsOf('paginated');
    expect(interrupted!.cancelled).toBe(true);
    expect(toolCalls(interrupted!).map((tool) => tool.cancelled)).toEqual([true]);
    expect(failed!.errorType).toBe('context_window_exceeded');
    expect(modelCalls(failed!).map((call) => [call.errorType, call.usage])).toEqual([['context_window_exceeded', undefined]]);
    const [, , cancelled] = runsOf('legacy');
    expect(cancelled!.cancelled).toBe(true);
    expect(modelCalls(cancelled!).map((call) => call.cancelled)).toEqual([true]);
    expect(toolCalls(cancelled!).map((tool) => tool.cancelled)).toEqual([true]);
  });

  it('makes no run of a command the person ran, and one of a compaction, its call its tokens', () => {
    const runs = runsOf('paginated');
    expect(runs).toHaveLength(4);
    const compaction = runs.at(-1)!;
    expect(compaction.runId).toBe(runIdOf(session, E));
    expect(modelCalls(compaction).map((call) => [call.model, call.usage?.inputTokens])).toEqual([['gpt-5.5-codex', 60000]]);
    const [, legacyCompaction] = runsOf('legacy');
    expect(modelCalls(legacyCompaction!).map((call) => call.usage?.inputTokens)).toEqual([30000]);
  });

  it('never makes runs of the turns a fork or a subagent copied from its source', () => {
    const fork = runsOf('fork-legacy');
    expect(fork.map((run) => run.runId)).toEqual([runIdOf(readMeta(fixture('fork-legacy'))!.sessionId, turnIds('fork-legacy').at(-1)!)]);
    expect(modelCalls(fork[0]!).map((call) => call.usage?.inputTokens)).toEqual([6000, 6200]);
    const subagent = readMeta(fixture('subagent'))!;
    const [spawned, ...others] = runsOf('subagent');
    expect(others).toEqual([]);
    expect(spawned!.sessionId).toBe(subagent.sessionId);
    expect(spawned!.runId).toBe(runIdOf(subagent.sessionId, turnIds('subagent').at(-1)!));
    expect(modelCalls(spawned!).map((call) => call.model)).toEqual(['gpt-5.5-codex-mini', 'gpt-5.5-codex-mini']);
    expect(runsOf('fork-paginated').map((run) => run.runId)).toEqual([
      runIdOf(readMeta(fixture('fork-paginated'))!.sessionId, turnIds('fork-paginated').at(-1)!),
    ]);
  });

  it('carries nothing of what was said: no text, no command, no path', () => {
    const records = JSON.stringify([
      ...runsOf('paginated', { target: F, ending: 'stopped' }),
      ...runsOf('legacy'),
      ...runsOf('fork-legacy'),
      ...runsOf('subagent'),
      ...runsOf('fork-paginated'),
    ]);
    for (const text of CONTENT) expect(records).not.toContain(text);
    expect(records).not.toContain('/');
    const keys = new Set<string>();
    JSON.parse(records, (key, value: unknown) => {
      if (key !== '' && Number.isNaN(Number(key))) keys.add(key);
      return value;
    });
    expect([...keys].sort()).toEqual(
      [
        'agent',
        'cacheReadInputTokens',
        'cacheWriteInputTokens',
        'cancelled',
        'end',
        'errorType',
        'inputTokens',
        'inside',
        'model',
        'name',
        'outputTokens',
        'provider',
        'runId',
        'sessionId',
        'start',
        'type',
        'usage',
      ].sort(),
    );
  });
});

describe('a rollout with records and fields the plugin does not know', () => {
  it('makes the same runs as without them, keeping nothing of them', () => {
    const dir = tempDir();
    try {
      const future = 'FAKE future: see /home/someone/FAKE-project';
      const known = fixtureLines('paginated');
      const lines = known.flatMap(({ record }, index) => {
        // A field Codex may add to any record, its item or its usage, with text in it.
        const payload: Record<string, unknown> = { ...payloadOf(record), future_field: future };
        if (typeof payload['item'] === 'object') payload['item'] = { ...(payload['item'] as object), future_field: future };
        if (typeof payload['usage'] === 'object') payload['usage'] = { ...(payload['usage'] as object), future_tokens: 7 };
        const at = record['timestamp'];
        const added: Array<Record<string, unknown>> = [{ ...record, payload }];
        // Records Codex may add, written as the line before them was, so no time in the turn moves.
        if (index > 0) {
          added.push(
            { timestamp: at, type: 'future_record', payload: { text: future, turn_id: 'future' } },
            { timestamp: at, type: 'event_msg', payload: { type: 'future_event', message: future } },
            { timestamp: at, type: 'response_item', payload: { type: 'future_item', content: future, call_id: 'call_future' } },
          );
        }
        return added.map((line) => JSON.stringify(line));
      });
      lines.splice(5, 0, '[1, 2]', JSON.stringify(future), 'null');
      const path = join(dir.path, 'rollout.jsonl');
      writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
      const F = turnIds('paginated').at(-1)!;
      expect(runsAt(path, { target: F, ending: 'stopped' })).toEqual(runsOf('paginated', { target: F, ending: 'stopped' }));
      const reader = new Reader(path, 0);
      const kept: unknown[] = [];
      try {
        for (let read = reader.read(); read !== undefined; read = reader.read()) kept.push(...read);
      } finally {
        reader.close();
      }
      expect(JSON.stringify(kept)).not.toMatch(/FAKE|future/);
    } finally {
      dir.remove();
    }
  });
});

describe('a turn’s owner', () => {
  const meta = (fields: Partial<Meta>): Meta => ({
    threadId: 't',
    sessionId: 't',
    created: at(100),
    derived: false,
    ownFrom: undefined,
    provider: undefined,
    ...fields,
  });
  let place = 0;
  const line = (event: Event, ordinal?: number): Line => ({ start: place, end: ++place, time: at(100) + place, ordinal, event });
  const turn = (turnId: string, ordinal?: number): Line[] => [
    line({ kind: 'start', turnId }, ordinal),
    line({ kind: 'output' }, ordinal === undefined ? undefined : ordinal + 1),
    line({ kind: 'complete', turnId, errorType: undefined }, ordinal === undefined ? undefined : ordinal + 2),
  ];
  const owned = (turns: Turns, lines: Line[]): string[] => lines.flatMap((each) => turns.push(each)).map((each) => each.id);
  const v7At = (ms: number): string => {
    const hex = ms.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
  };
  const from = { offset: 0, countKey: undefined, model: undefined };

  it('is a paginated subagent’s from its own history’s first ordinal, whatever its turns’ ids say', () => {
    const turns = new Turns(meta({ ownFrom: 3 }), new Set(), undefined, from);
    expect(owned(turns, [...turn(v7At(at(200)), 0), ...turn(v7At(at(201)), 3)])).toEqual([v7At(at(201))]);
  });

  it('is the thread’s unless the thread began from another and the turn’s id was minted before it', () => {
    const old = v7At(at(50));
    const young = v7At(at(150));
    expect(mintedAt(old)).toBe(at(50));
    expect(owned(new Turns(meta({ derived: true }), new Set(), undefined, from), [...turn(old), ...turn(young), ...turn('turn-1')])).toEqual([
      young,
      'turn-1',
    ]);
    expect(owned(new Turns(meta({}), new Set(), undefined, from), [...turn(old), ...turn(young)])).toEqual([old, young]);
    // The turn a hook names is the thread's own, whatever its id says.
    expect(owned(new Turns(meta({ derived: true }), new Set(), old, from), turn(old))).toEqual([old]);
    // One already sent is not sent again.
    expect(owned(new Turns(meta({}), new Set([young]), undefined, from), turn(young))).toEqual([]);
  });
});

describe('a turn’s closing', () => {
  it('closes only the turn it names: one for a turn closed already leaves the open one running', () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'openai' };
    let place = 0;
    const line = (event: Event): Line => ({ start: place, end: ++place, time: at(1) + place, ordinal: undefined, event });
    const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model: 'gpt-5.5-codex' });
    const closed = [
      line({ kind: 'start', turnId: 'first' }),
      line({ kind: 'output' }),
      // The next turn opens before the first's interruption is written.
      line({ kind: 'start', turnId: 'next' }),
      line({ kind: 'aborted', turnId: 'first', reason: 'interrupted', errorType: undefined }),
      line({ kind: 'output' }),
      line({ kind: 'complete', turnId: 'next', errorType: undefined }),
    ].flatMap((each) => turns.push(each));
    expect(closed.map((turn) => [turn.id, turn.closing?.aborted, turn.responses.length])).toEqual([
      ['first', undefined, 1],
      ['next', false, 1],
    ]);
  });
});

describe('a response’s tokens', () => {
  it('are Codex’s record of it where it wrote one, and its share of the running total only where it wrote none', () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'openai' };
    const usage = (input: number): Usage => ({ input, cached: 0, cacheWrite: 0, output: 10 });
    let place = 0;
    const line = (event: Event): Line => ({ start: place, end: ++place, time: at(1) + place, ordinal: undefined, event });
    const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model: 'gpt-5.5-codex' });
    const closed = [
      line({ kind: 'start', turnId: 'turn' }),
      line({ kind: 'call', callId: 'c1', name: 'exec_command', inPlace: false, outcome: undefined }),
      line({ kind: 'usage', turnId: 'turn', responseId: 'r1', usage: usage(100) }),
      line({ kind: 'result', callId: 'c1' }),
      // The running total's share of the same response, which its record already counts.
      line({ kind: 'count', key: 'k1', usage: usage(999) }),
      line({ kind: 'output' }),
      // A response Codex wrote no record for: its share is all there is.
      line({ kind: 'count', key: 'k2', usage: usage(50) }),
      line({ kind: 'complete', turnId: 'turn', errorType: undefined }),
    ].flatMap((each) => turns.push(each));
    const run = recordOf(closed[0]!, { sessionId: 's', provider: 'openai', model: undefined })!;
    expect(modelCalls(run).map((call) => [call.model, call.usage?.inputTokens])).toEqual([
      ['gpt-5.5-codex', 100],
      ['gpt-5.5-codex', 50],
    ]);
  });
});

describe('a turn whose clock was set back while it ran', () => {
  it('is a run that holds every call, none ending before it starts, as the SDK takes it', async () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'openai' };
    let place = 0;
    const line = (ms: number, event: Event): Line => ({ start: place, end: ++place, time: at(1) + ms, ordinal: undefined, event });
    const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model: 'gpt-5.5-codex' });
    const [turn] = [
      line(100, { kind: 'start', turnId: 'turn' }),
      line(105, { kind: 'output' }),
      line(95, { kind: 'call', callId: 'c1', name: 'exec_command', inPlace: false, outcome: undefined }),
      line(90, { kind: 'usage', turnId: 'turn', responseId: 'r1', usage: { input: 10, cached: 0, cacheWrite: 0, output: 1 } }),
      line(96, { kind: 'result', callId: 'c1' }),
      // Codex's own record of the command, its end before its start.
      line(97, { kind: 'done', callId: 'c1', name: undefined, outcome: undefined, startMs: at(1) + 300, endMs: at(1) + 200, durationMs: undefined }),
      line(80, { kind: 'output' }),
      line(85, { kind: 'complete', turnId: 'turn', errorType: undefined }),
    ].flatMap((each) => turns.push(each));
    const run = recordOf(turn!, { sessionId: 's', provider: 'openai', model: undefined })!;
    for (const item of run.inside ?? []) {
      expect(Number(item.end)).toBeGreaterThanOrEqual(Number(item.start));
      expect(Number(item.start)).toBeGreaterThanOrEqual(Number(run.start));
      expect(Number(item.end)).toBeLessThanOrEqual(Number(run.end));
    }
    expect([Number(run.start), Number(run.end)]).toEqual([at(1) + 80, at(1) + 300]);
    // The SDK refuses a record with any span ending before it starts; this one it queues.
    const telmoni = new Telmoni(
      { endpoint: 'http://127.0.0.1:9', apiKey: 'tm_test' },
      { transport: () => Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve('{}') }) },
    );
    try {
      expect(() => telmoni.recordRun(run)).not.toThrow();
    } finally {
      await telmoni.shutdown();
    }
  });
});

describe('a turn of more calls than a run holds', () => {
  it('is a run of its earliest, ending as the turn did', () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'openai' };
    let place = 0;
    const line = (event: Event): Line => ({ start: place, end: ++place, time: at(1) + place, ordinal: undefined, event });
    const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model: 'gpt-5.5-codex' });
    const lines = [line({ kind: 'start', turnId: 'turn' })];
    // Each call its own response: the model asks, the tool answers.
    for (let index = 0; index < MAX_CALLS / 2 + 25; index++) {
      lines.push(line({ kind: 'call', callId: `c${index}`, name: 'exec_command', inPlace: false, outcome: undefined }));
      lines.push(line({ kind: 'result', callId: `c${index}` }));
    }
    lines.push(line({ kind: 'complete', turnId: 'turn', errorType: undefined }));
    const [closed] = lines.flatMap((each) => turns.push(each));
    expect(closed!.responses.length + closed!.calls.size).toBe(MAX_CALLS + 50);
    const run = recordOf(closed!, { sessionId: 's', provider: 'openai', model: undefined })!;
    const starts = [...closed!.responses.map((each) => each.start), ...[...closed!.calls.values()].map((each) => each.start)];
    expect((run.inside ?? []).map((item) => Number(item.start))).toEqual(starts.sort((a, b) => a - b).slice(0, MAX_CALLS));
    expect(run.end).toBe(at(1) + place);
  });
});

describe('a name past ingest’s caps', () => {
  it('is cut to them by character, never inside one: a tool’s to 145, a model’s to 128', () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'openai' };
    // An astral character straddles each cap, two UTF-16 units that must not be parted.
    const model = `${'m'.repeat(127)}😀${'m'.repeat(40)}`;
    const tool = `mcp__${'s'.repeat(60)}__${'t'.repeat(77)}😀😀${'t'.repeat(40)}`;
    let place = 0;
    const line = (event: Event): Line => ({ start: place, end: ++place, time: at(1) + place, ordinal: undefined, event });
    const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model });
    const [turn] = [
      line({ kind: 'start', turnId: 'turn' }),
      line({ kind: 'call', callId: 'c1', name: tool, inPlace: false, outcome: undefined }),
      line({ kind: 'result', callId: 'c1' }),
      line({ kind: 'complete', turnId: 'turn', errorType: undefined }),
    ].flatMap((each) => turns.push(each));
    const run = recordOf(turn!, { sessionId: 's', provider: 'openai', model: undefined })!;
    const [call] = modelCalls(run);
    const [used] = toolCalls(run);
    expect([...call!.model]).toHaveLength(128);
    expect(call!.model.endsWith('😀')).toBe(true);
    expect([...used!.name]).toHaveLength(145);
    expect(used!.name.endsWith('😀')).toBe(true);
    expect(`${call!.model}${used!.name}`).not.toMatch(/\p{Cs}/u);
    // A name within the caps is sent whole.
    expect(modelCalls(runsOf('paginated')[0]!).map((each) => each.model)).toEqual(['gpt-5.5-codex', 'gpt-5.5-codex', 'gpt-5.5-codex']);
  });
});

describe('a local model’s name', () => {
  it('is sent as Codex gives it, a model file’s own name for its path, and never a path', () => {
    const meta: Meta = { threadId: 't', sessionId: 't', created: at(0), derived: false, ownFrom: undefined, provider: 'ollama' };
    const sent = (model: string): string => {
      let place = 0;
      const line = (event: Event): Line => ({ start: place, end: ++place, time: at(1) + place, ordinal: undefined, event });
      const turns = new Turns(meta, new Set(), undefined, { offset: 0, countKey: undefined, model });
      const [turn] = [line({ kind: 'start', turnId: 'turn' }), line({ kind: 'output' }), line({ kind: 'complete', turnId: 'turn', errorType: undefined })].flatMap((each) => turns.push(each));
      return modelCalls(recordOf(turn!, { sessionId: 's', provider: 'ollama', model: undefined })!)[0]!.model;
    };
    for (const model of ['gpt-oss:20b', 'openai/gpt-oss-20b', 'qwen3-coder-30b.gguf']) expect(sent(model)).toBe(model);
    expect(sent('/home/someone/models/gpt-oss-20b-mxfp4.gguf')).toBe('gpt-oss-20b-mxfp4.gguf');
    expect(sent('models/x.gguf')).toBe('x.gguf');
    expect(sent('C:\\Users\\someone\\models\\x.safetensors')).toBe('x.safetensors');
    expect(sent(' /home/someone/models/x.gguf ')).toBe('x.gguf');
    for (const path of ['/home/someone/models/gpt-oss', ' /home/someone', '~/models/x', './x', 'D:/models/x', 'file:///home/someone/m']) expect(sent(path)).toBe('unknown');
  });
});

describe('a run id', () => {
  it('is a version 5 UUID as RFC 9562 derives one', () => {
    // RFC 9562's own example: the DNS namespace and "www.example.com".
    expect(uuid5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is the session’s and the turn’s under the plugin’s namespace, never to change: a turn sent before an update and again after it is one run', () => {
    // Python's uuid.uuid5(UUID('188e660b-8a52-464f-ad0e-81f2a9339eee'), '<session>/<turn>') agrees.
    expect(runIdOf('01a12f57-06f8-7000-8000-010123456789', '01a12f57-1e68-7000-8000-0a0123456789')).toBe('99b99f25-42d2-5878-93d9-a3424b0baf97');
  });
});
