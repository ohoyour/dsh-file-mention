/**
 * Browser half of the file-mention plugin: the `@` input-trigger source.
 *
 * Flicker-free candidates are the core requirement: a sessionId-level cache
 * of the full Host index (TTL 10 s, single-flight, fetched once with
 * `query: ''`) backs pure-local per-keystroke filtering with the same
 * ranking rules the Host uses. A pick inserts the plain-text short form
 * `` `parent/name` `` (directories with a trailing `/`) — the
 * plain-text-reference decision, like ui-skill / ui-subagent; the Host's
 * pre-step boundary resolves the reference against the session workspace.
 *
 * The plugin mounts its own Typert contribution (`remote.fileIndex`) through
 * `ctx.remote.$mount` — the third-party equivalent of what
 * `@deepseek-ai/dsh-api-remotes` does for the built-in namespaces.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: brings the api-remotes Context merge (ctx.remote) into scope.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from './remote.ts'
import type { IndexRowWire } from './remote.ts'
import { rankRows, shortForm, uniqueCandidates } from './rank.ts'

export const name = 'file-mention'

/**
 * Required services: the Remote carrier and the input-trigger registry.
 * Deliberately NOT `remote.fileIndex`: this plugin mounts that namespace
 * itself during apply, and a Cordis fiber waits for its injects BEFORE apply
 * runs — declaring it would deadlock. The namespace is therefore read with
 * `ctx.get` (the inject-free store read) after the mount settles; nested
 * `ctx.remote.fileIndex` property access would demand the inject and throw.
 */
export const inject = ['remote', 'inputTriggers']

const INDEX_TTL_MS = 10_000

/** The mounted `remote.fileIndex` namespace service shape. */
interface FileIndexNamespace {
  list(agentId: string, request: { query?: string }): Promise<RemoteResult<{ files: readonly IndexRowWire[] }>>
}

/** One session's index fetch: shared promise plus its settled snapshot. */
interface IndexEntry {
  promise: Promise<readonly IndexRowWire[]>
  rows?: readonly IndexRowWire[]
  settledAt?: number
}

/**
 * Client plugin body: mount the `fileIndex` Remote namespace, then register
 * the `@` source. Async apply + returned disposer is the api-remotes pattern.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const fileIndex = ctx.get('remote.fileIndex') as FileIndexNamespace | undefined
  if (fileIndex === undefined) {
    throw new Error('file-mention: remote.fileIndex namespace did not mount')
  }

  // Plugin-closure state, torn down by the returned disposer.
  const entries = new Map<string, IndexEntry>()
  const picks = new Map<string, Map<string, IndexRowWire>>()

  /**
   * SessionId-level index cache: TTL 10 s + single-flight. A failed fetch
   * drops the key so the next keystroke retries instead of caching failure.
   */
  const ensureIndex = (sessionId: string): Promise<readonly IndexRowWire[]> => {
    const existing = entries.get(sessionId)
    if (existing !== undefined) {
      if (existing.rows !== undefined && Date.now() - (existing.settledAt ?? 0) < INDEX_TTL_MS) {
        return Promise.resolve(existing.rows)
      }
      if (existing.settledAt === undefined) return existing.promise
      // Settled but stale: fall through to a refetch.
    }
    const entry: IndexEntry = {
      promise: Promise.resolve([] as readonly IndexRowWire[]),
    }
    entry.promise = (async () => {
      const answered = await fileIndex.list(sessionId, { query: '' })
      if (!answered.ok) {
        throw new Error(`fileIndex.list failed: ${answered.error.code}: ${answered.error.message}`)
      }
      const rows = answered.value.files
      const current = entries.get(sessionId)
      if (current === entry) {
        current.rows = rows
        current.settledAt = Date.now()
      }
      return rows
    })()
    entries.set(sessionId, entry)
    entry.promise.catch((error: unknown) => {
      if (entries.get(sessionId) === entry) entries.delete(sessionId)
      console.error('[file-mention] index fetch failed:', error)
    })
    return entry.promise
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'file',
    order: -1,
    warm(session) {
      // Fire-and-forget scope-birth prewarm; failures surface via candidates.
      ensureIndex(session.sessionId).catch(() => {})
    },
    async candidates(session, { query, signal }) {
      try {
        const rows = await ensureIndex(session.sessionId)
        // Superseded keystroke: the shared fetch stays warm, this caller yields.
        if (signal.aborted) return []
        const ranked = rankRows(rows, query, 20)
        const unique = uniqueCandidates(ranked)
        picks.set(session.sessionId, new Map(unique.map(item => [item.name, item.row])))
        return unique.map(({ name: itemName, description, icon }) => ({
          name: itemName,
          ...(description === undefined ? {} : { description }),
          icon,
        }))
      } catch (error) {
        console.error('[file-mention] candidates failed:', error)
        return []
      }
    },
    onPick({ session, candidate }) {
      const row = picks.get(session.sessionId)?.get(candidate.name)
      if (row === undefined) return undefined
      // Plain-text reference: `` `parent/name` `` (directories keep `/`).
      return { text: `\`${shortForm(row)}\` ` }
    },
  }

  const unregister = inputTriggers.registerSource(source)
  return async () => {
    unregister()
    picks.clear()
    entries.clear()
    await disposeRemote()
  }
}
