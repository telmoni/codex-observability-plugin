import type { ModelCallRecord, RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import { type RecordOptions, recordTurn, runIdOf } from '../src/record.js';
import { type Row, readRollout } from '../src/transcript.js';
import { type Turn, cut } from '../src/turns.js';
import { Rollout, SECRETS, SESSION, assertMetadataOnly, makeHome } from './helpers.js';

const OPTIONS: RecordOptions = {
  sessionId: SESSION,
  model: 'gpt-6-sol',
  provider: 'openai',
  effort: undefined,
  sessionEnded: false,
  content: false,
};

function record(rollout: Rollout, options: Partial<RecordOptions> = {}, index = -1): RunRecord {
  const read = readRollout(rollout.path, { content: options.content ?? false, from: 0 });
  if ('problem' in read) throw new Error(read.problem);
  const turn = cut(read.rows).at(index);
  if (turn === undefined) throw new Error('no turn');
  const run = recordTurn(turn, { ...OPTIONS, ...options });
  if (run === undefined) throw new Error('no run');
  return run;
}

const models = (run: RunRecord) =>
  (run.inside ?? []).filter((call): call is ModelCallRecord => call.type === 'model_call');
const tools = (run: RunRecord) =>
  (run.inside ?? []).filter((call): call is ToolCallRecord => call.type === 'tool_call');

describe('a turn as a run', () => {
  it('of codex, in the session, from the turn’s start to its close, its id the same however often built', () => {
    const rollout = new Rollout(makeHome());
    const start = rollout.now;
    const turnId = rollout.turn(1);
    const run = record(rollout);
    expect(run).toMatchObject({
      runId: runIdOf(SESSION, turnId),
      agent: 'codex',
      sessionId: SESSION,
    });
    expect(run.start).toBe(start);
    expect(run.end).toBe(rollout.now - 1000);
    expect(record(rollout).runId).toBe(run.runId);
    expect(runIdOf(SESSION, turnId)).not.toBe(runIdOf('another', turnId));
  });

  it('a model call per response: its model, provider and effort, tokens as Codex counts them', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tokens: { input: 900, cached: 600, cacheWrite: 100, output: 50 } }).complete();
    const [call] = models(record(rollout));
    expect(call).toMatchObject({
      model: 'gpt-6-sol',
      provider: 'openai',
      reasoningEffort: 'high',
      usage: {
        inputTokens: 900,
        outputTokens: 50,
        cacheReadInputTokens: 600,
        cacheWriteInputTokens: 100,
      },
    });
  });

  it('a model call runs from what it was handed, the prompt or the tools’ output, to its tokens’ record', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    const prompted = rollout.now - 1000;
    rollout.reply({ tool: true }).command();
    const handed = rollout.now;
    rollout.toolOutput().reply().complete();
    const [first, second] = models(record(rollout));
    expect(first?.start).toBe(prompted);
    expect(second?.start).toBe(handed);
    expect(Number(second?.end)).toBeGreaterThan(handed);
  });

  it('the model the turn’s context names, else the session’s, on Azure by Azure OpenAI’s name', () => {
    const rollout = new Rollout(makeHome());
    rollout.model = 'gpt-5.3-codex';
    rollout.turn(0);
    expect(models(record(rollout, { provider: 'azure' }))[0]).toMatchObject({
      model: 'gpt-5.3-codex',
      provider: 'azure.ai.openai',
    });
  });

  it('each tool by its kind, at the times Codex wrote, failed or cancelled as it ended', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true });
    const started = rollout.now;
    rollout.command({ ms: 2500 }).command({ exitCode: 1 }).command({ status: 'declined' });
    rollout.edit().mcp('github', 'search_issues').search().toolOutput().reply().complete();
    const calls = tools(record(rollout));
    expect(calls.map((call) => call.name)).toEqual([
      'shell',
      'shell',
      'shell',
      'apply_patch',
      'mcp__github__search_issues',
      'web_search',
    ]);
    expect(calls[0]).toMatchObject({ start: started, end: started + 2500 });
    expect(calls[0]?.errorType).toBeUndefined();
    expect(calls[1]?.errorType).toBe('ToolError');
    expect(calls[2]?.cancelled).toBe(true);
  });

  it('every call ordered by its start, inside the run’s own times', () => {
    const run = record(
      (() => {
        const rollout = new Rollout(makeHome());
        rollout.turn(3);
        return rollout;
      })(),
    );
    const starts = (run.inside ?? []).map((call) => Number(call.start));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const call of run.inside ?? []) {
      expect(Number(call.start)).toBeGreaterThanOrEqual(Number(run.start));
      expect(Number(call.end)).toBeLessThanOrEqual(Number(run.end));
    }
  });

  it('the error that ended a turn is its last model call, failed, and the run fails by its kind', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true }).command().toolOutput();
    const handed = rollout.now - 1000;
    rollout.complete({ error: { response_too_many_failed_attempts: { http_status_code: 502 } } });
    const run = record(rollout);
    expect(models(run)).toHaveLength(2);
    expect(models(run).at(-1)).toMatchObject({
      start: handed,
      errorType: 'response_too_many_failed_attempts',
    });
    expect(run.errorType).toBe('response_too_many_failed_attempts');
  });

  it('a turn interrupted, replaced, or left open as the session ended or another began, is cancelled', () => {
    for (const reason of ['interrupted', 'replaced', 'review_ended']) {
      const aborted = new Rollout(makeHome());
      aborted.prompt();
      aborted.reply({ tool: true }).command().abort(reason);
      expect(record(aborted).cancelled, reason).toBe(true);
    }

    const open = new Rollout(makeHome());
    open.prompt();
    open.reply();
    expect(record(open, { sessionEnded: true }).cancelled).toBe(true);
    expect(record(open).cancelled).toBeUndefined();
  });

  it('a turn out of its budget fails as such', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply().abort('budget_limited');
    expect(record(rollout)).toMatchObject({ errorType: 'budget_limited' });
    expect(record(rollout).cancelled).toBeUndefined();
  });

  it('a compaction is a step of its own, holding the model call that wrote its summary', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply();
    const started = rollout.now;
    rollout.compact().reply().complete();
    const run = record(rollout);
    const steps = (run.inside ?? []).filter((call): call is StepRecord => call.type === 'step');
    expect(steps.map((step) => step.name)).toEqual(['compaction']);
    expect(steps[0]?.start).toBe(started);
    const summary = (steps[0]?.calls ?? []) as ModelCallRecord[];
    expect(summary).toHaveLength(1);
    expect(summary[0]?.usage?.inputTokens).toBe(90000);
    expect(Number(summary[0]?.start)).toBeGreaterThanOrEqual(started);
    // The turn's own two responses, beside the step.
    expect(models(run)).toHaveLength(2);
  });

  it('a turn of any length: two hundred thousand tool calls', () => {
    const turn: Turn = {
      id: 'turn',
      open: { kind: 'turn_started', offset: 0, at: 1_000, turnId: 'turn' },
      rows: Array.from({ length: 200_000 }, (_, i): Row => ({
        kind: 'tool',
        offset: i + 1,
        at: 2_000 + i,
        turnId: 'turn',
        tool: { name: 'shell', start: 2_000 + i, end: 2_001 + i, failed: false, declined: false },
      })),
      followed: false,
    };
    const run = recordTurn(turn, OPTIONS);
    expect(run?.inside).toHaveLength(200_000);
    expect(run?.end).toBe(2_000 + 200_000);
  });

  it('a turn with no call in it is none', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.complete();
    const read = readRollout(rollout.path, { content: false, from: 0 });
    if ('problem' in read) throw new Error(read.problem);
    expect(recordTurn(cut(read.rows)[0]!, OPTIONS)).toBeUndefined();
  });
});

