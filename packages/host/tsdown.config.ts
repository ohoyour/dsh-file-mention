import { defineConfig } from 'tsdown'

/**
 * Two-phase build (the harness pattern): tsc first compiles `src` into
 * `lib/types` — downleveling the standard `@Remote` decorators to the
 * `__esDecorate` helpers the Node runtime understands — then tsdown bundles
 * that JavaScript into `lib/index.js`.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  // lib/types is tsc's output directory: never wipe it here.
  clean: false,
  sourcemap: true,
  // Pin the artifact name to lib/index.js (the package exports reference it;
  // tsdown otherwise emits .mjs).
  outputOptions: {
    entryFileNames: 'index.js',
  },
  // Keep every @deepseek-ai dependency external: they resolve from the
  // deployment's own module tree at load time, matching its exact versions.
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
})
