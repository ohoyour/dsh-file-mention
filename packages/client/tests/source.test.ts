import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject, name } from '../src/client/index.ts'
import { installMenuStyles, MENU_ALIGN_CSS } from '../src/client/menu-styles.ts'

const FIXTURE = [
  { type: 'directory', path: 'warning-disposal-report', name: 'warning-disposal-report', dir: '' },
  { type: 'file', path: 'warning-disposal-report/index.vue', name: 'index.vue', dir: 'warning-disposal-report' },
  { type: 'file', path: 'src/main.ts', name: 'main.ts', dir: 'src' },
  { type: 'file', path: 'docs/readme.md', name: 'readme.md', dir: 'docs' },
  { type: 'file', path: 'other/readme.md', name: 'readme.md', dir: 'other' },
]

const SESSION = { sessionId: 's1' as unknown as SessionId }
const REQ = (query: string) => ({
  query,
  position: 'leading' as const,
  signal: new AbortController().signal,
})
const PICK = (candidateName: string) => ({
  candidate: { name: candidateName },
  session: SESSION,
  position: 'leading' as const,
  via: 'menu' as const,
  span: { start: 0, end: 1, draftRev: 1 },
})

describe('menu alignment stylesheet', () => {
  it('forces the candidate menu to the composer card width', () => {
    expect(MENU_ALIGN_CSS).toContain('[data-composer-card] [role="listbox"]:has([data-source="file"])')
    expect(MENU_ALIGN_CSS).toContain('width: 100% !important')
    expect(MENU_ALIGN_CSS).toContain('min-width: 100% !important')
    expect(MENU_ALIGN_CSS).toContain('max-width: 100% !important')
    expect(MENU_ALIGN_CSS).toContain('box-sizing: border-box')
  })

  it('removes the exact style element installed by the plugin', () => {
    const remove = vi.fn()
    const appendChild = vi.fn()
    const tag = { setAttribute: vi.fn(), textContent: '', remove }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => tag),
      head: { appendChild },
    })
    try {
      const dispose = installMenuStyles()
      expect(appendChild).toHaveBeenCalledWith(tag)
      expect(tag.setAttribute).toHaveBeenCalledWith('data-file-mention-style', '')
      dispose()
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

async function setup(list: unknown) {
  const root = new Context()
  const mounted: unknown[] = []
  const remote = {
    $mount: async (contribution: unknown) => {
      mounted.push(contribution)
      return async () => {}
    },
  }
  const registered: InputTriggerSource[] = []
  const inputTriggers = {
    registerSource: (source: InputTriggerSource) => {
      registered.push(source)
      return () => {}
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root.provide('remote', remote as any)
  // The mounted namespace is a separate service read via ctx.get.
  root.provide('remote.fileIndex', { list } as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root.provide('inputTriggers', inputTriggers as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fiber = root.plugin({ name, inject, apply: apply as any })
  await fiber
  expect(registered).toHaveLength(1)
  return { source: registered[0]!, mounted }
}

describe('file-mention client source', () => {
  it('mounts the fileIndex contribution and registers the @ source', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source, mounted } = await setup(list)
    expect(source).toMatchObject({ trigger: '@', name: 'file', order: -1 })
    expect(mounted).toHaveLength(1)
    const contribution = mounted[0] as { package: string; descriptors: Array<{ namespace: string; method: string }> }
    expect(contribution.package).toBe('@ohoyo/dsh-file-mention-host')
    expect(contribution.descriptors[0]).toMatchObject({ namespace: 'fileIndex', method: 'list' })
  })

  it('fetches the full index once and filters locally per keystroke', async () => {
    const list = vi.fn(async (sessionId: string, request: { query?: string }) => {
      expect(sessionId).toBe('s1')
      expect(request).toEqual({ query: '' })
      return { ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }
    })
    const { source } = await setup(list)

    const first = await source.candidates(SESSION, REQ('warning'))
    expect(first.map(candidate => candidate.name)).toEqual([
      'warning-disposal-report/',
      'index.vue',
    ])
    expect(first[0]).toMatchObject({ icon: '📁' })
    expect(first[0]).not.toHaveProperty('description')
    expect(first[1]).toMatchObject({ icon: '📄', description: 'warning-disposal-report' })

    // A second keystroke must not hit the wire again (single-flight cache).
    const second = await source.candidates(SESSION, REQ('index'))
    expect(second.map(candidate => candidate.name)).toEqual(['index.vue'])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('disambiguates clashing basenames', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    const candidates = await source.candidates(SESSION, REQ('readme'))
    expect(candidates.map(candidate => candidate.name)).toEqual([
      'docs/readme.md',
      'other/readme.md',
    ])
  })

  it('offers paths containing spaces through structured references', async () => {
    const invalid = { type: 'file' as const, path: 'docs/bad name.txt', name: 'bad name.txt', dir: 'docs' }
    const list = vi.fn(async () => ({
      ok: true as const,
      value: { files: [...FIXTURE, invalid], cacheTtlMs: 10_000 },
    }))
    const { source } = await setup(list)
    expect(await source.candidates(SESSION, REQ('bad'))).toEqual([{
      name: 'bad name.txt',
      description: 'docs',
      icon: '📄',
    }])
    expect(source.onPick(PICK('bad name.txt'))).toEqual({
      insert: {
        source: 'file-mention',
        ref: 'docs/bad name.txt',
        label: 'bad name.txt',
        clipboardText: '@{docs/bad name.txt}',
      },
    })
  })

  it('picks a structured reference with the exact workspace path', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    await source.candidates(SESSION, REQ('index'))
    expect(source.onPick(PICK('index.vue'))).toEqual({
      insert: {
        source: 'file-mention',
        ref: 'warning-disposal-report/index.vue',
        label: 'index.vue',
        clipboardText: '@{warning-disposal-report/index.vue}',
      },
    })

    await source.candidates(SESSION, REQ('warning'))
    expect(source.onPick(PICK('warning-disposal-report/'))).toEqual({
      insert: {
        source: 'file-mention',
        ref: 'warning-disposal-report',
        label: 'warning-disposal-report/',
        clipboardText: '@{warning-disposal-report}',
      },
    })
  })

  it('serializes exact references through the source codec', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    expect(source.codec?.clipboardText('docs/bad name.txt')).toBe('@{docs/bad name.txt}')
    await expect(source.codec?.serialize('docs/a%7Db.md', new AbortController().signal))
      .resolves.toBe('@{docs/a%257Db.md}')
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.codec?.serialize('docs/a.md', aborted.signal))
      .rejects.toThrow('serialization aborted')
  })

  it('exposes the flattened mention lexicon and notifies subscribers on settle', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    // Cold: no settled cache yet → no roll.
    expect(source.lexicon?.(SESSION)).toBeUndefined()
    const notified = vi.fn()
    const off = source.subscribeLexicon?.(SESSION, notified) ?? (() => {})
    await source.candidates(SESSION, REQ('x'))
    // Warm: the roll carries every flattened path (input chips need membership).
    expect(source.lexicon?.(SESSION)).toEqual([
      'warning-disposal-report',
      'warning-disposal-report-index-vue',
      'src-main-ts',
      'docs-readme-md',
      'other-readme-md',
    ])
    expect(notified).toHaveBeenCalled()
    off()
    await source.candidates(SESSION, REQ('y'))
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('returns undefined for a pick with no backing row', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    expect(source.onPick(PICK('unknown.ts'))).toBeUndefined()
  })

  it('returns [] when the remote fails and logs the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const list = vi.fn(async () => ({
        ok: false as const,
        error: { code: 'internal', message: 'boom', details: {} },
      }))
      const { source } = await setup(list)
      await expect(source.candidates(SESSION, REQ('x'))).resolves.toEqual([])
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('yields [] for an aborted keystroke', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    const aborted = new AbortController()
    aborted.abort()
    const candidates = await source.candidates(SESSION, {
      query: 'x',
      position: 'leading',
      signal: aborted.signal,
    })
    expect(candidates).toEqual([])
  })

  it('prewarms through the warm hook', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 10_000 } }))
    const { source } = await setup(list)
    source.warm?.(SESSION)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('honors the host-provided cache TTL', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE, cacheTtlMs: 0 } }))
    const { source } = await setup(list)
    await source.candidates(SESSION, REQ('warning'))
    await source.candidates(SESSION, REQ('warning'))
    expect(list).toHaveBeenCalledTimes(2)
  })
})
