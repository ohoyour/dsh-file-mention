import { describe, expect, it } from 'vitest'
import { TYPERT } from '../src/typert.host.ts'

describe('Host Typert artifact', () => {
  it('claims fileIndex/list with a strict lookup contract', () => {
    const invocation = TYPERT.invocations[0]!
    expect(TYPERT.package).toBe('@ohoyo/dsh-file-mention-host')
    expect(invocation.id).toBe('@ohoyo/dsh-file-mention-host#fileIndex/list')
    expect(invocation.scope).toEqual({ context: 'agent', wire: 'agentId' })
    expect(invocation.parameters.map(parameter => parameter.wire)).toEqual(['agentId', 'request'])
    expect(invocation.parameters[0]!.source).toBe('lookup')
    expect(invocation.parameters[1]!.codec.mode).toBe('strict')
    expect(invocation.result.mode).toBe('strict')
  })

  it('validates the wire result shape', () => {
    const resultCodec = TYPERT.invocations[0]!.result
    expect(resultCodec.schema.safeParse({
      files: [{ type: 'file', path: 'src/main.ts', name: 'main.ts', dir: 'src' }],
      complete: true,
      revision: 0,
      cacheTtlMs: 15_000,
    }).success).toBe(true)
  })
})
