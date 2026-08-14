import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject, name } from '../src/client/index.ts'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
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
      return { ok: true as const, value: { files: FIXTURE } }
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
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
    const { source } = await setup(list)
    const candidates = await source.candidates(SESSION, REQ('readme'))
    expect(candidates.map(candidate => candidate.name)).toEqual([
      'docs/readme.md',
      'other/readme.md',
    ])
  })

  it('picks insert the backtick short form, directories with a trailing slash', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
    const { source } = await setup(list)
    await source.candidates(SESSION, REQ('index'))
    expect(source.onPick(PICK('index.vue'))).toEqual({ text: '`warning-disposal-report/index.vue` ' })

    await source.candidates(SESSION, REQ('warning'))
    expect(source.onPick(PICK('warning-disposal-report/'))).toEqual({ text: '`warning-disposal-report/` ' })
  })

  it('returns undefined for a pick with no backing row', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
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
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
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
    const list = vi.fn(async () => ({ ok: true as const, value: { files: FIXTURE } }))
    const { source } = await setup(list)
    source.warm?.(SESSION)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(1)
  })
})
