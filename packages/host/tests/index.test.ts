import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import FileIndexService, { Config, name, scanReferences, scanTokens } from '../src/index.ts'

// ── fake fs backend ──────────────────────────────────────────────────────────
//
// Target keys are absolute (`/ws/...`), mirroring the real backend's
// canonical absolute targetKey the plugin resolves against the session cwd.

const CWD = '/ws'

const TREE: Record<string, string> = {
  '/ws/warning-disposal-report/index.vue': '<template>report</template>',
  '/ws/warning-disposal-report/data.csv': 'a,b\n1,2\n',
  '/ws/warning-disposal-report/sub/note.md': '# note',
  '/ws/src/main.ts': 'export {}',
  '/ws/src/util/helper.ts': 'export const helper = 1\n',
  '/ws/src/util/tool.ts': 'export const tool = 2\n',
  '/ws/src/util/bin.dat': 'binary\x00payload\n',
  '/ws/src/util/big.txt': 'x'.repeat(100),
  '/ws/docs/a.md': '# a',
  '/ws/docs/b.md': '# b',
  '/ws/docs/c.md': '# c',
  '/ws/docs/d.md': '# d',
  '/ws/docs/e.md': '# e',
  '/ws/docs/f.md': '# f',
  '/ws/docs/space name.md': '# spaced',
  '/ws/many/f01.txt': '1',
  '/ws/many/f02.txt': '2',
  '/ws/many/f03.txt': '3',
  '/ws/many/f04.txt': '4',
  '/ws/many/f05.txt': '5',
  '/ws/many/f06.txt': '6',
  '/ws/many/f07.txt': '7',
  '/ws/many/f08.txt': '8',
  '/ws/many/f09.txt': '9',
  '/ws/many/f10.txt': '10',
  '/ws/node_modules/pkg/index.js': 'module.exports = 1\n',
}

interface SizeOverride { size?: number }

function fakeFs(files: Record<string, string>, sizes: Record<string, SizeOverride> = {}) {
  const dirs = new Set<string>()
  for (const file of Object.keys(files)) {
    let acc = ''
    for (const segment of file.split('/').slice(0, -1)) {
      if (segment === '') continue
      acc = acc === '' ? segment : `${acc}/${segment}`
      dirs.add(`/${acc}`)
    }
  }
  const children = (p: string): Array<{ name: string; type: 'file' | 'directory' }> => {
    const map = new Map<string, 'file' | 'directory'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(`${p}/`)) continue
      const rest = f.slice(p.length + 1)
      const first = rest.split('/')[0]!
      map.set(first, rest.includes('/') ? 'directory' : 'file')
    }
    for (const d of dirs) {
      if (d === p || !d.startsWith(`${p}/`)) continue
      const rest = d.slice(p.length + 1)
      if (!rest.includes('/')) map.set(rest, 'directory')
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entryName, type]) => ({ name: entryName, type }))
  }
  return {
    async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
      const base = path.startsWith('/') ? path : `${opts?.cwd ?? ''}/${path}`
      return { targetKey: base.replace(/\/+$/, ''), displayPath: base }
    },
    async stat(target: { targetKey: string }) {
      const p = target.targetKey
      if (Object.hasOwn(files, p)) {
        return { version: 'v', type: 'file' as const, size: sizes[p]?.size ?? files[p]!.length }
      }
      if (dirs.has(p)) return { version: 'v', type: 'directory' as const }
      return undefined
    },
    async listDir(target: { targetKey: string }) {
      const p = target.targetKey
      return children(p).map(({ name: entryName, type }) => ({
        name: entryName,
        type,
        target: { targetKey: `${p}/${entryName}`, displayPath: `${p}/${entryName}` },
        ...(type === 'file'
          ? { size: sizes[`${p}/${entryName}`]?.size ?? files[`${p}/${entryName}`]!.length }
          : {}),
      }))
    },
    async readText(target: { targetKey: string }) {
      const value = files[target.targetKey]
      if (value === undefined) throw new Error(`no such file: ${target.targetKey}`)
      return value
    },
    async streamText(target: { targetKey: string }) {
      const value = files[target.targetKey] ?? ''
      return (async function* () {
        yield value
      })()
    },
    contains(parent: { targetKey: string }, child: { targetKey: string }) {
      const root = parent.targetKey.replace(/\/+$/, '')
      const target = child.targetKey.replace(/\/+$/, '')
      return target === root || target.startsWith(`${root}/`)
    },
    processPath(target: { targetKey: string }) {
      return target.targetKey
    },
  }
}

function makeAgent(cwd: string): Agent {
  return { id: 'agent-1', session: { header: { cwd }, events: [] } } as unknown as Agent
}

