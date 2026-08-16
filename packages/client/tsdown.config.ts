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
    minify: true,
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle purity gate (mirror of the harness clientBundle preset): every
      // @deepseek-ai import in the browser bundle must be type-only and erased
      // before bundling. A value import would inline a duplicate host-side
      // runtime instance or require a module-table entry this bundle does not
      // declare — fail the build instead of shipping it.
      name: 'file-mention-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        throw new Error(
          `file-mention client bundle purity: "${source}" is not allowed as a value `
          + 'import — all @deepseek-ai imports must be type-only (erased at build); '
          + 'collaborate with harness plugins through cordis services',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
