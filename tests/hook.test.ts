/**
 * The built hook, run as Codex runs it: a process handed its input on stdin,
 * which must print nothing and exit at once while a detached copy sends.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runIdOf } from '../src/record';
import { readMeta } from '../src/rollout';
import { CONTENT, FakeIngest, attributesOf, fixture, fixtureLines, payloadOf, refusalsIn, tempDir } from './helpers';

const HOOK = fileURLToPath(new URL('../dist/hook.mjs', import.meta.url));

let home: { path: string; remove: () => void };
let ingest: FakeIngest;
let endpoint: string;

beforeEach(async () => {
  home = tempDir();
  ingest = new FakeIngest();
  endpoint = await ingest.start();
});

afterEach(async () => {
  await ingest.stop();
  home.remove();
});

interface Ran {
  code: number | null;
  ms: number;
  stdout: string;
  stderr: string;
}

function runHook(input: object, env: Record<string, string>): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only what Codex hands a hook, and a home of the test's own.
      env: { PATH: process.env['PATH'] ?? '', HOME: home.path, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ms: Date.now() - started, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/** Where Codex keeps a rollout, under the given folder. */
function rolloutIn(codex: string, threadId: string): string {
  const day = join(codex, 'sessions', '2026', '10', '12');
  mkdirSync(day, { recursive: true });
  return join(day, `rollout-2026-10-12T08-59-55-${threadId}.jsonl`);
}

const offsetOf = (path: string): number | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { offset: number }).offset : undefined;