function setup(config?: Config): { service: FileIndexService; agent: Agent } {
  const root = new Context()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root.provide('fs', fakeFs(TREE) as any)
  return { service: new FileIndexService(root, config), agent: makeAgent(CWD) }
}

function injectedTexts(decision: PreStepDecision): string[] {
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return []
  return decision.messages.slice(1).map(message => (
    message.content[0] as { type: 'text'; text: string }
  ).text)
}

const signal = (): AbortSignal => new AbortController().signal

// ── index tests (M1 acceptance: list returns files AND directories) ──────────

describe('FileIndexService.list', () => {
  it('exposes a class Config schema and applies deployment overrides', async () => {
    expect(FileIndexService.Config).toBe(Config)
    const defaults = Config()
    expect(defaults.indexTtlMs).toBe(15_000)
    expect(defaults.searchIndexLimit).toBe(100_000)
    expect(defaults.searchCacheEntries).toBe(4)

    const { service, agent } = setup({ ...defaults, indexLimit: 1, indexTtlMs: 1_234 })
    const result = await service.list(agent, { query: '' })
    expect(result.files).toHaveLength(1)
    expect(result.complete).toBe(false)
    expect(result.revision).toBe(0)
    expect(result.cacheTtlMs).toBe(1_234)
  })

  it('returns a full index including directory rows', async () => {
    const { service, agent } = setup()
    const result = await service.list(agent, { query: '' })
    expect(result.complete).toBe(true)
    expect(result.revision).toBe(0)
    const paths = result.files.map(row => row.path)
    expect(paths).toContain('warning-disposal-report')
    expect(paths).toContain('warning-disposal-report/sub')
    expect(paths).toContain('warning-disposal-report/index.vue')
    expect(paths).toContain('src/util')
    expect(paths.some(p => p.startsWith('node_modules'))).toBe(false)

    const dirRow = result.files.find(row => row.path === 'warning-disposal-report')
    expect(dirRow).toMatchObject({
      type: 'directory',
      name: 'warning-disposal-report',
      dir: '',
      mention: 'warning-disposal-report',
    })
    const fileRow = result.files.find(row => row.path === 'warning-disposal-report/index.vue')
    expect(fileRow).toMatchObject({
      type: 'file',
      name: 'index.vue',
      dir: 'warning-disposal-report',
      mention: 'warning-disposal-report-index-vue',
    })
  })

  it('searches beyond a capped snapshot for non-empty queries', async () => {
    const defaults = Config()
    const { service, agent } = setup({ ...defaults, indexLimit: 1 })
    const result = await service.list(agent, { query: 'space' })
    expect(result.files.map(row => row.path)).toContain('docs/space name.md')
    expect(result.complete).toBe(true)
    expect(result.files.find(row => row.path === 'docs/space name.md')).not.toHaveProperty('mention')
  })

  it('shares one search catalog across distinct queries', async () => {
    const root = new Context()
    const fs = fakeFs({ ...TREE })
    const listDir = vi.spyOn(fs, 'listDir')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fs as any)
    const service = new FileIndexService(root, { ...Config(), indexLimit: 1 })
    const agent = makeAgent(CWD)

    await service.list(agent, { query: '' })
    const afterSnapshot = listDir.mock.calls.length
    await service.list(agent, { query: 'space' })
    const afterFirstQuery = listDir.mock.calls.length
    await service.list(agent, { query: 'warning' })

    expect(afterFirstQuery).toBeGreaterThan(afterSnapshot)
    expect(listDir.mock.calls.length).toBe(afterFirstQuery)
  })

  it('filters and ranks a query (directory base first, then path length)', async () => {
    const { service, agent } = setup()
    const result = await service.list(agent, { query: 'warning' })
    expect(result.files.map(row => row.path)).toEqual([
      'warning-disposal-report',
      'warning-disposal-report/sub',
      'warning-disposal-report/data.csv',
      'warning-disposal-report/index.vue',
      'warning-disposal-report/sub/note.md',
    ])
  })

  it('returns an empty index when the session has no cwd', async () => {
    const { service, agent } = setup()
    const noCwd = { ...agent, session: { header: {}, events: [] } } as unknown as Agent
    await expect(service.list(noCwd, { query: '' })).resolves.toEqual({
      files: [],
      complete: true,
      revision: 0,
      cacheTtlMs: 15_000,
    })
  })

  it('invalidates the cached index after an explicit workspace change', async () => {
    const files = { ...TREE }
    const root = new Context()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fakeFs(files) as any)
    const service = new FileIndexService(root, { ...Config(), indexLimit: 1 })
    const agent = makeAgent(CWD)

    await service.list(agent, { query: '' })
    delete files['/ws/docs/a.md']
    const missing = await service.list(agent, { query: 'a.md' })
    expect(missing.files).toHaveLength(0)
    files['/ws/docs/a.md'] = '# restored'
    const staleQuery = await service.list(agent, { query: 'a.md' })
    expect(staleQuery.files).toHaveLength(0)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.emit(
      'fs/observed',
      { targetKey: '/ws/docs/a.md', displayPath: '/ws/docs/a.md' } as any,
      { kind: 'present', version: 'v' },
      { name: 'write' },
    )
    const rebuilt = await service.list(agent, { query: 'a.md' })
    expect(rebuilt.files.map(row => row.path)).toContain('docs/a.md')
    expect(rebuilt.revision).toBe(1)
  })

  it('does not inject an absolute path outside the workspace', async () => {
    const root = new Context()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fakeFs({ ...TREE, '/outside/secret.txt': 'private' }) as any)
    const service = new FileIndexService(root)
    const agent = makeAgent(CWD)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'read @/outside/secret.txt' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 2, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })
})

