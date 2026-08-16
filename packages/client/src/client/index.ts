/**
 * Browser half of the file-mention plugin: the `@` input-trigger source.
 *
 * Flicker-free candidates are the core requirement: a sessionId-level cache
 * of the Host index (Host-configured TTL, single-flight) backs local filtering
 * when the snapshot is complete. A capped Host snapshot is marked incomplete;
 * in that case repeated query strings use a bounded per-session query cache
 * while each distinct query is resolved remotely. A pick inserts the exact
 * workspace-relative path as plain `@{...}` text, so the complete reference
 * remains visible in the composer instead of being forced into Harness's
 * fixed-width reference chip.
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
  revision?: number
  settledAt?: number
  ttlMs?: number
  queries: Map<string, QueryEntry>
}

interface QueryEntry {
  promise: Promise<readonly IndexRowWire[]>
  rows?: readonly IndexRowWire[]
  complete?: boolean
  revision?: number
  settledAt?: number
  ttlMs?: number
}

interface CandidateSnapshot {
  readonly rows: readonly IndexRowWire[]
  /** Whether these rows were produced from an exhaustive Host scope. */
  readonly complete: boolean
}

interface PickEntry {
  readonly row: IndexRowWire
  /** Whether the candidate query, not merely the base cache, was exhaustive. */
  readonly complete: boolean
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
  const picks = new Map<string, Map<string, PickEntry>>()
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

  /**
   * Add Host-proven safe names discovered by a complete query to the live
   * decoration roll. A capped base snapshot cannot prove uniqueness locally,
   * so its locally-derived names must never enter the lexicon. Query rows may
   * come from the Host's exhaustive search catalog and carry the proof as
   * `row.mention`.
   */
  const appendQueryMentionNames = (
    sessionId: string,
    rows: readonly IndexRowWire[],
    complete: boolean,
  ): void => {
    if (!complete) return
    const entry = entries.get(sessionId)
    const roll = rolls.get(sessionId)
    if (entry === undefined || roll === undefined) return
    const names = new Set(roll.names)
    let changed = false
    for (const row of rows) {
      if (row.mention === undefined || !isMentionName(row.mention) || names.has(row.mention)) continue
      names.add(row.mention)
      changed = true
    }
    if (!changed) return
    rolls.set(sessionId, { counts: roll.counts, names: [...names] })
    notifyLexicon(sessionId)
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
        current.revision = answered.value.revision ?? 0
        current.settledAt = Date.now()
        current.ttlMs = answered.value.cacheTtlMs
        rolls.set(sessionId, {
          counts,
          // Names derived from a capped snapshot are not globally safe: a
          // matching row may be outside the first indexLimit rows. Only the
          // Host can authorize names for an incomplete snapshot.
          names: answered.value.complete
            ? mentionableRows.map(row => mentionName(row, counts))
            : rows.flatMap(row => row.mention === undefined ? [] : [row.mention]),
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
  ): Promise<CandidateSnapshot> => {
    if (signal.aborted) return { rows: [], complete: false }
    const rows = await ensureIndex(sessionId)
    if (signal.aborted) return { rows: [], complete: false }
    const entry = entries.get(sessionId)
    const queryKey = query.trim()
    if (entry === undefined || entry.complete !== false || queryKey === '') {
      return { rows, complete: entry?.complete === true }
    }
    if (!await waitForQueryDebounce(signal)) return { rows: [], complete: false }
    if (signal.aborted) return { rows: [], complete: false }

    const existing = entry.queries.get(queryKey)
    if (existing !== undefined) {
      touchQuery(entry, queryKey, existing)
      if (existing.rows !== undefined && Date.now() - (existing.settledAt ?? 0) < (existing.ttlMs ?? 0)) {
        return { rows: existing.rows, complete: existing.complete === true }
      }
      if (existing.settledAt === undefined) {
        return existing.promise.then(resultRows => ({
          rows: resultRows,
          complete: existing.complete === true,
        }))
      }
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
        queryEntry.revision = answered.value.revision ?? 0
        queryEntry.complete = answered.value.complete
        if (current.revision !== undefined && current.revision !== queryEntry.revision) {
          // Return this fresh query result, but discard all session state so
          // the next candidate request refetches the base snapshot.
          dropSession(sessionId)
          notifyLexicon(sessionId)
          return resultRows
        }
        appendQueryMentionNames(sessionId, resultRows, queryEntry.complete === true)
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
    return queryEntry.promise.then(resultRows => ({
      rows: resultRows,
      complete: queryEntry.complete === true,
    }))
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
        const snapshot = await ensureCandidates(session.sessionId, query, signal)
        // Superseded keystroke: the shared fetch stays warm, this caller yields.
        if (signal.aborted) return []
        // Plain picks use the exact structured text form below, so paths with
        // spaces and other punctuation remain visible without a legacy token.
        const ranked = rankRows(snapshot.rows, query, 20)
        const unique = uniqueCandidates(ranked)
        picks.set(session.sessionId, new Map(unique.map(item => [item.name, {
          row: item.row,
          complete: snapshot.complete,
        }])))
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
      const picked = picks.get(session.sessionId)?.get(candidate.name)
      if (picked === undefined) return undefined
      const row = picked.row
      // A complete index gives us the same suffix-count table the Host uses
      // for legacy references. Those plain @tokens receive Harness's native
      // text-ref highlight while still resolving to this exact row. For a
      // complete query over a capped base index, use the Host-provided token:
      // the Client only sees the top 20 query rows and cannot prove uniqueness
      // from that partial result itself. Keep the structured form for capped
      // queries and names that cannot be scanned by the legacy decorator.
      const entry = entries.get(session.sessionId)
      const counts = rolls.get(session.sessionId)?.counts
      if (picked.complete) {
        const token = row.mention
          ?? (entry?.complete === true && counts !== undefined ? mentionName(row, counts) : undefined)
        if (token !== undefined && isMentionName(token)) return { text: `@${token}` }
      }
      return { text: serializeFileReference(row.path) }
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
