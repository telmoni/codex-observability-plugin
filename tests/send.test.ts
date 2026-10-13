import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sender } from '../src/send';
import { FakeIngest, attributesOf, refusalsIn } from './helpers';

let ingest: FakeIngest;
let endpoint: string;
let logged: string[];

beforeEach(async () => {
  ingest = new FakeIngest();
  endpoint = await ingest.start();
  logged = [];
});

afterEach(async () => {
  await ingest.stop();
});

const at = (seconds: number): number => Date.UTC(2026, 9, 12, 9, 0, seconds);

function turn(runId: string): RunRecord {
  return {
    runId,
    agent: 'codex',
    sessionId: 'session-1',
    start: at(0),
    end: at(9),
    inside: [
      {
        type: 'model_call',
        model: 'gpt-5.5-codex',
        provider: 'openai',
        start: at(0),
        end: at(4),
        usage: { inputTokens: 12000, outputTokens: 300, cacheReadInputTokens: 8000, cacheWriteInputTokens: 0 },
      },
      { type: 'tool_call', name: 'exec_command', start: at(4), end: at(9), errorType: 'ToolError' },
    ],
  };
}

describe('a sender', () => {
  it('sends each turn in an export of its own, through the SDK, to ingest', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(2);
    for (const request of ingest.received) {
      expect(request.url).toBe('/otlp/v1/traces');
      expect(request.headers['authorization']).toBe('Bearer telmoni_test');
    }
    const runs = ingest.spans().filter((span) => span.name === 'invoke_agent codex');
    expect(runs.map((span) => attributesOf(span)['gen_ai.conversation.id'])).toEqual(['session-1', 'session-1']);
    const call = ingest.spans().find((span) => span.name === 'chat gpt-5.5-codex')!;
    expect(attributesOf(call)['gen_ai.usage.input_tokens']).toBe(12000);
    expect(attributesOf(call)['gen_ai.usage.cache_read.input_tokens']).toBe(8000);
    expect(attributesOf(call)['gen_ai.provider.name']).toBe('openai');
    expect(refusalsIn(ingest.spans())).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('takes a turn of more calls than the SDK queues by default, whole, in exports of 512', async () => {
    const calls = 2_100;
    const record: RunRecord = {
      ...turn('5f8a0c3e-7d4b-4c9a-8e2f-0a1b2c3d4e5f'),
      inside: Array.from({ length: calls }, (_, index) => ({ type: 'tool_call' as const, name: 'exec_command', start: at(0) + index, end: at(0) + index + 1 })),
    };
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(record)).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(Math.ceil((calls + 2) / 512));
    expect(ingest.spans()).toHaveLength(calls + 2);
    expect(refusalsIn(ingest.spans())).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('reports a turn the platform refused as not sent, naming why', async () => {
    ingest.status = 403;
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^not sent: .*403/);
  });

  it('counts a turn the platform answered for as taken, logging what it did not keep, and goes on to the next', async () => {
    // What ingest answers of an export it took, the same for the same bytes on every hook.
    ingest.answers.push(
      { status: 200, partial: 'span 0123456789abcdef refused: name: past its cap' },
      { status: 200, partial: 'span 0123456789abcdef dropped gen_ai.tool.name: over_cap; shorten it' },
    );
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
      // Taken whole: no warning of the turns before it is this one's.
      expect(await sender.send(turn('5f8a0c3e-7d4b-4c9a-8e2f-0a1b2c3d4e5f'))).toBe(true);
      ingest.status = 500;
      expect(await sender.send(turn('6a9b1d4f-8e5c-4dab-9f3a-1b2c3d4e5f6a'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual([
      'taken, but telmoni: the server refused a span: name: past its cap',
      expect.stringMatching(/^taken, but telmoni: the server dropped gen_ai\.tool\.name \(over_cap/) as unknown,
      expect.stringMatching(/^not sent: telmoni: export refused with 500 /) as unknown,
    ]);
  });

  it('passes over a turn the SDK refuses, rather than hold the session up on it', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
  });
});
