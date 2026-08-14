/**
 * Smoke test for the BUILT browser bundle (`packages/client/lib/client.js`):
 * evaluates the factory-form artifact the way the client module system does,
 * then drives its `apply` with a real Cordis context plus fakes for the
 * `remote` and `inputTriggers` services. Catches bundle-level breakage
 * (zod inlining, CJS interop, contribution shape) before browser debugging.
 *
 * Run after `pnpm build`:
 *   node scripts/smoke-client-bundle.mjs
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')

const FIXTURE = [
  { type: 'directory', path: 'warning-disposal-report', name: 'warning-disposal-report', dir: '' },
  { type: 'file', path: 'warning-disposal-report/index.vue', name: 'index.vue', dir: 'warning-disposal-report' },
]

const code = await readFile(new URL('../packages/client/lib/client.js', import.meta.url), 'utf8')

// ── 1. Evaluate the classic-script bundle exactly like the module system ─────
let handoff
const fn = new Function('window', code)
fn({ __ModuleLoader__: { load: (value) => { handoff = value } } })
if (handoff === undefined) throw new Error('bundle did not register through __ModuleLoader__.load')
if (handoff.id !== '@ohoyo/dsh-client-ui-file-mention') {
  throw new Error(`unexpected bundle id ${handoff.id}`)
}
const plugin = handoff.factory(() => { throw new Error('unexpected require() in bundle') })
console.log('bundle exports:', Object.keys(plugin).join(', '), '| inject:', JSON.stringify(plugin.inject))

// ── 2. Drive apply with a real Context and fakes ─────────────────────────────
const root = new Context()
let mounted = 0
root.provide('remote', {
  $mount: async () => { mounted += 1; return async () => {} },
})
root.provide('remote.fileIndex', {
  list: async (sessionId, request) => {
    console.log('  remote call:', sessionId, JSON.stringify(request))
    return { ok: true, value: { files: FIXTURE } }
  },
})
const sources = []
root.provide('inputTriggers', {
  registerSource: (source) => { sources.push(source); return () => {} },
})

const fiber = root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
await fiber
console.log('mounted contributions:', mounted, '| registered sources:', sources.length)

if (sources.length !== 1) throw new Error('expected exactly one registered source')
const source = sources[0]
if (source.trigger !== '@' || source.name !== 'file') {
  throw new Error(`unexpected source identity ${source.trigger}/${source.name}`)
}
source.warm?.({ sessionId: 's1' })
const candidates = await source.candidates(
  { sessionId: 's1' },
  { query: 'warning', position: 'leading', signal: new AbortController().signal },
)
console.log('candidates:', JSON.stringify(candidates))
if (candidates.length !== 2 || candidates[0].name !== 'warning-disposal-report/') {
  throw new Error('unexpected candidates')
}
const picked = source.onPick({
  candidate: { name: 'warning-disposal-report/' },
  session: { sessionId: 's1' },
  position: 'leading',
  via: 'menu',
  span: { start: 0, end: 1, draftRev: 1 },
})
console.log('dir pick:', JSON.stringify(picked))
if (picked.insert.label !== '📁 warning-disposal-report/') throw new Error('unexpected pick label')
if (picked.insert.clipboardText !== 'warning-disposal-report/') throw new Error('unexpected clipboard text')
const serialized = await source.codec.serialize(picked.insert.ref, new AbortController().signal)
console.log('serialized model form:', JSON.stringify(serialized))
if (serialized !== '@warning-disposal-report ') throw new Error('unexpected serialized form')
const roll = source.lexicon?.({ sessionId: 's1' })
console.log('lexicon roll:', JSON.stringify(roll))
if (roll === undefined || !roll.includes('warning-disposal-report-index-vue')) {
  throw new Error('lexicon roll missing flattened mention names')
}
console.log('SMOKE OK')
