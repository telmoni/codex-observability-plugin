import { describe, expect, it } from 'vitest';

import { readRollout } from '../src/transcript.js';
import { cut, isComplete } from '../src/turns.js';
import { Rollout, makeHome } from './helpers.js';

const turnsOf = (rollout: Rollout) => {
  const read = readRollout(rollout.path, { content: false, from: 0 });
  if ('problem' in read) throw new Error(read.problem);
  return cut(read.rows);
};

describe('turns', () => {
  it('each from its start to its close, the rows between its own', () => {
    const rollout = new Rollout(makeHome());
    const first = rollout.turn(1);
    const second = rollout.turn(0);
    const turns = turnsOf(rollout);
    expect(turns.map((turn) => turn.id)).toEqual([first, second]);
    expect(turns[0]?.close?.kind).toBe('turn_complete');
    expect(turns[0]?.rows.at(-1)).toBe(turns[0]?.close);
    expect(turns[0]?.followed).toBe(true);
    expect(turns[1]?.followed).toBe(false);
    expect(turns[0]?.rows.filter((row) => row.kind === 'usage')).toHaveLength(2);
  });

  it('an aborted turn closes as aborted', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true }).command().abort();
    expect(turnsOf(rollout)[0]?.close).toMatchObject({
      kind: 'turn_aborted',
      reason: 'interrupted',
    });
  });

  it('nothing written after a turn’s close is its own', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply().complete().reply();
    expect(turnsOf(rollout)[0]?.rows.filter((row) => row.kind === 'usage')).toHaveLength(1);
  });

  it('is complete once closed, once a later turn began, or once the session ended', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply();
    rollout.prompt();
    rollout.reply();
    const [followed, open] = turnsOf(rollout);
    expect(isComplete(followed!, false)).toBe(true);
    expect(isComplete(open!, false)).toBe(false);
    expect(isComplete(open!, true)).toBe(true);
  });
});
