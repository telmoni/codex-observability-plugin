/**
 * A session's turns as Codex marks them, each from its `task_started` to its `task_complete` or `turn_aborted`, and
 * when one can no longer change.
 */

import type { Row } from './transcript.js';

export type Opening = Extract<Row, { kind: 'turn_started' }>;
export type Closing = Extract<Row, { kind: 'turn_complete' | 'turn_aborted' }>;

export interface Turn {
  id: string;
  /** The row that opened it: where in the rollout it begins, and when. */
  open: Opening;
  /** Every row after the opening one that is the turn's, in the rollout's order, its closing one last. */
  rows: Row[];
  /** How Codex ended it, where it has. */
  close?: Closing;
  /** Whether a later turn began after it, which ends it whatever was written of its close. */
  followed: boolean;
}

/** The turns of `rows` in order; rows before the first turn, or naming a turn not open, belong to none. */
export function cut(rows: readonly Row[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  let current: Turn | undefined;
  for (const row of rows) {
    if (row.kind === 'turn_started') {
      if (row.turnId === undefined) continue;
      if (current !== undefined) current.followed = true;
      current = { id: row.turnId, open: row, rows: [], followed: false };
      turns.push(current);
      byId.set(row.turnId, current);
      continue;
    }
    // A row naming its turn goes to it; one naming none, to the turn it was written in.
    const turn = row.turnId === undefined ? current : byId.get(row.turnId);
    if (turn === undefined || turn.close !== undefined) continue;
    turn.rows.push(row);
    if (row.kind === 'turn_complete' || row.kind === 'turn_aborted') turn.close = row;
  }
  return turns;
}

/**
 * Whether nothing more can come of a turn: Codex closed it, a later turn began, or the session ended, after which
 * Codex writes nothing more to it.
 */
export function isComplete(turn: Turn, sessionEnded: boolean): boolean {
  return turn.close !== undefined || turn.followed || sessionEnded;
}
