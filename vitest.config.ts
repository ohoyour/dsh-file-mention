import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Pre-transform standard TypeScript decorators before Vite's default parser
 * sees source files (the same plugin the deepseek-harness checkout uses in
 * vitest.shared.ts): Vite 8's oxc transform cannot parse stage-3 decorators,
 * so the `@Remote('list')` marker is transpiled away with `ts.transpileModule`
 * first.
 */
function standardDecoratorPlugin() {
  return {
    name: 'file-mention-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    // Default include so each package's `vitest run tests` discovers its own
    // tests relative to the package directory.
    environment: 'node',
  },
})
