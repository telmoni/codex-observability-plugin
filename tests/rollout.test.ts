import { appendFileSync, closeSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Line, Reader, readMeta } from '../src/rollout';
import { CONTENT, fixture, fixtureLines, tempDir } from './helpers';

let dir: { path: string; remove: () => void };

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.remove();
});

/** Every line from `offset` on, read in stretches of `chunk` bytes. */
function readAll(path: string, offset = 0, chunk?: number, maxLine?: number): Line[] {
  const reader = new Reader(path, offset, chunk, maxLine);
  try {
    const lines: Line[] = [];
    for (let read = reader.read(); read !== undefined; read = reader.read()) lines.push(...read);
    return lines;
  } finally {
    reader.close();
  }
}

const started = (turnId: string, at = '2026-10-12T09:00:00.000Z'): string =>
  JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });

describe('a rollout', () => {
  it('is read from an offset, line by whole line, a line still being written left for later', () => {
    const path = join(dir.path, 'rollout.jsonl');
    const first = `${started('a')}\n`;
    writeFileSync(path, `${first}not json\n${started('b')}\n{"timestamp":"2026-10-12T09:00:00.000Z","type":"event_msg"`);
    const lines = readAll(path);
    expect(lines.map((line) => line.event)).toEqual([
      { kind: 'start', turnId: 'a' },
      { kind: 'other' },
      { kind: 'start', turnId: 'b' },
    ]);
    expect(lines[0]!.end).toBe(Buffer.byteLength(first));
    expect(lines[1]!.start).toBe(lines[0]!.end);
    const reader = new Reader(path, lines.at(-1)!.end);
    try {
      expect(reader.read()).toEqual([]);
      appendFileSync(path, ',"payload":{"type":"task_started","turn_id":"c"}}\n');
      expect(reader.read()!.map((line) => line.event)).toEqual([{ kind: 'start', turnId: 'c' }]);
      expect(reader.read()).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it('never reads what lies before its offset, however far into the file', () => {
    const path = join(dir.path, 'rollout.jsonl');
    // Three gibibytes of nothing on disk, with no newline in them: read from
    // the start, they would take seconds and come out as one line too long.
    const offset = 3 * 1024 ** 3;
    const fd = openSync(path, 'w');
    try {
      ftruncateSync(fd, offset);
    } finally {
      closeSync(fd);
    }
    appendFileSync(path, `${started('after')}\n`);
    const began = Date.now();
    const lines = readAll(path, offset);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(lines).toEqual([
      { start: offset, end: offset + Buffer.byteLength(started('after')) + 1, time: Date.UTC(2026, 9, 12, 9), ordinal: undefined, event: { kind: 'start', turnId: 'after' } },
    ]);
  });

  it('comes out the same whatever stretches it is read in', () => {
    const whole = readAll(fixture('paginated'));
    expect(readAll(fixture('paginated'), 0, 7)).toEqual(whole);
    expect(readAll(fixture('paginated'), 0, 4096)).toEqual(whole);
    expect(whole).toHaveLength(fixtureLines('paginated').length);
  });

  it('passes over a line too long to be anything it reads, and reads on', () => {
    const path = join(dir.path, 'rollout.jsonl');
    const long = JSON.stringify({ timestamp: '2026-10-12T09:00:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'x'.repeat(5000) } });
    writeFileSync(path, `${long}\n${started('next')}\n`);
    const lines = readAll(path, 0, 512, 1024);
    expect(lines.map((line) => line.event)).toEqual([{ kind: 'other' }, { kind: 'start', turnId: 'next' }]);
    expect(lines[1]!.start).toBe(Buffer.byteLength(long) + 1);
  });

  it('names its thread on its first line: the session, and whether it began from another', () => {
    const paginated = readMeta(fixture('paginated'))!;
    expect(paginated).toMatchObject({ derived: false, ownFrom: undefined, provider: 'openai' });
    expect(paginated.sessionId).toBe(paginated.threadId);
    const subagent = readMeta(fixture('subagent'))!;
    expect(subagent.derived).toBe(true);
    expect(subagent.ownFrom).toBe(9);
    expect(subagent.sessionId).not.toBe(subagent.threadId);
    expect(readMeta(fixture('fork-legacy'))!.derived).toBe(true);
    // A legacy first line carries no session id: the thread is its own session.
    const legacy = readMeta(fixture('legacy'))!;
    expect(legacy.sessionId).toBe(legacy.threadId);
    const path = join(dir.path, 'rollout.jsonl');
    writeFileSync(path, `${started('a')}\n`);
    expect(readMeta(path)).toBeUndefined();
  });

  it('keeps nothing of what was said: no text, no command, no path, no email', () => {
    for (const name of ['paginated', 'legacy', 'fork-legacy', 'subagent', 'fork-paginated']) {
      const kept = JSON.stringify(readAll(fixture(name)));
      for (const text of CONTENT) expect(kept).not.toContain(text);
    }
  });

  it('reads a running total as a response’s share only where that reads true', () => {
    const counts = readAll(fixture('paginated')).flatMap((line) => (line.event.kind === 'count' ? [line.event] : []));
    // The estimate after the compaction, and its repeat, are zero but for their total.
    expect(counts.filter((count) => count.usage === undefined && count.key !== 'none')).toHaveLength(2);
    expect(counts.find((count) => count.usage !== undefined)!.usage).toEqual({ input: 12000, cached: 8000, cacheWrite: 0, output: 300 });
  });

  it('names a turn’s error by its kind, never its message', () => {
    const path = join(dir.path, 'rollout.jsonl');
    const closing = (error: unknown): string =>
      JSON.stringify({ timestamp: '2026-10-12T09:00:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', error } });
    writeFileSync(
      path,
      [
        closing({ message: 'FAKE', codex_error_info: { http_connection_failed: { http_status_code: 502 } } }),
        closing({ message: 'FAKE', codex_error_info: 'usage_limit_exceeded' }),
        closing({ message: 'FAKE' }),
        closing(null),
      ].join('\n') + '\n',
    );
    expect(readAll(path).map((line) => (line.event.kind === 'complete' ? line.event.errorType : 'not a closing'))).toEqual([
      'http_connection_failed',
      'usage_limit_exceeded',
      'other',
      undefined,
    ]);
  });
});
