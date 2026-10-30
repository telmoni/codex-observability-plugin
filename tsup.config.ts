import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { hook: 'src/hook.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  // The SDK inside: Codex installs no dependencies and runs no scripts, so the hook finds nothing in node_modules.
  noExternal: [/.*/],
  // Codex waits on every hook, and evaluating the SDK costs one some 50 ms: the sending code, imported only by the
  // detached copy, comes out as chunks beside the hook that the hook itself never loads.
  splitting: true,
  clean: true,
});
