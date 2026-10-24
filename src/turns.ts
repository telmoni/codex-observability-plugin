/**
 * A rollout cut into turns — `task_started` to `task_complete`, `turn_aborted` or the next opening — each of the
 * thread's own gathered into responses, sealed by what went back to the model, and tool calls; a copied or sent turn is passed over.
 */

import type { Line, Meta, Opening, Outcome, Usage } from './rollout.js';

/** One response of the model: when it was asked and when it finished, and its tokens. */
export interface Response {
  start: number;
  end: number;
  model: string | undefined;
  /** Codex's record of its tokens, written as it completed. */
  recorded: Usage | undefined;
  /** Its share of a legacy rollout's running total, written once its tools had run. */
  counted: Usage | undefined;
  /** Whether what went back to the model has followed it, so that any more output is another response. */
  sealed: boolean;
}

export interface ToolCall {
  name: string;
  /** When the model's call was written. */
  start: number;
  /** When its answer, or Codex's record of its completion, was written. */
  answeredAt: number | undefined;
  /** When it ran, where Codex records that: its start and end, or its duration. */
  ranFrom: number | undefined;
  ranTo: number | undefined;
  ranMs: number | undefined;
  outcome: Outcome | undefined;
}

/** Where to read from again, and what the rollout had said by then. */
export interface Checkpoint {
  offset: number;
  countKey: string | undefined;
  model: string | undefined;
  /** The latest turn to open at or before the offset, by which the next hook knows the rollout as it was. */
  opening?: Opening | undefined;
}

export interface Turn {
  id: string;
  /** Where its opening line begins, and what the rollout had said by then: where to read from to gather it again. */
  before: Checkpoint;
  /** When its opening and its latest line were written. */
  start: number | undefined;
  last: number | undefined;
  model: string | undefined;
  responses: Response[];
  calls: Map<string, ToolCall>;
  /** Its closing line, if it had one: closed by the next turn's opening instead, it has none. */
  closing: { at: number | undefined; aborted: boolean; reason: string | undefined; errorType: string | undefined } | undefined;
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** When a version 7 UUID was minted, in milliseconds since the epoch: its first 48 bits. */
export function mintedAt(id: string): number | undefined {
  return V7.test(id) ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : undefined;
}

export class Turns {
  readonly #meta: Meta;
  readonly #sent: ReadonlySet<string>;
  readonly #target: string | undefined;
  #current: { turn: Turn; own: boolean } | undefined;
  #end: number;
  /** When the line before this one in the current turn was written: a response's request went out then. */
  #previous: number | undefined;
  #countKey: string | undefined;
  #model: string | undefined;
  #opening: Opening | undefined;
  readonly #responseIds = new Set<string>();

  /**
   * `target` is the turn a hook just named, which is the thread's own
   * whatever its id says; `from` where the read begins.
   */
  constructor(meta: Meta, sent: ReadonlySet<string>, target: string | undefined, from: Checkpoint) {
    this.#meta = meta;
    this.#sent = sent;
    this.#target = target;
    this.#end = from.offset;
    this.#countKey = from.countKey;
    this.#model = from.model;
    this.#opening = from.opening;
  }

  /** Takes the next line; the thread's own turns it closes, which are ready to send. */
  push(line: Line): Turn[] {
    this.#end = line.end;
    if (this.#meta.ownFrom !== undefined && line.ordinal !== undefined && line.ordinal < this.#meta.ownFrom) return [];
    const { event } = line;
    if (event.kind === 'start') return this.#open(event.turnId, line);
    if (event.kind === 'complete' || event.kind === 'aborted') {
      const closing = {
        at: line.time,
        aborted: event.kind === 'aborted',
        reason: event.kind === 'aborted' ? event.reason : undefined,
        errorType: event.errorType,
      };
      return this.#close(event.turnId, closing);
    }
    let fresh = false;
    if (event.kind === 'count') {
      fresh = event.key !== this.#countKey;
      this.#countKey = event.key;
    }
    const current = this.#current;
    if (event.kind === 'context' && event.model !== undefined && (event.turnId === undefined || event.turnId === current?.turn.id)) {
      this.#model = event.model;
    }
    if (current?.own) this.#apply(current.turn, line, fresh);
    return [];
  }

  /** The thread's own turn still open, if any. */
  get open(): Turn | undefined {
    return this.#current?.own ? this.#current.turn : undefined;
  }

  /** Lets the open turn go, once it has been sent as it stands; its lines still to come are passed over. */
  release(): void {
    if (this.#current !== undefined) this.#current = { turn: this.#current.turn, own: false };
  }

  /** Where the next read begins: at the open turn's opening, or past every line read. */
  checkpoint(): Checkpoint {
    const current = this.#current;
    return current?.own
      ? current.turn.before
      : { offset: this.#end, countKey: this.#countKey, model: this.#model, opening: this.#opening };
  }

  /** Whether the turn was copied from the thread's source, its id minted before the thread was. */
  #copied(turnId: string): boolean {
    const { derived, created } = this.#meta;
    if (!derived || created === undefined) return false;
    const minted = mintedAt(turnId);
    return minted !== undefined && minted < created;
  }

  #open(turnId: string, line: Line): Turn[] {
    const current = this.#current;
    if (current?.turn.id === turnId) return [];
    const closed: Turn[] = [];
    if (current?.own) closed.push(current.turn);
    const own = !this.#sent.has(turnId) && (turnId === this.#target || !this.#copied(turnId));
    const opening = { at: line.start, turnId };
    this.#opening = opening;
    this.#current = {
      own,
      turn: {
        id: turnId,
        before: { offset: line.start, countKey: this.#countKey, model: this.#model, opening },
        start: line.time,
        last: line.time,
        model: this.#model,
        responses: [],
        calls: new Map(),
        closing: undefined,
      },
    };
    this.#previous = line.time;
    return closed;
  }

  #close(turnId: string | undefined, closing: NonNullable<Turn['closing']>): Turn[] {
    const current = this.#current;
    if (current === undefined) return [];
    // A closing for another turn — one closed already, or a source's turn a fork's rollout ends — leaves this one open.
    if (turnId !== undefined && turnId !== current.turn.id) return [];
    const turn = current.turn;
    if (closing.at !== undefined) turn.last = Math.max(turn.last ?? closing.at, closing.at);
    turn.closing = closing;
    this.#current = undefined;
    return current.own ? [turn] : [];
  }

