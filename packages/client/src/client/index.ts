/**
 * Browser half of the file-mention plugin: the `@` input-trigger source.
 *
 * Flicker-free candidates are the core requirement: a sessionId-level cache
 * of the Host index (Host-configured TTL, single-flight) backs local filtering
 * when the snapshot is complete. A capped Host snapshot is marked incomplete;
 * in that case repeated query strings use a bounded per-session query cache
 * while each distinct query is resolved remotely. A pick inserts a structured
 * `ReferenceInsert` carrying the exact workspace-relative path; the source
 * codec serializes it only when the message is sent, so labels are independent
 * from path syntax.
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
import type { IndexResultWire, IndexRowWire } from './remote.ts'
import { installMenuStyles } from './menu-styles.ts'
import { serializeFileReference } from './reference.ts'
import {
  buildMentionCounts, isMentionName, mentionName, rankRows, uniqueCandidates,
} from './rank.ts'

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

/** The mounted `remote.fileIndex` namespace service shape. */
interface FileIndexNamespace {
  list(agentId: string, request: { query?: string }): Promise<RemoteResult<IndexResultWire>>
}

/** One session's index fetch: shared promise plus its settled snapshot. */
interface IndexEntry {
  promise: Promise<readonly IndexRowWire[]>
  rows?: readonly IndexRowWire[]
  complete?: boolean
  settledAt?: number
  ttlMs?: number
  queries: Map<string, QueryEntry>
}

interface QueryEntry {
  promise: Promise<readonly IndexRowWire[]>
  rows?: readonly IndexRowWire[]
  settledAt?: number
  ttlMs?: number
}

/** One session's mention roll: suffix-token frequencies + per-row names. */
interface MentionRoll {
  readonly counts: Map<string, number>
  readonly names: readonly string[]
}

/** Bound browser memory when one page visits many sessions. */
const MAX_SESSION_CACHE_ENTRIES = 64
const MAX_QUERY_CACHE_ENTRIES = 32
const INCOMPLETE_QUERY_DEBOUNCE_MS = 50

