import { existsSync } from 'node:fs'

for (const file of ['lib/index.js', 'cordis.patch.yml']) {
  if (!existsSync(file)) throw new Error(`bundle prepare: required artifact is missing: ${file}`)
}

console.log('bundle prepare: committed entry and patch are present')
