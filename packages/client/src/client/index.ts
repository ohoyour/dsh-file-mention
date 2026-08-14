/**
 * Browser half of the file-mention plugin: the `@` input-trigger source.
 *
 * Flicker-free candidates are the core requirement: a sessionId-level cache
 * of the full Host index (Host-configured TTL, single-flight, fetched once with
 * `query: ''`) backs pure-local per-keystroke filtering with the same
 * ranking rules the Host uses. A pick inserts the chip-compatible plain-text
 * reference `@<minimal unique suffix>` (files: `parent/name`, directories:
 * `name`, `/` and `.` flattened to `-`) — the composer decorates it through
 * the lexicon and the conversation bubble decorates it by shape; the Host's
 * pre-step boundary resolves the token back to the workspace path.
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
import './menu-styles.ts'
import {
  buildMentionCounts, mentionName, mentionToken, rankRows, uniqueCandidates,
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
  settledAt?: number
  ttlMs?: number
}

/** One session's mention roll: suffix-token frequencies + per-row names. */
interface MentionRoll {
  readonly counts: Map<string, number>
  readonly names: readonly string[]
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
  /** Per-session mention rolls (uniqueness table + lexicon names). */
  const rolls = new Map<string, MentionRoll>()
  /** Per-session lexicon invalidation listeners (subscribeLexicon consumers). */
  const lexiconListeners = new Map<string, Set<() => void>>()

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
   * SessionId-level index cache: Host-configured TTL + single-flight. A failed fetch
   * drops the key so the next keystroke retries instead of caching failure.
   * Settling (success or failure) notifies the lexicon listeners so the
   * composer re-scans draft decorations.
   */
  const ensureIndex = (sessionId: string): Promise<readonly IndexRowWire[]> => {
    const existing = entries.get(sessionId)
    if (existing !== undefined) {
      if (existing.rows !== undefined && Date.now() - (existing.settledAt ?? 0) < (existing.ttlMs ?? 0)) {
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
      const counts = buildMentionCounts(rows)
      const current = entries.get(sessionId)
      if (current === entry) {
        current.rows = rows
        current.settledAt = Date.now()
        current.ttlMs = answered.value.cacheTtlMs
        rolls.set(sessionId, { counts, names: rows.map(row => mentionName(row, counts)) })
      }
      notifyLexicon(sessionId)
      return rows
    })()
    entries.set(sessionId, entry)
    entry.promise.catch((error: unknown) => {
      if (entries.get(sessionId) === entry) entries.delete(sessionId)
      notifyLexicon(sessionId)
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
      // Plain-text reference (the same decision as ui-skill / ui-subagent):
      // the draft gains the literal `@<minimal unique suffix>` token and the
      // composer decorates it as a chip by scanning against our lexicon.
      // This path is deliberate: the occurrence-chip alternative renders in a
      // fixed ~4em cell whose label is clipped with an ellipsis (built-in
      // InputBar CSS) — long paths get cut off — while the plain-text
      // decoration paints the chip look over the draft's own glyphs, so the
      // whole token stays visible. The Host resolves the token by
      // suffix-matching the index.
      const counts = rolls.get(session.sessionId)?.counts ?? new Map<string, number>()
      return { text: `${mentionToken(row, counts)} ` }
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
  }

  const unregister = inputTriggers.registerSource(source)
  return async () => {
    unregister()
    picks.clear()
    entries.clear()
    rolls.clear()
    lexiconListeners.clear()
    await disposeRemote()
  }
}
