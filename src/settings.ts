/**
 * Where the plugin sends and keeps its state: `TELMONI_API_KEY` and `TELMONI_ENDPOINT` as Codex hands its hooks them,
 * else the plugin's own `~/.codex/telmoni.json`, since Codex keeps no settings for a plugin's hooks; a key always with
 * the endpoint named beside it.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { kindOf } from './log.js';
import { fieldsOf } from './rollout.js';

export interface Settings {
  apiKey: string | undefined;
  /** Unset, the SDK's own default, Telmoni's machine host. */
  endpoint: string | undefined;
  /** The plugin's folder: each thread's state, the locks and `hook.log`. */
  dir: string;
  /** The key file as the log names it, by `CODEX_HOME` where that is set: the log holds no path. */
  keyFileName: string;
  /** What kept `telmoni.json` from being read, where it is there and was not. */
  keyFileProblem?: string;
}

/** A file this size is not the plugin's two settings. */
const MAX_FILE_BYTES = 64 * 1024;

function value(found: unknown): string | undefined {
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : undefined;
}

/**
 * `{ "apiKey", "endpoint" }`, read only where it is the person's own and shut to everyone else, as `ssh` reads a key: one
 * others could write could name an endpoint of theirs, and the key would go to it.
 */
function fromFile(path: string): { apiKey?: string | undefined; endpoint?: string | undefined; problem?: string } {
  let fd: number;
  try {
    // Without blocking, so a FIFO at the path cannot hold the hook until something writes to it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    if (code === 'EISDIR') return { problem: 'not a file' };
    return { problem: `unreadable (${kindOf(error)})` };
  }
  try {
    // Checked on the descriptor it is read from, so the file checked is the file read.
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'not a file' };
    if (process.platform !== 'win32') {
      // The owner first: another's file is not the person's to chmod.
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) return { problem: 'owned by another user' };
      if ((stat.mode & 0o077) !== 0) return { problem: 'open to other users; chmod 600 it' };
    }
    if (stat.size > MAX_FILE_BYTES) return { problem: 'too large' };
    const fields = fieldsOf(JSON.parse(readFileSync(fd, 'utf8')));
    if (fields === undefined) return { problem: 'not a JSON object' };
    // Passed over as unset, an endpoint meant would give way to the default, and the key go there.
    for (const field of ['apiKey', 'endpoint']) {
      if (fields[field] !== undefined && value(fields[field]) === undefined) return { problem: `${field} empty or not a string` };
    }
    return { apiKey: value(fields['apiKey']), endpoint: value(fields['endpoint']) };
  } catch (error) {
    return { problem: error instanceof SyntaxError ? 'not JSON' : `unreadable (${kindOf(error)})` };
  } finally {
    closeSync(fd);
  }
}

export function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  // Beside the rollouts of whichever folder Codex runs with, `CODEX_HOME` or `~/.codex`, so two installations keep two
  // states; a relative one would put them under the session's working folder.
  const given = value(env['CODEX_HOME']);
  const home = given !== undefined && isAbsolute(given) ? given : undefined;
  const codex = home ?? join(homedir(), '.codex');
  const base = { dir: join(codex, 'telmoni'), keyFileName: home === undefined ? '~/.codex/telmoni.json' : '$CODEX_HOME/telmoni.json' };
  const apiKey = value(env['TELMONI_API_KEY']);
  // A key goes only to the endpoint named beside it: the environment's with the environment's, the file's with the file's.
  if (apiKey !== undefined) return { ...base, apiKey, endpoint: value(env['TELMONI_ENDPOINT']) };
  const file = fromFile(join(codex, 'telmoni.json'));
  const settings: Settings = { ...base, apiKey: file.apiKey, endpoint: file.endpoint };
  if (file.problem !== undefined) settings.keyFileProblem = file.problem;
  return settings;
}
