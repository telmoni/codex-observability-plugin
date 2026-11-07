/**
 * Codex has no validator for a plugin: the check is that a Codex adds this repository as a marketplace and installs the
 * plugin from it, in a Codex folder of the test's own. Run by `npm run validate`, which fails without a `codex`; skipped
 * by `npm test` where there is none.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CODEX = process.env.CODEX_BIN ?? 'codex';
const found = spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).status === 0;
const required = process.env.npm_lifecycle_event === 'validate';
/** What a clone holds and an install copies: everything but what `.gitignore` leaves out. */
const LEFT_OUT = new Set(['node_modules', 'coverage', '.git']);

const scratch = mkdtempSync(join(tmpdir(), 'telmoni-codex-install-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function codex(home: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(CODEX, args, {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe.skipIf(!found && !required)('Codex', () => {
  it('is there to install with', () => {
    expect(found, `no ${CODEX} on the PATH: install Codex, or name it in CODEX_BIN`).toBe(true);
  });

  // Two runs of Codex itself, and a copy of the checkout.
  it(
    'adds the repository as a marketplace and installs the plugin from it, hooks and all',
    { timeout: 120_000 },
    () => {
      const repository = join(scratch, 'codex-observability-plugin');
      for (const name of readdirSync(ROOT).filter((name) => !LEFT_OUT.has(name)))
        cpSync(join(ROOT, name), join(repository, name), { recursive: true });
      // Codex reads a `CODEX_HOME` only where the folder is there.
      const home = join(scratch, 'codex-home');
      mkdirSync(home);

      const added = codex(home, 'plugin', 'marketplace', 'add', repository);
      expect(added.status, added.output).toBe(0);
      const installed = codex(home, 'plugin', 'add', 'telmoni-observability@telmoni-plugins');
      expect(installed.status, installed.output).toBe(0);

      const version = (
        JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8')) as {
          version: string;
        }
      ).version;
      const copy = join(
        home,
        'plugins',
        'cache',
        'telmoni-plugins',
        'telmoni-observability',
        version,
      );
      for (const file of [
        '.codex-plugin/plugin.json',
        'hooks/hooks.json',
        'dist/hook.mjs',
        'dist/worker.mjs',
        'skills/telmoni-observability/SKILL.md',
        'assets/logo.png',
      ])
        expect(existsSync(join(copy, file)), file).toBe(true);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(
        /\[plugins\."telmoni-observability@telmoni-plugins"\]\s+enabled = true/,
      );
    },
  );
});