describe('the hook', () => {
  it('prints nothing, exits at once, and its detached copy sends the stopped turn once Codex writes its closing line', async () => {
    expect(existsSync(HOOK), 'build the hook first: npm run build').toBe(true);
    const lines = fixtureLines('paginated');
    const session = readMeta(fixture('paginated'))!.sessionId;
    const first = lines.findIndex(({ record }) => payloadOf(record)['type'] === 'task_started');
    const turnId = payloadOf(lines[first]!.record)['turn_id'] as string;
    const closing = lines.findIndex(({ record }) => payloadOf(record)['type'] === 'task_complete');
    const codex = join(home.path, '.codex');
    const rollout = rolloutIn(codex, session);
    writeFileSync(rollout, lines.slice(0, closing).map(({ text }) => `${text}\n`).join(''));
    const ran = await runHook(
      {
        session_id: session,
        turn_id: turnId,
        transcript_path: rollout,
        cwd: home.path,
        hook_event_name: 'Stop',
        model: 'gpt-5.5-codex',
        permission_mode: 'default',
        stop_hook_active: false,
        last_assistant_message: 'FAKE reply',
      },
      { TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: endpoint },
    );
    expect(ran).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(ran.ms).toBeLessThan(1500);
    // Codex writes the turn's closing line once its Stop hooks have returned.
    appendFileSync(rollout, `${lines[closing]!.text}\n`);
    const state = join(codex, 'telmoni', `${session}.json`);
    expect(await until(() => offsetOf(state) === statSync(rollout).size, 20_000)).toBe(true);
    expect(ingest.received).toHaveLength(1);
    const bodies = ingest.received.map((request) => request.body).join('');
    for (const text of [...CONTENT, home.path]) expect(bodies).not.toContain(text);
    const runs = ingest.spans().filter((span) => span.name === 'invoke_agent codex');
    expect(runs.map((span) => attributesOf(span)['telmoni.run_id'])).toEqual([runIdOf(session, turnId)]);
    expect(refusalsIn(ingest.spans())).toEqual([]);
    expect(existsSync(join(codex, 'telmoni', 'hook.log'))).toBe(false);
  }, 30_000);

  it('sends a name past ingest’s caps cut to them, so no span of the turn is refused', async () => {
    const session = readMeta(fixture('paginated'))!.sessionId;
    const codex = join(home.path, '.codex');
    const rollout = rolloutIn(codex, session);
    const server = 's'.repeat(150);
    const model = 'm'.repeat(200);
    writeFileSync(
      rollout,
      readFileSync(fixture('paginated'), 'utf8').replaceAll('mcp__docs__', `mcp__${server}__`).replaceAll('"docs"', `"${server}"`).replaceAll('gpt-5.5-codex', model),
    );
    const ran = await runHook(
      { session_id: session, transcript_path: rollout, cwd: home.path, hook_event_name: 'SessionEnd', reason: 'other' },
      { TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: endpoint },
    );
    expect(ran).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await until(() => offsetOf(join(codex, 'telmoni', `${session}.json`)) === statSync(rollout).size, 20_000)).toBe(true);
    const spans = ingest.spans();
    expect(refusalsIn(spans)).toEqual([]);
    const tools = spans.map((span) => attributesOf(span)['gen_ai.tool.name']).filter((name) => name !== undefined);
    expect(tools).toContain(`mcp__${server}__search`.slice(0, 128));
    const models = new Set(spans.map((span) => attributesOf(span)['gen_ai.request.model']).filter((name) => name !== undefined));
    expect([...models]).toEqual([model.slice(0, 123)]);
    expect(existsSync(join(codex, 'telmoni', 'hook.log'))).toBe(false);
  }, 30_000);

  it('reads its key from the plugin’s own file, in the folder Codex runs with, and sends what a session left at its end', async () => {
    const codex = join(home.path, 'elsewhere');
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, 'telmoni.json'), JSON.stringify({ apiKey: 'telmoni_test', endpoint }), { mode: 0o600 });
    const session = readMeta(fixture('legacy'))!.sessionId;
    const rollout = rolloutIn(codex, session);
    writeFileSync(rollout, readFileSync(fixture('legacy')));
    const ran = await runHook(
      { session_id: session, transcript_path: rollout, cwd: home.path, hook_event_name: 'SessionEnd', reason: 'other' },
      { CODEX_HOME: codex },
    );
    expect(ran).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(ran.ms).toBeLessThan(1500);
    expect(await until(() => offsetOf(join(codex, 'telmoni', `${session}.json`)) === statSync(rollout).size, 20_000)).toBe(true);
    expect(ingest.received).toHaveLength(4);
    expect(refusalsIn(ingest.spans())).toEqual([]);
    expect(ingest.received.every((request) => request.headers['authorization'] === 'Bearer telmoni_test')).toBe(true);
    expect(existsSync(join(home.path, '.codex'))).toBe(false);
  }, 30_000);

  it('sends nothing without a key, and says so in its log once, with nothing from the session', async () => {
    const session = readMeta(fixture('legacy'))!.sessionId;
    const codex = join(home.path, '.codex');
    const rollout = rolloutIn(codex, session);
    writeFileSync(rollout, readFileSync(fixture('legacy')));
    const input = { session_id: session, transcript_path: rollout, cwd: home.path, hook_event_name: 'SessionEnd', reason: 'other' };
    const log = join(codex, 'telmoni', 'hook.log');
    expect(await runHook(input, {})).toMatchObject({ code: 0, stdout: '' });
    expect(await until(() => existsSync(log), 10_000)).toBe(true);
    expect(await runHook(input, {})).toMatchObject({ code: 0, stdout: '' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const written = readFileSync(log, 'utf8');
    expect(written.trim().split('\n')).toHaveLength(1);
    expect(written).toMatch(/SessionEnd [0-9a-f]{8}: no key/);
    for (const text of [...CONTENT, home.path]) expect(written).not.toContain(text);
    expect(ingest.received).toEqual([]);
  }, 30_000);

  it('logs input it does not understand, sends nothing, and still exits 0', async () => {
    const codex = join(home.path, '.codex');
    const ran = await runHook({ hook_event_name: 'Stop', session_id: '../../etc' }, {});
    expect(ran).toMatchObject({ code: 0, stdout: '' });
    expect(readFileSync(join(codex, 'telmoni', 'hook.log'), 'utf8')).toMatch(/hook input not understood/);
    expect(ingest.received).toEqual([]);
  });

  it('leaves a session that keeps no rollout alone, logging nothing', async () => {
    const ran = await runHook(
      {
        session_id: '01a12f57-06f8-7000-8000-010123456789',
        turn_id: '01a12f57-1e68-7000-8000-0a0123456789',
        transcript_path: null,
        cwd: home.path,
        hook_event_name: 'Stop',
        model: 'gpt-5.5-codex',
        permission_mode: 'default',
        stop_hook_active: false,
        last_assistant_message: null,
      },
      { TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: endpoint },
    );
    expect(ran).toMatchObject({ code: 0, stdout: '' });
    expect(existsSync(join(home.path, '.codex'))).toBe(false);
  });
});
