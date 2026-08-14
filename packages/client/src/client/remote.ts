/**
 * Hand-written Typert Remote contribution for the Host's `fileIndex/list`
 * endpoint — the third-party equivalent of the generator-produced
 * `@deepseek-ai/dsh-<name>/remote` artifacts (see packages/api/remotes/src/client
 * in the harness checkout, which mounts such contributions through
 * `ctx.remote.$mount`). The descriptor mirrors the generated `commands`
 * shape: a `scope`/lookup `agent` parameter whose wire value the caller
 * passes explicitly (the direct invocation path), and strict zod codecs
 * for the JSON boundary.
 */

import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** Wire shape of one index row. */
export interface IndexRowWire {
  readonly type: 'file' | 'directory'
  readonly path: string
  readonly name: string
  readonly dir: string
}

/** Wire result of `fileIndex/list`. */
export interface IndexResultWire {
  readonly files: readonly IndexRowWire[]
  readonly complete: boolean
  readonly revision: number
  readonly cacheTtlMs: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    fileIndex: {
      list(agentId: string, request: { query?: string }): Promise<RemoteResult<IndexResultWire>>
    }
  }
}

const indexRowSchema = z.object({
  type: z.enum(['file', 'directory']).readonly(),
  path: z.string().readonly(),
  name: z.string().readonly(),
  dir: z.string().readonly(),
})

const listRequestSchema = z.object({ query: z.string().optional() }).readonly()
const listResultSchema = z.object({
  files: z.array(indexRowSchema).readonly(),
  complete: z.boolean(),
  // Older Host builds did not expose revisions; normalize them to generation 0.
  revision: z.number().int().nonnegative().default(0),
  cacheTtlMs: z.number(),
}).readonly()

/** The contribution mounted by the client plugin's apply. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@ohoyo/dsh-file-mention-host',
  descriptors: [
    {
      id: '@ohoyo/dsh-file-mention-host#fileIndex/list',
      service: 'fileIndex',
      namespace: 'fileIndex',
      method: 'list',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            schema: z.string(),
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@ohoyo/dsh-file-mention-host#fileIndex/list:request',
            schema: listRequestSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@ohoyo/dsh-file-mention-host#fileIndex/list:result',
        schema: listResultSchema,
      },
    },
  ],
}
