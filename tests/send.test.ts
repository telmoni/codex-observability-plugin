import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sender, flushSecondsOf } from '../src/send';
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
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(2);
    for (const request of ingest.received) {
      expect(request.url).toBe('/otlp/v1/traces');
      expect(request.headers['authorization']).toBe('Bearer tm_test');
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
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
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
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
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
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
      // Taken whole: no warning of the turns before it is this one's.
      expect(await sender.send(turn('5f8a0c3e-7d4b-4c9a-8e2f-0a1b2c3d4e5f'))).toBe(true);
      ingest.status = 401;
      expect(await sender.send(turn('6a9b1d4f-8e5c-4dab-9f3a-1b2c3d4e5f6a'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual([
      'taken in part: telmoni: the server refused a span: name: past its cap',
      expect.stringMatching(/^taken in part: telmoni: the server dropped gen_ai\.tool\.name \(over_cap/) as unknown,
      expect.stringMatching(/^not sent: telmoni: export refused with 401 /) as unknown,
    ]);
  });

  it('counts a turn the SDK sent less a field it could not take as taken, rather than send it again at every hook', async () => {
    const call = { type: 'model_call' as const, model: 'gpt-5.5-codex', provider: 'openai', start: at(0), end: at(4), usage: { inputTokens: -1 } };
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: [call] })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(1);
    expect(logged).toEqual(['taken in part: telmoni: gen_ai.usage.input_tokens must be a whole number from 0 within 64 bits; the call is sent without it']);
  });

  it('passes over a turn refused for good, which the same bytes would get again, and goes on to the next', async () => {
    for (const status of [400, 402, 413, 500]) {
      ingest.answers.push({ status });
      const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
      try {
        expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
        expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
      } finally {
        await sender.close();
      }
    }
    expect(logged.map((line) => line.slice(0, line.lastIndexOf(' /')))).toEqual(
      [400, 402, 413, 500].map((status) => `refused, not sent again: telmoni: export refused with ${status}`),
    );
    expect(ingest.received).toHaveLength(8);
  });

  it('keeps a turn ingest refused for a fault of its database, which a later hook may find mended', async () => {
    ingest.answers.push({ status: 500, type: '/errors/internal/database' });
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual(['not sent: telmoni: export refused with 500 /errors/internal/database; the batch was dropped']);
  });

  it('hears each turn’s refusal, so one refused as the turn before it is never read as taken', async () => {
    ingest.answers.push({ status: 400 }, { status: 400 }, { status: 500, type: '/errors/internal/unknown' }, { status: 500, type: '/errors/internal/database' });
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
      expect(await sender.send(turn('5f8a0c3e-7d4b-4c9a-8e2f-0a1b2c3d4e5f'))).toBe(true);
      expect(await sender.send(turn('6a9b1d4f-8e5c-4dab-9f3a-1b2c3d4e5f6a'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual([
      expect.stringMatching(/^refused, not sent again: telmoni: export refused with 400 /) as unknown,
      expect.stringMatching(/^refused, not sent again: telmoni: export refused with 400 /) as unknown,
      'refused, not sent again: telmoni: export refused with 500 /errors/internal/unknown; the batch was dropped',
      'not sent: telmoni: export refused with 500 /errors/internal/database; the batch was dropped',
    ]);
  });

  it('gives a turn’s flush the SDK’s worst case for each batch of 512 spans, and half a minute more', () => {
    const calls = (count: number): RunRecord => ({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: Array.from({ length: count }, (_, index) => ({ type: 'tool_call' as const, name: 'shell', start: at(index % 9), end: at(9) })) });
    expect([0, 510, 511, 3_000].map((count) => flushSecondsOf(calls(count)))).toEqual([180, 180, 330, 930]);
  });

  it('passes over a turn the SDK refuses, rather than hold the session up on it', async () => {
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
  });
});
