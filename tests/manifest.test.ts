/**
 * The manifests, held to what Codex reads: Codex ships no validator for a
 * plugin or a marketplace, so the suites check them.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;
}

const pkg = json('package.json');
const plugin = json('.codex-plugin/plugin.json');
const marketplace = json('.agents/plugins/marketplace.json');
const hooks = json('hooks/hooks.json');

describe('the plugin', () => {
  it('is named as its marketplace lists it, never as the skill is, and versioned as its package', () => {
    expect(plugin['name']).toBe('telmoni-observability');
    expect(plugin['version']).toBe(pkg['version']);
    expect(plugin['hooks']).toBe('./hooks/hooks.json');
    const display = (plugin['interface'] as Record<string, unknown>)['displayName'];
    expect(display).toBe('Telmoni Observability');
    const plugins = marketplace['plugins'] as Array<Record<string, unknown>>;
    expect(marketplace['name']).toBe('telmoni-plugins');
    expect(plugins).toEqual([
      expect.objectContaining({
        name: plugin['name'],
        source: { source: 'npm', package: pkg['name'] },
        policy: expect.objectContaining({ installation: 'AVAILABLE' }) as unknown,
        category: expect.any(String) as unknown,
      }),
    ]);
  });

  it('runs one hook at Stop, SubagentStop, Interrupt and SessionEnd, inside each event’s time', () => {
    expect(Object.keys(hooks)).toEqual(['hooks']);
    const events = hooks['hooks'] as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    expect(Object.keys(events).sort()).toEqual(['Interrupt', 'SessionEnd', 'Stop', 'SubagentStop']);
    for (const [event, groups] of Object.entries(events)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBeUndefined();
      const [handler, ...others] = groups[0]!.hooks;
      expect(others).toEqual([]);
      // Codex substitutes ${PLUGIN_ROOT} itself, whatever the shell, and trusts the command as written: it never names a version.
      expect(handler).toMatchObject({ type: 'command', command: 'node "${PLUGIN_ROOT}/dist/hook.mjs"' });
      expect(handler!['async']).toBeUndefined();
      expect(handler!['timeout']).toBeGreaterThanOrEqual(1);
      // Codex holds SessionEnd's and Interrupt's hooks to three seconds at most.
      if (event === 'SessionEnd' || event === 'Interrupt') expect(handler!['timeout']).toBeLessThanOrEqual(3);
    }
  });
});

describe('the package', () => {
  it('is the plugin as built and nothing else, with nothing to install and no script to run', () => {
    expect(pkg['name']).toBe('@telmoni/codex-observability-plugin');
    expect(pkg['files']).toEqual(['.codex-plugin/plugin.json', 'hooks', 'dist']);
    expect(pkg['dependencies']).toBeUndefined();
    const scripts = pkg['scripts'] as Record<string, string>;
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      expect(scripts[script]).toBeUndefined();
    }
    type Packed = { files: Array<{ path: string }> };
    const output = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as Packed[] | Record<string, Packed>;
    // npm before 12 answers a list, npm 12 an object by the package's name.
    const packed = Array.isArray(output) ? output[0]! : Object.values(output)[0]!;
    expect(packed.files.map((file) => file.path).sort()).toEqual(
      ['.codex-plugin/plugin.json', 'LICENSE', 'dist/hook.mjs', 'hooks/hooks.json', 'package.json'].sort(),
    );
    // npm takes seconds to start.
  }, 30_000);

  it('bundles the hook into one file that needs nothing but Node', () => {
    expect(readdirSync(join(ROOT, 'dist'))).toEqual(['hook.mjs']);
    const bundle = readFileSync(join(ROOT, 'dist', 'hook.mjs'), 'utf8');
    const imported = [...bundle.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    expect(imported.filter((name) => !builtins.has(name!))).toEqual([]);
  });
});
