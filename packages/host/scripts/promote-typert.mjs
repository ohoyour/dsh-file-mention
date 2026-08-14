import { copyFile } from 'node:fs/promises'

for (const file of [
  'typert.host.js',
  'typert.host.js.map',
  'typert.host.d.ts',
  'typert.host.d.ts.map',
]) {
  await copyFile(`lib/types/${file}`, `lib/${file}`)
}

console.log('host build: promoted lib/types/typert.host.* to lib/')
