import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name: string): string {
  return join(FIXTURES, name, 'rollout.jsonl');
}

/** A fixture's lines, each with its record parsed. */
export function fixtureLines(name: string): Array<{ text: string; record: Record<string, unknown> }> {
  return readFileSync(fixture(name), 'utf8')
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => ({ text, record: JSON.parse(text) as Record<string, unknown> }));
}

/** The payload of a fixture's record, as a test reads it to check the plugin against. */
export function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record['payload'] ?? {}) as Record<string, unknown>;
}

/** What a fixture's fake text holds, none of which may leave the plugin. */
export const CONTENT = ['FAKE', '/home/someone', 'example.com', 'rm -rf'];

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'telmoni-codex-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code: number };
}

export interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Answer {
  status: number;
  /** A partial success, as ingest words one: `span <id> refused: <why>`, `span <id> dropped <attribute>: <reason>`. */
  partial?: string;
}

/** Ingest as the SDK meets it: an OTLP/JSON lane that keeps what it is sent, or answers `status`. */
export class FakeIngest {
  readonly received: Received[] = [];
  status = 200;
  /** The answers to the next requests, one each, before `status` again. */
  readonly answers: Answer[] = [];
  #server: Server | undefined;

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.received.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        const answer = this.answers.shift() ?? { status: this.status };
        if (answer.status === 200) {
          const partial = answer.partial === undefined ? null : { rejectedSpans: answer.partial.includes(' refused: ') ? 1 : 0, errorMessage: answer.partial };
          response.writeHead(200, { 'Content-Type': 'application/json', 'Telmoni-Content-Mode': 'off' });
          response.end(JSON.stringify({ partialSuccess: partial }));
        } else {
          response.writeHead(answer.status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 7, message: '/errors/authz/forbidden: this API key does not hold the ingest scope' }));
        }
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  spans(): JsonSpan[] {
    return this.received.flatMap((request) => {
      const body = JSON.parse(request.body) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: JsonSpan[] }> }>;
      };
      return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    });
  }
}

export function attributesOf(span: JsonSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of span.attributes) {
    const value = attribute.value;
    out[attribute.key] = 'intValue' in value ? Number(value['intValue']) : Object.values(value)[0];
  }
  return out;
}

const U64_MAX = 2n ** 64n - 1n;
const I64_MAX = 2n ** 63n - 1n;
const characters = (text: string): number => [...text].length;

/**
 * Why ingest would refuse each span it was sent, by the rules it reads a
 * span by (`crates/telemetry/src/ingest/span.rs` in telmoni/telmoni): a span
 * refused is refused on every hook, so a plugin may send none.
 */
export function refusalsIn(spans: JsonSpan[]): string[] {
  return spans.flatMap((span) => {
    const why = refusalOf(span);
    return why === undefined ? [] : [`${span.name}: ${why}`];
  });
}

function refusalOf(span: JsonSpan): string | undefined {
  if (span.name === 'telmoni.run.start') return undefined;
  if (!/^[0-9a-f]{32}$/.test(span.traceId) || /^0+$/.test(span.traceId)) return 'trace_id';
  if (!/^[0-9a-f]{16}$/.test(span.spanId) || /^0+$/.test(span.spanId)) return 'span_id';
  if (span.parentSpanId !== undefined && span.parentSpanId !== '' && !/^[0-9a-f]{16}$/.test(span.parentSpanId)) {
    return 'parent_span_id';
  }
  const raw = new Map(span.attributes.map((attribute) => [attribute.key, attribute.value]));
  const text = (key: string): string | undefined => {
    const value = raw.get(key)?.['stringValue'];
    return typeof value === 'string' ? value : undefined;
  };
  for (const [key, value] of raw) {
    const string = value['stringValue'];
    if (typeof string === 'string' && /\p{Cs}/u.test(string)) return `${key} is no text`;
    const int = value['intValue'];
    if (int !== undefined && (typeof int !== 'string' || !/^\d+$/.test(int) || BigInt(int) > I64_MAX)) return `${key} is no count`;
  }
  const bounded: Array<[string, number]> = [
    ['telmoni.agent', 128],
    ['error.type', 128],
    ['gen_ai.request.model', 128],
    ['gen_ai.response.model', 128],
    ['gen_ai.provider.name', 128],
    ['gen_ai.conversation.id', 200],
  ];
  for (const [key, max] of bounded) {
    const value = text(key);
    if (value !== undefined && characters(value) > max) return `${key} past its cap`;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text('telmoni.run_id') ?? '')) return 'not a run';
  const agent = text('telmoni.agent');
  if (agent === undefined || agent === '') return 'not a run';
  const rate = raw.get('telmoni.sample_rate')?.['doubleValue'];
  if (rate !== undefined && !(typeof rate === 'number' && rate > 0 && rate <= 1)) return 'telmoni.sample_rate';
  const cancelled = raw.get('telmoni.cancelled');
  if (cancelled !== undefined && typeof cancelled['boolValue'] !== 'boolean') return 'telmoni.cancelled';
  const operation = text('gen_ai.operation.name');
  const name =
    operation === 'invoke_agent' || operation === 'invoke_workflow'
      ? (text('gen_ai.agent.name') ?? agent)
      : operation === 'execute_tool'
        ? (text('gen_ai.tool.name') ?? span.name)
        : span.name;
  if (name === '') return 'name is empty';
  if (characters(name) > 128) return 'name past its cap';
  const time = (nanos: string): bigint | undefined => (/^\d+$/.test(nanos) && BigInt(nanos) > 0n && BigInt(nanos) <= U64_MAX ? BigInt(nanos) : undefined);
  const start = time(span.startTimeUnixNano);
  const end = time(span.endTimeUnixNano);
  if (start === undefined) return 'start_time';
  if (end === undefined || end < start) return 'end_time';
  return undefined;
}
