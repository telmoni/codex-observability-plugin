import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runIdOf } from '../src/record.js';
import {
  KEY,
  Rollout,
  SECRETS,
  SESSION,
  assertMetadataOnly,
  keptText,
  makeHome,
  pluginDir,
} from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(ROOT, 'dist', 'hook.mjs');

/** The command `hooks/hooks.json` gives `Stop`, as Codex runs it. */
const COMMAND = (
  JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  }
).hooks.Stop[0]!.hooks[0]!.command;

/**
 * Runs the hook as Codex does: its command through the shell, in the session's folder, the plugin's root in
 * `PLUGIN_ROOT`, the payload on stdin.
 */
function runHook(
  input: string,
  env: Record<string, string>,
  cwd: string = ROOT,
): { status: number | null; stdout: string; ms: number } {
  const started = Date.now();
  const result = spawnSync('/bin/sh', ['-c', COMMAND], {
    cwd,
    input,
    env: { PATH: process.env.PATH ?? '', PLUGIN_ROOT: ROOT, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, ms: Date.now() - started };
}

async function until(done: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return done();
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** Telmoni's ingest on this machine, keeping each export's body. */
async function telmoni(): Promise<{ endpoint: string; bodies: string[] }> {
  const bodies: string[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      bodies.push(body);
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Telmoni-Content-Mode': 'off',
      });
      response.end('{"partialSuccess":null}');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { endpoint: `http://127.0.0.1:${address.port}`, bodies };
}

describe.skipIf(process.platform === 'win32')('the hook, as Codex runs it', () => {
  beforeAll(() => {
    expect(existsSync(HOOK), 'npm run build first').toBe(true);
  });

  it.each(['', 'not json', '[]', '{}', JSON.stringify({ session_id: SESSION })])(
    'prints nothing and exits 0 for %j',
    (input) => {
      const home = makeHome();
      const result = runHook(input, { HOME: home });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    },
  );

  it('exits 0 where node is missing', () => {
    const result = spawnSync('/bin/sh', ['-c', COMMAND], {
      input: '{}',
      env: { PATH: '/nonexistent', PLUGIN_ROOT: ROOT },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('hands the stop to its worker and returns at once; the worker sends the turn', async () => {
    const home = makeHome();
    const { endpoint, bodies } = await telmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.turn(1);
    const result = runHook(
      JSON.stringify(rollout.stopPayload()),
      { HOME: home, TELMONI_API_KEY: KEY, TELMONI_ENDPOINT: endpoint },
      rollout.cwd,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    // Before the worker's own settle wait is up: the hook never waits on it.
    expect(result.ms).toBeLessThan(2_000);
    expect(await until(() => bodies.some((body) => body.includes(runIdOf(SESSION, turnId))))).toBe(
      true,
    );
    const state = join(pluginDir(home), `${SESSION}.json`);
    expect(
      await until(
        () =>
          existsSync(state) &&
          (JSON.parse(readFileSync(state, 'utf8')) as { sent: string[] }).sent.length === 1,
      ),
    ).toBe(true);
    assertMetadataOnly(bodies.join('\n') + keptText(home), [rollout.path, rollout.cwd]);
  });

  it('starts a worker that says, once, that there is no key', async () => {
    const home = makeHome();
    const rollout = new Rollout(home);
    rollout.turn(0);
    const result = runHook(JSON.stringify(rollout.stopPayload()), { HOME: home });
    expect(result.status).toBe(0);
    const log = join(pluginDir(home), 'hook.log');
    expect(await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('no key'))).toBe(
      true,
    );
    expect(readFileSync(log, 'utf8')).not.toContain(SECRETS.lastReply);
  });
});
