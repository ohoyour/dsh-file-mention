/**
 * Host Typert registration artifact for the fileIndex Remote service.
 *
 * The Harness Typert loader discovers this artifact through the package's
 * `./typert` export. Keeping the descriptor in the published Host package is
 * required for `/api/fileIndex/list` to be claimed by the API gateway.
 */

import { z } from 'zod'

const indexRowSchema = z.object({
  type: z.enum(['file', 'directory']).readonly(),
  path: z.string().readonly(),
  name: z.string().readonly(),
  dir: z.string().readonly(),
  mention: z.string().optional().readonly(),
})

const listRequestSchema = z.object({
  query: z.string().optional(),
}).readonly()

const listResultSchema = z.object({
  files: z.array(indexRowSchema).readonly(),
  complete: z.boolean().readonly(),
  revision: z.number().int().nonnegative().readonly(),
  cacheTtlMs: z.number().nonnegative().readonly(),
}).readonly()

const sessionIdCodec = {
  mode: 'strict' as const,
  typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  schema: z.string(),
}

export const TYPERT = {
  package: '@ohoyo/dsh-file-mention-host',
  face: 'host',
  schemas: [],
  invocations: [
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
          codec: sessionIdCodec,
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict' as const,
            typeSymbol: '@ohoyo/dsh-file-mention-host#fileIndex/list:request',
            schema: listRequestSchema,
          },
        },
      ],
      result: {
        mode: 'strict' as const,
        typeSymbol: '@ohoyo/dsh-file-mention-host#fileIndex/list:result',
        schema: listResultSchema,
      },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
