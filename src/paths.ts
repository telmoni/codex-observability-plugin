/**
 * Where the plugin keeps what it needs: the key file in Codex's own folder, beside its `auth.json`, and the plugin's
 * state in the data folder Codex gives the plugin's hooks, which an update leaves alone.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { absoluteFrom } from './shared/settings.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Codex's folder: `CODEX_HOME` where it names an absolute one, as Codex reads it, else `~/.codex`. */
export function codexHome(env: Env, home: string = homedir()): string {
  return absoluteFrom(env, 'CODEX_HOME') ?? join(home, '.codex');
}

/** `{"apiKey": "tm_…"}`, read only while it is the person's own and shut to everyone else. */
export function keyFile(env: Env, home?: string): string {
  return join(codexHome(env, home), 'telmoni.json');
}

/**
 * The plugin's own folder: each session's state and lock, and `hook.log`. Codex's `PLUGIN_DATA` for a hook run from
 * the installed plugin; else, for one wired in by hand, `telmoni/` in Codex's folder.
 */
export function stateDir(env: Env, home?: string): string {
  return absoluteFrom(env, 'PLUGIN_DATA') ?? join(codexHome(env, home), 'telmoni');
}
