/**
 * The hook Codex runs at `Stop`, `SubagentStop`, `Interrupt` and `SessionEnd`: it hands what it is given to a detached
 * copy of itself and exits at once with nothing on stdout, which Codex could take as a decision; the copy sends (`session.ts`).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handedOff, inputFrom } from './input.js';
import { kindOf, log } from './log.js';
import { settingsFrom } from './settings.js';

/** How the detached copy is handed its input: in its environment, never on its command line, which anyone on the machine may list. */
const HANDOFF = 'TELMONI_CODEX_HOOK_INPUT';
const MAX_INPUT_BYTES = 1024 * 1024;
/** Under the shortest timeout Codex is asked to give a hook, three seconds at `SessionEnd`. */
const INPUT_WAIT_MS = 2_000;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      // A stdin left open would hold the process, and the session with it, until Codex killed the hook at its timeout.
      process.stdin.destroy();
      reject(Object.assign(new Error('no hook input'), { name: 'NoHookInput' }));
    }, INPUT_WAIT_MS);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        clearTimeout(timer);
        reject(new RangeError('hook input too large'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const handed = process.env[HANDOFF];
// Set once the settings are read: a hook that cannot read them has nowhere to say so.
let dir: string | undefined;

try {
  const settings = settingsFrom(process.env);
  dir = settings.dir;
  if (handed === undefined) {
    const input = inputFrom(JSON.parse(await readStdin()));
    if (input === undefined) {
      log(settings.dir, 'hook input not understood; nothing sent');
    } else if (input.rolloutPath !== undefined) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, [HANDOFF]: JSON.stringify(input) },
      });
      child.on('error', (error) => log(settings.dir, `${input.event}: could not start the sender: ${kindOf(error)}`));
      child.unref();
    }
    // Without a rollout — an ephemeral session — there is nothing to read.
  } else {
    const input = handedOff(JSON.parse(handed));
    if (input !== undefined) {
      // Only the detached copy loads the SDK: Codex waits on the hook, and OpenTelemetry costs it some 50 ms.
      const [{ sync }, { Sender }] = await Promise.all([import('./session.js'), import('./send.js')]);
      const tag = `${input.event} ${input.threadId.slice(0, 8)}:`;
      const write = (line: string): void => log(settings.dir, `${tag} ${line}`);
      try {
        await sync(input, settings, { sender: (destination) => new Sender(destination, write), log: write });
      } catch (error) {
        write(`failed: ${kindOf(error)}`);
      }
    }
  }
} catch (error) {
  if (dir !== undefined) log(dir, `failed: ${kindOf(error)}`);
}
// Nothing the session could see: whatever happened is in hook.log.
process.exitCode = 0;
