/**
 * Host half of the @file/@directory mention plugin.
 *
 * Two capabilities (see requirements/file-mention-plugin-handoff.md):
 *
 * A. `fileIndex` Remote service (Typert namespace `fileIndex`): a cached,
 *    single-flight BFS index of the session workspace (files AND directories)
 *    with the noise directories skipped, served to the browser for the
 *    `@`-source candidate menu.
 *
 * B. `agent/pre-step` injection: scans user-message text for `@path` and
 *    `` `short/path` `` references, resolves them (direct, then index suffix
 *    match), and appends `<file_context>` / `<dir_context>` user messages
 *    with the referenced content. Every I/O failure is contained and logged —
 *    injection never blocks a turn.
 *
 * The plugin is a class plugin (the loader honors `static inject` and the
 * TypertRemoteService constructor registers the `fileIndex` service), the
 * same mounting pattern as `@deepseek-ai/dsh-cordis-host-runner` and
 * `@deepseek-ai/dsh-message-feedback`.
 */

import { isAbsolute, relative as relativePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { rankRows } from './rank.ts'
import type { RankableRow } from './rank.ts'

/** Stable plugin identity used in injected message sources. */
export const name = 'file-mention'

/** One index row: a file or directory of the workspace, relative to cwd. */
export interface IndexRow extends RankableRow {
  readonly type: 'file' | 'directory'
  readonly path: string
  readonly name: string
  readonly dir: string
}

/** Request shape of the `fileIndex/list` Remote method. */
export interface IndexRequest {
  readonly query?: string
}

/** Result shape of the `fileIndex/list` Remote method. */
export interface IndexResult {
  readonly files: readonly IndexRow[]
}

/** One resolved reference: file or directory, identified by its relative path. */
interface RefHit {
  readonly kind: 'file' | 'directory'
  /** Workspace-relative path, forward slashes, no trailing slash. */
  readonly path: string
  /** Already-resolved target for direct hits. */
  readonly target?: FsTarget
}

/** Pre-step payload projection this plugin reads. */
interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Truncated read result with its own "was it cut" fact. */
interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

// ── budgets (see the handoff §0 / §5) ────────────────────────────────────────

/** Directories never entered while indexing or snapshotting. */
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', '.next',
  '.nuxt', '.output', '.nitro', '.cache', '.turbo', '.idea', '.vscode', 'vendor',
  '__pycache__', '.venv', 'venv', 'logs', 'tmp', 'temp', '.svn', '.hg', 'obj',
  '.pytest_cache', '.mypy_cache',
])

const INDEX_LIMIT = 5000
const INDEX_DEPTH = 14
const INDEX_TTL_MS = 15_000

/** @file: whole-file read threshold; above (or unknown) stream-truncate. */
const FILE_SAFE_SIZE_BYTES = 400 * 1024
const FILE_TEXT_LIMIT = 60_000

/** @dir: tree snapshot budget. */
const DIR_TREE_DEPTH = 3
const DIR_TREE_LINES = 200
const DIR_FILE_SIZE_BYTES = 32 * 1024
const DIR_FILE_TEXT_LIMIT = 24_000
const DIR_FILE_COUNT = 8
const DIR_MESSAGE_LIMIT = 60_000

const MAX_REFS_PER_TURN = 5

// ── token scanning ───────────────────────────────────────────────────────────

