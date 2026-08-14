import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
if (tag === undefined || tag.trim() === '') {
  throw new Error('release:check requires a version tag, for example v0.1.0')
}

const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag.trim())
if (match === null) throw new Error(`release:check: invalid version tag: ${tag}`)
const expected = match[1]
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const packages = ['packages/host/package.json', 'packages/client/package.json', 'packages/bundle/package.json']
for (const relative of packages) {
  const packageJson = JSON.parse(await readFile(resolve(root, relative), 'utf8'))
  if (packageJson.version !== expected) {
    throw new Error(`release:check: ${relative} is ${packageJson.version}, expected ${expected}`)
  }
}

console.log(`release:check: ${packages.length} packages match ${expected}`)
