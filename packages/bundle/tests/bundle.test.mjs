import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('cordis.patch.yml inserts both composition rows', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: file-mention-host/)
  assert.match(patch, /name: '@ohoyo\/dsh-file-mention-host'/)
  assert.match(patch, /id: client-file-mention/)
  assert.match(patch, /name: '@ohoyo\/dsh-client-ui-file-mention'/)
})

test('package.json declares the bundle patch metadata', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dependencies['@ohoyo/dsh-file-mention-host'], 'workspace:^')
  assert.equal(pkg.dependencies['@ohoyo/dsh-client-ui-file-mention'], 'workspace:^')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./package.json'], './package.json')
})

test('the Host package exposes its Typert registration artifact', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../host/package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./typert'].default, './lib/typert.host.js')
  assert.equal(pkg.exports['./typert'].types, './lib/typert.host.d.ts')
  assert.ok(pkg.files.includes('lib/typert.host.js'))
  assert.ok(pkg.files.includes('lib/typert.host.d.ts'))
})
