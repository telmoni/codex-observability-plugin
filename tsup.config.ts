import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { hook: 'src/hook.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  // One file with the SDK and OpenTelemetry inside it: Codex fetches the
  // package with `npm pack`, installs no dependencies and runs no scripts, so
  // the hook finds nothing in node_modules when it runs.
  noExternal: [/.*/],
  // OpenTelemetry's resources load their machine-id helpers by dynamic
  // import, which would otherwise come out as chunks beside the hook.
  splitting: false,
  clean: true,
});
