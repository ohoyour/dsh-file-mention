import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.local-pack')
const packages = [
  '@ohoyo/dsh-file-mention-host',
  '@ohoyo/dsh-client-ui-file-mention',
  '@ohoyo/dsh-file-mention',
]

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const packageName of packages) {
  const args = ['--filter', packageName, 'pack', '--pack-destination', output]
  const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm', ...args.map(arg => /\s/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)]
    : args
  await execFileAsync(command, commandArgs, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  })
}
console.log(`pack:local: tarballs written to ${output}`)
