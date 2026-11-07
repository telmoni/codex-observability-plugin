import { describe, expect, it } from 'vitest';

import { handOff, readStop, takeOver } from '../src/payload.js';
import { Rollout, SECRETS, SESSION, makeHome } from './helpers.js';

describe('what the hook keeps of a stop', () => {
  it('the session, its rollout, the turn, the folder and the model: never the last reply', () => {
    const rollout = new Rollout(makeHome());
    const turnId = rollout.prompt();
    const stop = readStop(rollout.stopPayload(), 1_000);
    expect(stop).toEqual({
      sessionId: SESSION,
      transcriptPath: rollout.path,
      event: 'Stop',
      turnId,
      cwd: rollout.cwd,
      model: 'gpt-6-sol',
      at: 1_000,
    });
    expect(JSON.stringify(stop)).not.toContain(SECRETS.lastReply);
  });

  it('of a session’s end, no turn', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    expect(readStop(rollout.endPayload(), 1)).toMatchObject({ event: 'SessionEnd' });
    expect(readStop({ ...rollout.endPayload(), turn_id: 'x' }, 1)?.turnId).toBeUndefined();
  });

  it.each([
    ['no session', { session_id: undefined }],
    ['a session that is no plain id', { session_id: '../etc' }],
    ['no rollout', { transcript_path: null }],
    ['a relative rollout', { transcript_path: 'rollout.jsonl' }],
    ['a rollout that is no .jsonl', { transcript_path: '/tmp/rollout.json' }],
    ['another event', { hook_event_name: 'SubagentStop' }],
  ])('nothing, for %s', (_, change) => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    expect(readStop({ ...rollout.stopPayload(), ...change }, 1)).toBeUndefined();
  });

  it('a relative folder, a turn id that is no plain id or a model past 256 characters, left out', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    const stop = readStop(
      { ...rollout.stopPayload(), cwd: 'relative', turn_id: 'a b', model: 'm'.repeat(257) },
      1,
    );
    expect(stop?.cwd).toBeUndefined();
    expect(stop?.turnId).toBeUndefined();
    expect(stop?.model).toBeUndefined();
  });
});

describe('the hand-off to the worker', () => {
  it('carries the stop whole, its size too, and nothing else', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    const stop = rollout.stop();
    expect(takeOver(handOff(stop))).toEqual(stop);
  });

  it.each(['', 'not json', '[]', '{}', JSON.stringify({ sessionId: SESSION })])(
    'is refused for %j',
    (text) => {
      expect(takeOver(text)).toBeUndefined();
    },
  );
});