// ── pre-step injection tests ─────────────────────────────────────────────────

describe('FileIndexService pre-step injection', () => {
  it('enforces the per-turn context token budget', async () => {
    const defaults = Config()
    const { service, agent } = setup({ ...defaults, maxContextTokens: 1 })
    const user = createUserMessage({
      content: [{ type: 'text', text: 'inspect `docs/a.md`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 18, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('injects an exact structured reference, including paths with spaces', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'inspect @{docs/space name.md}' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 16, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('docs/space name.md')
    expect(texts[0]).toContain('# spaced')
  })

  it('does not suffix-match a missing structured path', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'inspect @{missing/index.vue}' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 17, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('injects <dir_context> for `short/` and <file_context> for files', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'check `src/util/`, @warning-disposal-report/index.vue and `src/main.ts`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 1, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(3)

    expect(texts[0]).toContain('<dir_context>')
    expect(texts[0]).toContain('The user referenced this workspace directory: src/util/ (4 files, 0 dirs; contents of 3 files included)')
    expect(texts[0]).toContain('[directory tree]')
    expect(texts[0]).toContain('helper.ts')
    expect(texts[0]).toContain('tool.ts')
    expect(texts[0]).toContain('[file contents]')
    expect(texts[0]).toContain('--- src/util/helper.ts ---')
    expect(texts[0]).toContain('export const helper = 1')
    // bin.dat is binary-sniffed: listed in the tree, excluded from contents.
    expect(texts[0]).not.toContain('--- src/util/bin.dat ---')

    expect(texts[1]).toContain('<file_context>')
    expect(texts[1]).toContain('The user referenced this workspace file: warning-disposal-report/index.vue. Its content:')
    expect(texts[1]).toContain('<template>report</template>')

    expect(texts[2]).toContain('<file_context>')
    expect(texts[2]).toContain('src/main.ts')
  })

  it('injects a directory context without a trailing slash too', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'look at `src/util`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 1, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('<dir_context>')
  })

  it('skips binary and oversized files in the dir snapshot and caps at 8 files', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'see `src/util/` and `many/`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 1, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(2)
    // src/util: bin.dat is binary-sniffed out of the contents (still in the
    // tree); big.txt is small, so 3 of 4 files contribute content.
    expect(texts[0]).toContain('contents of 3 files included')
    expect(texts[0]).not.toContain('--- src/util/bin.dat ---')
    // many/: 10 files, only the first 8 get contents.
    expect(texts[1]).toContain('contents of 8 files included')
    expect(texts[1]).not.toContain('--- many/f09.txt ---')
  })

  it('injects up to 5 references per turn', async () => {
    const { service, agent } = setup()
    const refs = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md', 'docs/f.md']
    const user = createUserMessage({
      content: [{ type: 'text', text: refs.map(ref => `\`${ref}\``).join(' ') }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 2, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(5)
  })

  it('deduplicates the same path within one turn', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: '`docs/a.md` `docs/a.md` @docs/a.md' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 3, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
  })

  it('injects nothing for unknown references, plain backticks, and dynamic plugin ids', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: '`missing-xyz` @nope-file `false` @abc-123' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 4, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('passes through reject decisions unchanged', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: '`docs/a.md`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 5, step: 1, signal: signal() },
      async () => ({ kind: 'reject' }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('keeps the original decision when the signal is aborted', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: '`docs/a.md`' }],
      source: { kind: 'user' },
    })
    const aborted = new AbortController()
    aborted.abort()
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 6, step: 1, signal: aborted.signal },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
  })

  it('does not append a reference when cancellation happens during the read', async () => {
    const root = new Context()
    const aborted = new AbortController()
    const fs = fakeFs(TREE) as any
    fs.readText = async (target: { targetKey: string }) => {
      aborted.abort()
      return TREE[target.targetKey]
    }
    root.provide('fs', fs)
    const service = new FileIndexService(root)
    const agent = makeAgent(CWD)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'read `docs/a.md`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 15, step: 1, signal: aborted.signal },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('marks injected messages with the plugin source', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: '`docs/a.md`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 7, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const injected = decision.messages[1]!
    expect(injected.source).toMatchObject({ kind: 'plugin', plugin: name, form: 'snapshot' })
    expect(injected.source).toHaveProperty('sections')
  })

  it('suffix-matches short paths that resolve directly only via the index', async () => {
    // `index.vue` has no direct resolution (no such top-level path) but its
    // basename suffix matches exactly one indexed file.
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open `index.vue`' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 8, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('warning-disposal-report/index.vue')
  })

  it('resolves flattened chip tokens to files and directories', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open @warning-disposal-report-index-vue and @src-util' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 10, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('<file_context>')
    expect(texts[0]).toContain('warning-disposal-report/index.vue')
    expect(texts[1]).toContain('<dir_context>')
    expect(texts[1]).toContain('src/util/')
  })

  it('skips flattened tokens whose flattening collides', async () => {
    const root = new Context()
    const files = {
      '/ws/collide/a-b.md': '# one',
      '/ws/collide/a/b.md': '# two',
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fakeFs(files) as any)
    const service = new FileIndexService(root)
    const agent = makeAgent(CWD)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open @collide-a-b-md' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 11, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('resolves a basename-only hand-typed chip token when unique', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open @index-vue' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 12, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('warning-disposal-report/index.vue')
  })

  it('skips a basename chip token shared by two files', async () => {
    const { service, agent } = setup()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open @readme-md' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 13, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    expect(injectedTexts(decision)).toHaveLength(0)
  })

  it('resolves the parent/name chip of a deep path to the full row', async () => {
    const root = new Context()
    const files = {
      '/ws/src/views/kabuto/statistics/warning-disposal-report/index.vue': '<template>deep</template>',
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fakeFs(files) as any)
    const service = new FileIndexService(root)
    const agent = makeAgent(CWD)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'open @warning-disposal-report-index-vue' }],
      source: { kind: 'user' },
    })
    const decision = await service.handlePreStep(
      { agent, messages: [user], turn: 14, step: 1, signal: signal() },
      async () => ({ kind: 'enter', messages: [user] }),
    )
    const texts = injectedTexts(decision)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('src/views/kabuto/statistics/warning-disposal-report/index.vue')
  })
})