describe('content', () => {
  const full = () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true }).command().edit().toolOutput().reply().compact().complete();
    return rollout;
  };

  it('off: nothing said in the run', () => {
    const run = record(full());
    assertMetadataOnly(JSON.stringify(run));
  });

  it('on: the prompt and last reply, what each model call was handed and said, each tool’s input and output', () => {
    const run = record(full(), { content: true });
    expect(run.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: SECRETS.prompt }] },
    ]);
    expect(run.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: SECRETS.lastReply }] },
    ]);
    const [first, second] = models(run);
    expect(first?.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: SECRETS.prompt }] },
    ]);
    expect(JSON.stringify(first?.outputMessages)).toContain(SECRETS.reasoning);
    expect(JSON.stringify(first?.outputMessages)).toContain(SECRETS.code);
    expect(second?.inputMessages).toEqual([
      { role: 'tool', parts: [{ type: 'tool_call_response', response: SECRETS.output }] },
    ]);
    const [command, edit] = tools(run);
    expect(JSON.stringify(command?.arguments)).toContain(SECRETS.command);
    expect(command?.result).toBe(SECRETS.output);
    expect(JSON.stringify(edit?.arguments)).toContain(SECRETS.diff);
    expect(JSON.stringify(run)).not.toContain(SECRETS.instructions);
  });
});
