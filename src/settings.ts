/**
 * Where the plugin sends, and where it keeps its state. The key and the
 * endpoint are the SDKs' own variables, `TELMONI_API_KEY` and
 * `TELMONI_ENDPOINT`, in the environment Codex hands its hooks — Codex's own,
 * `~/.codex/.env` loaded into it — and, where those are unset, the plugin's
 * own file, `~/.codex/telmoni.json`, since Codex keeps no settings for a
 * plugin's hooks.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Settings {
  apiKey: string | undefined;
  /** Unset, the SDK's own default, Telmoni's machine host. */
  endpoint: string | undefined;
  /** The plugin's folder: each thread's state, the locks and `hook.log`. */
  dir: string;
}

/** A file this size is not the plugin's two settings. */
const MAX_FILE_BYTES = 64 * 1024;

function value(found: unknown): string | undefined {
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : undefined;
}

/** `{ "apiKey", "endpoint" }`; one unreadable, or not that, holds nothing. */
function fromFile(path: string): { apiKey?: string | undefined; endpoint?: string | undefined } {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const fields = parsed as Record<string, unknown>;
    return { apiKey: value(fields['apiKey']), endpoint: value(fields['endpoint']) };
  } catch {
    return {};
  }
}

/** The folder Codex runs with: `CODEX_HOME`, or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return value(env['CODEX_HOME']) ?? join(homedir(), '.codex');
}

export function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  // Beside the rollouts of whichever folder Codex runs with, so two
  // installations keep two states.
  const codex = codexHome(env);
  const file = fromFile(join(codex, 'telmoni.json'));
  return {
    apiKey: value(env['TELMONI_API_KEY']) ?? file.apiKey,
    endpoint: value(env['TELMONI_ENDPOINT']) ?? file.endpoint,
    dir: join(codex, 'telmoni'),
  };
}
