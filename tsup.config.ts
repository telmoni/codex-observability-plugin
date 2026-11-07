import { defineConfig } from 'tsup';

// Codex copies the plugin as it finds it and builds nothing, so `dist/` is committed: two self-contained ESM files,
// `hook.mjs` and `worker.mjs`, as the other Telmoni plugins' builds make. Unsplit, since splitting writes a file for
// every dynamic import it meets, OpenTelemetry's machine-id detectors among them, imported by nothing. The hook holds
// no SDK all the same: it imports none.
export default defineConfig({
  entry: { hook: 'src/cli/hook.ts', worker: 'src/cli/worker.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  splitting: false,
  noExternal: [/.*/],
  // Readable stack traces in a bug report.
  minify: false,
  sourcemap: false,
  clean: true,
});