/** Resolve false instead of rejecting when a superseded menu query aborts. */
function waitForQueryDebounce(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, INCOMPLETE_QUERY_DEBOUNCE_MS)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
    await disposeRemote()
    throw new Error('file-mention: remote.fileIndex namespace did not mount')
  }

  // Plugin-closure state, torn down by the returned disposer.
  const entries = new Map<string, IndexEntry>()
  const picks = new Map<string, Map<string, IndexRowWire>>()
  /** Per-session mention rolls (uniqueness table + lexicon names). */
  const rolls = new Map<string, MentionRoll>()
  /** Per-session lexicon invalidation listeners (subscribeLexicon consumers). */
  const lexiconListeners = new Map<string, Set<() => void>>()

  const dropSession = (sessionId: string): void => {
    entries.delete(sessionId)
    picks.delete(sessionId)
    rolls.delete(sessionId)
    if (!lexiconListeners.has(sessionId)) lexiconListeners.delete(sessionId)
  }

  const touchSession = (sessionId: string): void => {
    const entry = entries.get(sessionId)
    if (entry === undefined) return
    entries.delete(sessionId)
    entries.set(sessionId, entry)
  }

  const pruneSessions = (protectedSessionId: string): void => {
    while (entries.size > MAX_SESSION_CACHE_ENTRIES) {
      let removed = false
      for (const [sessionId, entry] of entries) {
        if (sessionId === protectedSessionId || entry.settledAt === undefined) continue
        if (lexiconListeners.has(sessionId)) continue
        dropSession(sessionId)
        removed = true
        break
      }
      if (!removed) break
    }
  }

  const notifyLexicon = (sessionId: string): void => {
    for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
      try {
        listener()
      } catch (error) {
        console.error('[file-mention] lexicon listener failed:', error)
      }
    }
  }

  const touchQuery = (entry: IndexEntry, query: string, queryEntry: QueryEntry): void => {
    if (entry.queries.get(query) !== queryEntry) return
    entry.queries.delete(query)
    entry.queries.set(query, queryEntry)
  }

  const pruneQueries = (entry: IndexEntry): void => {
    while (entry.queries.size > MAX_QUERY_CACHE_ENTRIES) {
      const oldest = entry.queries.keys().next().value
      if (oldest === undefined) break
      entry.queries.delete(oldest)
    }
  }

  /**
   * SessionId-level index cache: Host-configured TTL + single-flight. A failed fetch
   * drops the key so the next keystroke retries instead of caching failure.
   * Settling (success or failure) notifies the lexicon listeners so the
   * composer re-scans draft decorations.
   */
  const ensureIndex = (sessionId: string): Promise<readonly IndexRowWire[]> => {
    const existing = entries.get(sessionId)
    if (existing !== undefined) {
      touchSession(sessionId)
      if (existing.rows !== undefined && Date.now() - (existing.settledAt ?? 0) < (existing.ttlMs ?? 0)) {
        return Promise.resolve(existing.rows)
      }
      if (existing.settledAt === undefined) return existing.promise
      // Settled but stale: fall through to a refetch.
    }
    const entry: IndexEntry = {
      promise: Promise.resolve([] as readonly IndexRowWire[]),
      queries: new Map(),
    }
    entry.promise = (async () => {
      const answered = await fileIndex.list(sessionId, { query: '' })
      if (!answered.ok) {
        throw new Error(`fileIndex.list failed: ${answered.error.code}: ${answered.error.message}`)
      }
      const rows = answered.value.files
      const counts = buildMentionCounts(rows)
      const mentionableRows = rows.filter(row => isMentionName(mentionName(row, counts)))
      const current = entries.get(sessionId)
      if (current === entry) {
        current.rows = rows
        current.complete = answered.value.complete
        current.settledAt = Date.now()
        current.ttlMs = answered.value.cacheTtlMs
        rolls.set(sessionId, {
          counts,
          names: mentionableRows.map(row => mentionName(row, counts)),
        })
        touchSession(sessionId)
        pruneSessions(sessionId)
      }
      notifyLexicon(sessionId)
      return rows
    })()
    entries.set(sessionId, entry)
    entry.promise.catch((error: unknown) => {
      if (entries.get(sessionId) === entry) dropSession(sessionId)
      notifyLexicon(sessionId)
      console.error('[file-mention] index fetch failed:', error)
    })
    return entry.promise
  }

  /**
   * Use local ranking for complete snapshots. Capped snapshots query the Host
   * for each distinct non-empty query, with the same TTL/single-flight rules.
   */
  const ensureCandidates = async (
    sessionId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly IndexRowWire[]> => {
    if (signal.aborted) return []
    const rows = await ensureIndex(sessionId)
    if (signal.aborted) return []
    const entry = entries.get(sessionId)
    const queryKey = query.trim()
    if (entry === undefined || entry.complete !== false || queryKey === '') return rows
    if (!await waitForQueryDebounce(signal)) return []
    if (signal.aborted) return []

    const existing = entry.queries.get(queryKey)
    if (existing !== undefined) {
      touchQuery(entry, queryKey, existing)
      if (existing.rows !== undefined && Date.now() - (existing.settledAt ?? 0) < (existing.ttlMs ?? 0)) {
        return existing.rows
      }
      if (existing.settledAt === undefined) return existing.promise
    }

    const queryEntry: QueryEntry = {
      promise: Promise.resolve([] as readonly IndexRowWire[]),
    }
    queryEntry.promise = (async () => {
      const answered = await fileIndex.list(sessionId, { query: queryKey })
      if (!answered.ok) {
        throw new Error(`fileIndex.list failed: ${answered.error.code}: ${answered.error.message}`)
      }
      const resultRows = answered.value.files
      const current = entries.get(sessionId)
      if (current === entry) {
        queryEntry.rows = resultRows
        queryEntry.settledAt = Date.now()
        queryEntry.ttlMs = answered.value.cacheTtlMs
        touchQuery(entry, queryKey, queryEntry)
        pruneQueries(entry)
      }
      return resultRows
    })()
    entry.queries.set(queryKey, queryEntry)
    pruneQueries(entry)
    void queryEntry.promise.catch((error: unknown) => {
      if (entry.queries.get(queryKey) === queryEntry) entry.queries.delete(queryKey)
      console.error('[file-mention] index query failed:', error)
    })
    return queryEntry.promise
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
        const rows = await ensureCandidates(session.sessionId, query, signal)
        // Superseded keystroke: the shared fetch stays warm, this caller yields.
        if (signal.aborted) return []
        // Structured picks do not need to satisfy the legacy plain-text chip
        // lexicon, so paths with spaces and other punctuation remain visible.
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
      return {
        insert: {
          source: name,
          ref: row.path,
          label: candidate.name,
          clipboardText: serializeFileReference(row.path),
        },
      }
    },
    lexicon(session) {
      // Mention names of the settled cache: the composer chips hand-typed
      // `@<name>` tokens only when the name is on this roll.
      return rolls.get(session.sessionId)?.names
    },
    subscribeLexicon(session, listener) {
      const key = session.sessionId
      const listeners = lexiconListeners.get(key) ?? new Set<() => void>()
      listeners.add(listener)
      lexiconListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) lexiconListeners.delete(key)
      }
    },
    codec: {
      clipboardText: serializeFileReference,
      serialize: async (ref, signal) => {
        if (signal.aborted) throw new Error('file-mention: reference serialization aborted')
        return serializeFileReference(ref)
      },
    },
  }

  const unregister = inputTriggers.registerSource(source)
  const disposeMenuStyles = installMenuStyles()
  return async () => {
    unregister()
    disposeMenuStyles()
    picks.clear()
    entries.clear()
    rolls.clear()
    lexiconListeners.clear()
    await disposeRemote()
  }
}