const AT_TOKEN_RE = /(?:^|[\s\u3000])@([^\s@]+)/g
const BACKTICK_TOKEN_RE = /`([^`\n]+)`/g
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、"')\]}>]+$/
/** Dynamic Cordis plugin ids like `abc-123` must never be hijacked. */
const DYNAMIC_PLUGIN_ID_RE = /^[a-z]{3,6}-\d+$/i

/**
 * Extract reference tokens from one text block:
 * `@token` mentions (trailing punctuation stripped, dynamic plugin ids
 * skipped) and backtick short paths (whitespace-containing ones skipped),
 * merged back into document order.
 */
export function scanTokens(text: string): string[] {
  const found: Array<{ index: number; token: string }> = []
  for (const match of text.matchAll(AT_TOKEN_RE)) {
    const raw = match[1] ?? ''
    const token = raw.replace(TRAILING_PUNCT_RE, '')
    if (token === '') continue
    if (DYNAMIC_PLUGIN_ID_RE.test(token)) continue
    found.push({ index: match.index, token })
  }
  for (const match of text.matchAll(BACKTICK_TOKEN_RE)) {
    const token = match[1] ?? ''
    if (token === '' || /\s/.test(token)) continue
    found.push({ index: match.index, token })
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.token)
}

// ── helpers ──────────────────────────────────────────────────────────────────

function bounded(text: string, limit: number): BoundedText {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** Normalize a token/path: backslashes to slashes, trailing slashes off. */
function normPath(token: string): string {
  return token.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Flatten a workspace-relative path into the chip-compatible mention name
 * the client inserts: `/` and `.` both become `-` (mirror of the client's
 * `flattenPath`). `@warning-disposal-report-index-vue` resolves to
 * `warning-disposal-report/index.vue`.
 */
function flattenPath(path: string): string {
  return path.replace(/[/.]/g, '-')
}

/** Workspace-relative display path for a directly-resolved token. */
function relFor(cwd: string, token: string): string {
  const value = isAbsolute(token) ? relativePath(cwd, token) : token
  const rel = value.replace(/\\/g, '/').replace(/^\.\//, '')
  return rel.replace(/\/+$/, '')
}

/** Format the `<file_context>` message text (handoff template). */
function fileContextText(rel: string, read: BoundedText): string {
  const content = read.truncated
    ? `${read.text}\n… [truncated at ${FILE_TEXT_LIMIT} characters]`
    : read.text
  return [
    '<file_context>',
    `The user referenced this workspace file: ${rel}. Its content:`,
    content,
    'When the user asked to modify this file, edit it in place with its exact path; keep unrelated parts unchanged.',
    '</file_context>',
  ].join('\n')
}

/**
 * The `fileIndex` Remote service + pre-step injection plugin.
 */
export default class FileIndexService extends TypertRemoteService {
  static inject = ['fs']

  private readonly indexCache = new Map<string, { rows: IndexRow[]; at: number }>()
  private readonly indexFlights = new Map<string, Promise<IndexRow[]>>()
  /** Per-agent turn budget: at most 5 injected references per turn, deduped by path. */
  private readonly turnState = new Map<string, { turn: number; paths: Set<string>; count: number }>()

  constructor(ctx: Context) {
    super(ctx, 'fileIndex')
    ctx.on('agent/pre-step', (payload, next) => this.handlePreStep(payload, next), { prepend: true })
  }

  // ── A. index Remote service ────────────────────────────────────────────────

  /**
   * Remote method `fileIndex/list`. An empty query returns the complete
   * cached index (the Client fetches it once and filters locally); otherwise
   * the shared ranking rules apply, capped at 20 rows.
   */
  @Remote('list')
  async list(agent: Agent, request: IndexRequest): Promise<IndexResult> {
    const rows = await this.ensureIndex(agent)
    const query = request?.query ?? ''
    if (query.trim() === '') return { files: rows }
    return { files: rankRows(rows, query, 20) }
  }

  /** Cached (15 s) single-flight index of the agent's workspace. */
  async ensureIndex(agent: Agent): Promise<IndexRow[]> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return []
    return this.ensureIndexByCwd(cwd)
  }

  private ensureIndexByCwd(cwd: string): Promise<IndexRow[]> {
    const cached = this.indexCache.get(cwd)
    if (cached !== undefined && Date.now() - cached.at < INDEX_TTL_MS) {
      return Promise.resolve(cached.rows)
    }
    const flight = this.indexFlights.get(cwd)
    if (flight !== undefined) return flight
    const build = this.buildIndex(cwd).then((rows) => {
      this.indexCache.set(cwd, { rows, at: Date.now() })
      return rows
    }, (error: unknown) => {
      this.warn(`failed to build workspace index for "${cwd}"`, error)
      return []
    })
    this.indexFlights.set(cwd, build)
    void build.then(() => {
      if (this.indexFlights.get(cwd) === build) this.indexFlights.delete(cwd)
    }, () => {
      if (this.indexFlights.get(cwd) === build) this.indexFlights.delete(cwd)
    })
    return build
  }

  /** BFS walk of the workspace: files and directories, noise dirs skipped. */
  private async buildIndex(cwd: string): Promise<IndexRow[]> {
    const root = await this.ctx.fs.resolve(cwd)
    const rows: IndexRow[] = []
    const queue: Array<{ target: FsTarget; rel: string; depth: number }> = [
      { target: root, rel: '', depth: 0 },
    ]
    while (queue.length > 0 && rows.length < INDEX_LIMIT) {
      const { target, rel, depth } = queue.shift()!
      let entries: FsDirEntry[]
      try {
        entries = await this.ctx.fs.listDir(target)
      } catch (error) {
        this.warn(`failed to list directory "${rel || cwd}"`, error)
        continue
      }
      for (const entry of entries) {
        if (rows.length >= INDEX_LIMIT) break
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.type === 'directory') {
          if (NOISE_DIRS.has(entry.name)) continue
          rows.push({ type: 'directory', path, name: entry.name, dir: rel })
          if (depth < INDEX_DEPTH) {
            queue.push({ target: entry.target, rel: path, depth: depth + 1 })
          }
        } else if (entry.type === 'file') {
          rows.push({ type: 'file', path, name: entry.name, dir: rel })
        }
      }
    }
    return rows
  }

  // ── B. pre-step injection ──────────────────────────────────────────────────

  /**
   * The prepended `agent/pre-step` listener body (exposed as a method for
   * unit testing; the constructor wires it with `{ prepend: true }`).
   */
  async handlePreStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    try {
      const injected = await this.collectInjected(
        payload.agent, payload.messages, payload.turn, payload.signal,
      )
      if (injected.length === 0) return decision
      return { kind: 'enter', messages: [...decision.messages, ...injected] }
    } catch (error) {
      this.warn('pre-step reference injection failed', error)
      return decision
    }
  }

  private async collectInjected(
    agent: Agent,
    messages: readonly UserMessage[],
    turn: number,
    signal: AbortSignal,
  ): Promise<UserMessage[]> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return []
    const state = this.turnBudget(agent.id, turn)
    const injected: UserMessage[] = []
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      for (const block of message.content) {
        if (block.type !== 'text') continue
        for (const token of scanTokens(block.text)) {
          if (signal.aborted || state.count >= MAX_REFS_PER_TURN) return injected
          let hits: RefHit[]
          try {
            hits = await this.resolveRefs(cwd, token, signal)
          } catch (error) {
            this.warn(`failed to resolve reference "${token}"`, error)
            continue
          }
          for (const hit of hits) {
            if (signal.aborted || state.count >= MAX_REFS_PER_TURN) return injected
            if (state.paths.has(hit.path)) continue
            const built = await this.buildRefMessage(hit, cwd, signal)
            if (built === undefined) continue
            state.paths.add(hit.path)
            injected.push(built)
            state.count += 1
          }
        }
      }
    }
    return injected
  }

  /**
   * Resolve one token to 0–2 hits. A trailing `/` is directory intent.
   * Direct resolve+stat wins; otherwise index suffix matching picks
   * files first, then directories; 0 or >2 matches inject nothing.
   */
  private async resolveRefs(cwd: string, token: string, signal: AbortSignal): Promise<RefHit[]> {
    const norm = normPath(token)
    if (norm === '') return []
    const dirIntent = token.endsWith('/')
    // 1) direct resolution
    try {
      const target = await this.ctx.fs.resolve(token, { cwd, signal })
      const info = await this.ctx.fs.stat(target, signal)
      if (info !== undefined && (info.type === 'file' || info.type === 'directory')) {
        if (dirIntent && info.type !== 'directory') return []
        const rel = relFor(cwd, norm)
        return [{ kind: info.type, path: rel, target }]
      }
    } catch {
      // fall through to index suffix matching
    }
    // 2) index suffix matching
    const rows = await this.ensureIndexByCwd(cwd)
    const dirRows = rows.filter(row => row.type === 'directory'
      && (row.path === norm || row.path.endsWith(`/${norm}`)))
    if (dirIntent) {
      if (dirRows.length === 0 || dirRows.length > 2) return []
      return dirRows.map(row => ({ kind: 'directory' as const, path: row.path }))
    }
    const fileRows = rows.filter(row => row.type === 'file'
      && (row.path === norm || row.path.endsWith(`/${norm}`)))
    const total = fileRows.length + dirRows.length
    if (total >= 1 && total <= 2) {
      return [
        ...fileRows.map(row => ({ kind: 'file' as const, path: row.path })),
        ...dirRows.map(row => ({ kind: 'directory' as const, path: row.path })),
      ]
    }
    // 3) flattened mention-token exact match: the client inserts
    // `@<flattened path>` chip tokens (`/` and `.` both become `-`), which
    // the built-in reference-chip scans require. One unique row → inject;
    // collisions (two paths flattening alike) or zero matches inject nothing.
    if (!dirIntent && norm.includes('-')) {
      const flattened = rows.filter(row => flattenPath(row.path) === norm)
      if (flattened.length === 1) {
        return [{ kind: flattened[0]!.type, path: flattened[0]!.path }]
      }
    }
    return []
  }

  /** Build the injected message for one resolved hit; undefined = contained failure. */
  private async buildRefMessage(hit: RefHit, cwd: string, signal: AbortSignal): Promise<UserMessage | undefined> {
    try {
      const text = hit.kind === 'file'
        ? await this.buildFileText(hit, cwd, signal)
        : await this.buildDirText(hit, cwd, signal)
      if (text === undefined) return undefined
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'snapshot',
          sections: [{ name, text }],
        },
      })
    } catch (error) {
      this.warn(`failed to read referenced ${hit.kind} "${hit.path}"`, error)
      return undefined
    }
  }

  private async buildFileText(hit: RefHit, cwd: string, signal: AbortSignal): Promise<string | undefined> {
    const target = hit.target ?? await this.ctx.fs.resolve(hit.path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') return undefined
    const read = await this.readFileText(target, info, signal)
    return fileContextText(hit.path, read)
  }

  /** readText for small files; streamText with a cap for large/unknown-size ones. */
  private async readFileText(target: FsTarget, info: FsInfo, signal: AbortSignal): Promise<BoundedText> {
    if (info.size !== undefined && info.size <= FILE_SAFE_SIZE_BYTES) {
      return bounded(await this.ctx.fs.readText(target, signal), FILE_TEXT_LIMIT)
    }
    let out = ''
    for await (const chunk of await this.ctx.fs.streamText(target, signal)) {
      out += chunk
      if (out.length >= FILE_TEXT_LIMIT) break
    }
    return bounded(out, FILE_TEXT_LIMIT)
  }

  /**
   * Codex-style directory snapshot: a depth-3 dir-first tree plus the text of
   * up to 8 small files inside it, under one 60 000-character budget.
   */
  private async buildDirText(hit: RefHit, cwd: string, signal: AbortSignal): Promise<string | undefined> {
    const target = hit.target ?? await this.ctx.fs.resolve(hit.path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'directory') return undefined

    const treeLines: string[] = [`${hit.path}/`]
    const contentCandidates: Array<{ rel: string; target: FsTarget; size: number | undefined }> = []
    let fileCount = 0
    let dirCount = 0
    const queue: Array<{ target: FsTarget; rel: string; depth: number }> = [
      { target, rel: hit.path, depth: 0 },
    ]
    while (queue.length > 0 && treeLines.length < DIR_TREE_LINES) {
      const current = queue.shift()!
      if (current.depth >= DIR_TREE_DEPTH) continue
      let entries: FsDirEntry[]
      try {
        entries = await this.ctx.fs.listDir(current.target, signal)
      } catch (error) {
        this.warn(`failed to list directory "${current.rel}" for dir context`, error)
        continue
      }
      const dirs = entries.filter(entry => entry.type === 'directory' && !NOISE_DIRS.has(entry.name))
      const files = entries.filter(entry => entry.type === 'file')
      for (const entry of [...dirs, ...files]) {
        if (treeLines.length >= DIR_TREE_LINES) break
        const rel = `${current.rel}/${entry.name}`
        if (entry.type === 'directory') {
          dirCount += 1
          treeLines.push(`${'  '.repeat(current.depth + 1)}${entry.name}/`)
          queue.push({ target: entry.target, rel, depth: current.depth + 1 })
        } else {
          fileCount += 1
          treeLines.push(`${'  '.repeat(current.depth + 1)}${entry.name}`)
          contentCandidates.push({ rel, target: entry.target, size: entry.size })
        }
      }
    }

    // File contents: ≤32 KB text files, binary-sniffed, ≤8 files.
    const sections: Array<{ rel: string; read: BoundedText }> = []
    for (const candidate of contentCandidates) {
      if (sections.length >= DIR_FILE_COUNT) break
      if (candidate.size !== undefined && candidate.size > DIR_FILE_SIZE_BYTES) continue
      let text: string
      try {
        text = await this.ctx.fs.readText(candidate.target, signal)
      } catch {
        continue
      }
      if (text.slice(0, 512).includes('\0')) continue
      sections.push({ rel: candidate.rel, read: bounded(text, DIR_FILE_TEXT_LIMIT) })
    }

    const counts = `${fileCount} files, ${dirCount} dirs; contents of ${sections.length} files included`
    const header = `The user referenced this workspace directory: ${hit.path}/ (${counts})`
    // Assemble under one message budget: header + tree first, then file
    // sections, each truncated to the remaining budget.
    const budgetFor = (prefix: string): number => Math.max(0, DIR_MESSAGE_LIMIT - prefix.length)
    let body = `${header}\n[directory tree]\n${treeLines.join('\n')}`
    const sectionsText: string[] = []
    if (sections.length > 0) {
      sectionsText.push('[file contents]')
      for (const section of sections) {
        const separator = `--- ${section.rel} ---\n`
        const remaining = budgetFor(`${body}\n${sectionsText.join('\n')}\n${separator}`)
        if (remaining <= 0) break
        const content = section.read.text
        const shown = content.length > remaining ? content.slice(0, remaining) : content
        const note = section.read.truncated || shown.length < content.length
          ? `\n… [truncated at ${shown.length} characters]`
          : ''
        sectionsText.push(`${separator}${shown}${note}`)
      }
    }
    body += `\n${sectionsText.join('\n')}`
    if (body.length > DIR_MESSAGE_LIMIT) {
      body = `${body.slice(0, DIR_MESSAGE_LIMIT)}\n… [directory context truncated]`
    }
    return `<dir_context>\n${body}\n</dir_context>`
  }

  // ── shared state ───────────────────────────────────────────────────────────

  private turnBudget(agentId: string, turn: number): { turn: number; paths: Set<string>; count: number } {
    const existing = this.turnState.get(agentId)
    if (existing !== undefined && existing.turn === turn) return existing
    const state = { turn, paths: new Set<string>(), count: 0 }
    this.turnState.set(agentId, state)
    // Bound the table: never keep more than 64 agent entries.
    if (this.turnState.size > 64) {
      for (const key of this.turnState.keys()) {
        if (key === agentId) continue
        this.turnState.delete(key)
        if (this.turnState.size <= 64) break
      }
    }
    return state
  }

  private warn(subject: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger('file-mention').warn(`%s: %s`, subject, message)
  }
}