// ── token scanning ───────────────────────────────────────────────────────────

describe('scanTokens', () => {
  it('scans structured references as one exact path', () => {
    expect(scanReferences('open @{docs/space name.md} now')).toEqual([{
      index: 4,
      token: 'docs/space name.md',
      exact: true,
    }])
    expect(scanTokens('open @{docs/space name.md} now')).toEqual(['docs/space name.md'])
  })

  it('collects @ mentions and backtick paths', () => {
    expect(scanTokens('fix @a/b.ts and `c/d/`')).toEqual(['a/b.ts', 'c/d/'])
  })

  it('strips trailing punctuation from @ mentions', () => {
    expect(scanTokens('see @src/main.ts, ok?')).toEqual(['src/main.ts'])
  })

  it('skips dynamic plugin ids', () => {
    expect(scanTokens('ask @abc-123 about it')).toEqual([])
  })

  it('skips whitespace-containing backtick tokens', () => {
    expect(scanTokens('`a b` `ok`')).toEqual(['ok'])
  })
})

// ── event-bus integration ────────────────────────────────────────────────────

describe('FileIndexService event-bus integration', () => {
  it('mounts as a class plugin and receives the scoped agent/pre-step dispatch', async () => {
    const root = new Context()
    await root.plugin(AgentRegistry)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.provide('fs', fakeFs(TREE) as any)
    await root.plugin(FileIndexService)

    const mounted = root.get('fileIndex')
    expect(mounted).toBeInstanceOf(FileIndexService)

    const agent = makeAgent(CWD)
    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'see `docs/a.md`' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(root, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 9, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const injected = decision.messages.slice(1)
    expect(injected).toHaveLength(1)
    expect((injected[0]!.content[0] as { type: 'text'; text: string }).text).toContain('docs/a.md')
  })
})
