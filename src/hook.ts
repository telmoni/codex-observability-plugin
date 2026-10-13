/**
 * The hook Codex runs at `Stop`, `SubagentStop`, `Interrupt` and `SessionEnd`.
 *
 * It reads what Codex hands it, starts a detached copy of itself with that,
 * and exits at once with nothing on stdout: the session never waits on the
 * network, a Telmoni that does not answer never slows it, and Codex reads
 * nothing from this hook it could take as a decision. The copy waits for the
 * turn's closing line, then sends what has ended (`session.ts`).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handedOff, inputFrom } from './input.js';
import { kindOf, log } from './log.js';
import { Sender } from './send.js';
import { sync } from './session.js';
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
    const timer = setTimeout(() => reject(new Error('no hook input')), INPUT_WAIT_MS);
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

const settings = settingsFrom(process.env);
const handed = process.env[HANDOFF];

try {
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
      const tag = `${input.event} ${input.threadId.slice(0, 8)}:`;
      const write = (line: string): void => log(settings.dir, `${tag} ${line}`);
      await sync(input, settings, { sender: (destination) => new Sender(destination, write), log: write });
    }
  }
} catch (error) {
  log(settings.dir, `failed: ${kindOf(error)}`);
}
// Nothing the session could see: whatever happened is in hook.log.
process.exitCode = 0;
