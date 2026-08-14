import { defineConfig } from 'tsdown'

const ID = '@ohoyo/dsh-client-ui-file-mention'

/**
 * Two artifacts:
 * 1. The node half (`lib/index.js` + dts): an empty host plugin so the
 *    composition row mounts; the modules node half serves the browser bundle
 *    via the package.json `dsh.client` declaration and exports["./client"].
 * 2. The browser bundle (`lib/client.js`): a CJS factory-form artifact that
 *    registers itself through `window.__ModuleLoader__.load({ id, factory })`
 *    — the exact recipe of the harness `clientBundle` preset (see
 *    packages/client/tsdown.client.ts in the deepseek-harness checkout).
 *    `zod` (the contribution codec schemas) is inlined; every @deepseek-ai
 *    import in this package is type-only and erased, so nothing crosses the
 *    bundle purity gate.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
    outputOptions: {
      entryFileNames: 'index.js',
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
