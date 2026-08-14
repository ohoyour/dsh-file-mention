/**
 * Remove the machine-local dependency overrides written by link-local-checkout.
 * The committed workspace file intentionally contains only registry settings.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const ws = new URL('../pnpm-workspace.yaml', import.meta.url)
const text = readFileSync(ws, 'utf8')
const marker = '# Local-checkout linkage'
const index = text.indexOf(marker)

if (index === -1) {
  console.log('unlink-local-checkout: no local checkout overrides found')
} else {
  writeFileSync(ws, `${text.slice(0, index).trimEnd()}\n`)
  console.log('unlink-local-checkout: registry dependencies restored')
}