  #apply(turn: Turn, line: Line, fresh: boolean): void {
    const { event, time } = line;
    if (time !== undefined) {
      turn.start ??= time;
      turn.last = Math.max(turn.last ?? time, time);
    }
    switch (event.kind) {
      case 'context':
        if (event.model !== undefined && (event.turnId === undefined || event.turnId === turn.id)) turn.model = event.model;
        break;
      case 'output':
        this.#respond(turn, time);
        break;
      case 'call': {
        this.#respond(turn, time);
        if (time !== undefined && !turn.calls.has(event.callId)) {
          turn.calls.set(event.callId, {
            name: event.name,
            start: time,
            answeredAt: event.inPlace ? time : undefined,
            ranFrom: undefined,
            ranTo: undefined,
            ranMs: undefined,
            outcome: event.outcome,
          });
        }
        break;
      }
      case 'result': {
        this.#seal(turn);
        const call = turn.calls.get(event.callId);
        if (call !== undefined && time !== undefined) call.answeredAt ??= time;
        break;
      }
      case 'input':
        this.#seal(turn);
        break;
      case 'done': {
        const call = turn.calls.get(event.callId);
        if (call === undefined) break;
        if (event.name !== undefined) call.name = event.name;
        if (event.outcome !== undefined) call.outcome = event.outcome;
        call.ranFrom = event.startMs ?? call.ranFrom;
        call.ranTo = event.endMs ?? call.ranTo;
        call.ranMs = event.durationMs ?? call.ranMs;
        if (time !== undefined) call.answeredAt ??= time;
        break;
      }
      case 'usage': {
        if (event.turnId !== undefined && event.turnId !== turn.id) break;
        if (event.responseId !== undefined) {
          if (this.#responseIds.has(event.responseId)) break;
          this.#responseIds.add(event.responseId);
        }
        // Written as its response completed, before its tools ran: the open response's, else a call of its own, as a compaction's is.
        const open = turn.responses.at(-1);
        const response = open !== undefined && !open.sealed && open.recorded === undefined ? open : this.#begin(turn, time, true);
        if (response === undefined) break;
        response.recorded = event.usage;
        if (time !== undefined) response.end = Math.max(response.end, time);
        response.sealed = true;
        break;
      }
      case 'count': {
        if (!fresh || event.usage === undefined) break;
        // Written once the response's tools had run: the latest response's, whatever followed, unless that has its share.
        const last = turn.responses.at(-1);
        const response = last !== undefined && last.counted === undefined ? last : this.#begin(turn, time, true);
        if (response !== undefined) response.counted = event.usage;
        break;
      }
      default:
        break;
    }
    if (time !== undefined) this.#previous = time;
  }

  /** The model's output: more of the open response, or the next one. */
  #respond(turn: Turn, time: number | undefined): void {
    const last = turn.responses.at(-1);
    if (last !== undefined && !last.sealed) {
      if (time !== undefined) last.end = Math.max(last.end, time);
      return;
    }
    this.#begin(turn, time, false);
  }

  /** A response, its request taken to have gone out as the line before its first was written. */
  #begin(turn: Turn, time: number | undefined, sealed: boolean): Response | undefined {
    const end = time ?? this.#previous;
    if (end === undefined) return undefined;
    const response: Response = {
      start: Math.min(this.#previous ?? end, end),
      end,
      model: turn.model,
      recorded: undefined,
      counted: undefined,
      sealed,
    };
    turn.responses.push(response);
    return response;
  }

  #seal(turn: Turn): void {
    const last = turn.responses.at(-1);
    if (last !== undefined) last.sealed = true;
  }
}
