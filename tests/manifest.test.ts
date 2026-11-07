import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;

interface Handler {
  type: string;
  command: string;
  commandWindows?: string;
  timeout?: number;
}

describe('the manifest', () => {
  const plugin = json('.codex-plugin/plugin.json');
  const face = plugin.interface as Record<string, unknown>;

  it('agrees with package.json on the version, a plain X.Y.Z, which names the installed copy', () => {
    expect(plugin.version).toBe(json('package.json').version);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names the plugin and its skills as Codex reads them', () => {
    expect(plugin.name).toBe('telmoni-observability');
    expect(plugin.skills).toBe('./skills/');
    // The hooks are found at `hooks/hooks.json`: a `hooks` field would replace that, not add to it.
    expect(plugin.hooks).toBeUndefined();
  });

  it('gives Codex its page: the names, the category, the logo and three prompts at most', () => {
    for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName'])
      expect(typeof face[field] === 'string' && face[field] !== '', field).toBe(true);
    expect(face.category).toBe('Developer Tools');
    for (const asset of [face.logo, face.composerIcon]) {
      expect(String(asset)).toMatch(/^\.\//);
      expect(existsSync(join(ROOT, String(asset)))).toBe(true);
    }
    const prompts = face.defaultPrompt as unknown[];
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const prompt of prompts)
      expect(typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 128).toBe(true);
  });
});

describe('the marketplace', () => {
  it('is this repository, `telmoni-plugins`, naming the plugin at its root', () => {
    const market = json('.agents/plugins/marketplace.json');
    expect(market.name).toBe('telmoni-plugins');
    const plugins = market.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      name: 'telmoni-observability',
      source: { source: 'local', path: './' },
      policy: { installation: 'AVAILABLE' },
      category: 'Developer Tools',
    });
  });
});

describe('the hooks', () => {
  const hooks = json('hooks/hooks.json').hooks as Record<string, Array<{ hooks: Handler[] }>>;

  it('run at a turn’s end and the session’s, nowhere else', () => {
    expect(Object.keys(hooks).sort()).toEqual(['SessionEnd', 'Stop']);
  });

  it('run the bundled hook from the plugin’s root, never failing a turn, on Windows too', () => {
    for (const groups of Object.values(hooks)) {
      const handlers = groups.flatMap((group) => group.hooks);
      expect(handlers).toHaveLength(1);
      expect(handlers[0]).toMatchObject({
        type: 'command',
        command: 'node "${PLUGIN_ROOT}/dist/hook.mjs" || true',
        commandWindows: 'node "%PLUGIN_ROOT%\\dist\\hook.mjs" || exit /b 0',
      });
    }
  });

  it('give SessionEnd no more than the 3 s Codex allows it', () => {
    expect(hooks.SessionEnd![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(3);
  });
});

describe('the skill', () => {
  it('is named as its folder, its description within the limits', () => {
    const text = readFileSync(join(ROOT, 'skills', 'telmoni-observability', 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('telmoni-observability');
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(text)).toBeLessThan(24 * 1024);
  });
});

describe('the bundle', () => {
  it('is two files, the hook and its worker, the hook without the SDK', () => {
    // Splitting would add a file for each dynamic import met, OpenTelemetry's machine-id detectors among them, loaded by nothing.
    expect(readdirSync(join(ROOT, 'dist')).sort()).toEqual(['hook.mjs', 'worker.mjs']);
    // Codex waits on the hook: it starts the worker, which alone loads the SDK.
    expect(readFileSync(join(ROOT, 'dist', 'hook.mjs'), 'utf8')).not.toMatch(
      /opentelemetry|telmoni\/sdk/,
    );
  });
});
