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
 * B. `agent/pre-step` injection: scans user-message text for structured
 *    `@{exact/path}`, legacy `@path`, and `` `short/path` `` references.
 *    Structured references resolve directly; legacy references retain their
 *    direct-then-index-suffix compatibility behavior. Every I/O failure is
 *    contained and logged — injection never blocks a turn.
 *
 * The plugin is a class plugin (the loader honors `static inject` and the
 * TypertRemoteService constructor registers the `fileIndex` service), the
 * same mounting pattern as `@deepseek-ai/dsh-cordis-host-runner` and
 * `@deepseek-ai/dsh-message-feedback`.
 */

import { isAbsolute, normalize as normalizePath, relative as relativePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
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
  /** Cache lifetime to use for the client's settled snapshot. */
  readonly cacheTtlMs: number
}

/** Deployment controls for indexing and context injection. */
export interface Config {
  /** Directory names skipped while indexing and snapshotting. */
  noiseDirs: string[]
  /** Maximum number of file and directory rows in one workspace index. */
  indexLimit: number
  /** Maximum directory traversal depth for the workspace index. */
  indexDepth: number
  /** Maximum number of distinct workspace indexes retained in memory. */
  indexCacheEntries: number
  /** Workspace index cache lifetime, in milliseconds. */
  indexTtlMs: number
  /** Maximum file size read through readText before streaming/truncation. */
  fileSafeSizeBytes: number
  /** Maximum characters injected for one referenced file. */
  fileTextLimit: number
  /** Maximum directory depth included in a directory snapshot. */
  dirTreeDepth: number
  /** Maximum tree lines included in a directory snapshot. */
  dirTreeLines: number
  /** Maximum file size eligible for directory snapshot contents. */
  dirFileSizeBytes: number
  /** Maximum characters included for one directory snapshot file. */
  dirFileTextLimit: number
  /** Maximum number of file contents included in one directory snapshot. */
  dirFileCount: number
  /** Maximum total characters in one directory context message. */
  dirMessageLimit: number
  /** Maximum estimated tokens injected by file/directory references per turn. */
  maxContextTokens: number
  /** Maximum references injected during one turn. */
  maxRefsPerTurn: number
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

// ── defaults (see the handoff §0 / §5) ────────────────────────────────────────

/** Directories never entered while indexing or snapshotting. */
const DEFAULT_NOISE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', '.next',
  '.nuxt', '.output', '.nitro', '.cache', '.turbo', '.idea', '.vscode', 'vendor',
  '__pycache__', '.venv', 'venv', 'logs', 'tmp', 'temp', '.svn', '.hg', 'obj',
  '.pytest_cache', '.mypy_cache',
]

const DEFAULT_INDEX_LIMIT = 5000
const DEFAULT_INDEX_DEPTH = 14
const DEFAULT_INDEX_CACHE_ENTRIES = 32
const DEFAULT_INDEX_TTL_MS = 15_000

/** @file: whole-file read threshold; above (or unknown) stream-truncate. */
const DEFAULT_FILE_SAFE_SIZE_BYTES = 400 * 1024
const DEFAULT_FILE_TEXT_LIMIT = 60_000

/** @dir: tree snapshot budget. */
const DEFAULT_DIR_TREE_DEPTH = 3
const DEFAULT_DIR_TREE_LINES = 200
const DEFAULT_DIR_FILE_SIZE_BYTES = 32 * 1024
const DEFAULT_DIR_FILE_TEXT_LIMIT = 24_000
const DEFAULT_DIR_FILE_COUNT = 8
const DEFAULT_DIR_MESSAGE_LIMIT = 60_000
const DEFAULT_MAX_CONTEXT_TOKENS = 12_000

const DEFAULT_MAX_REFS_PER_TURN = 5

/** Defaults used by the Loader schema and direct unit-test construction. */
const DEFAULT_CONFIG: Config = {
  noiseDirs: DEFAULT_NOISE_DIRS,
  indexLimit: DEFAULT_INDEX_LIMIT,
  indexDepth: DEFAULT_INDEX_DEPTH,
  indexCacheEntries: DEFAULT_INDEX_CACHE_ENTRIES,
  indexTtlMs: DEFAULT_INDEX_TTL_MS,
  fileSafeSizeBytes: DEFAULT_FILE_SAFE_SIZE_BYTES,
  fileTextLimit: DEFAULT_FILE_TEXT_LIMIT,
  dirTreeDepth: DEFAULT_DIR_TREE_DEPTH,
  dirTreeLines: DEFAULT_DIR_TREE_LINES,
  dirFileSizeBytes: DEFAULT_DIR_FILE_SIZE_BYTES,
  dirFileTextLimit: DEFAULT_DIR_FILE_TEXT_LIMIT,
  dirFileCount: DEFAULT_DIR_FILE_COUNT,
  dirMessageLimit: DEFAULT_DIR_MESSAGE_LIMIT,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  maxRefsPerTurn: DEFAULT_MAX_REFS_PER_TURN,
}

const natural = () => Schema.natural()
const positiveInteger = () => Schema.natural().min(1)

/** Cordis validates this schema before constructing the service. */
export const Config: Schema<Config> = Schema.object({
  noiseDirs: Schema.array(Schema.string()).default([...DEFAULT_NOISE_DIRS]),
  indexLimit: positiveInteger().default(DEFAULT_INDEX_LIMIT),
  indexDepth: natural().default(DEFAULT_INDEX_DEPTH),
  indexCacheEntries: positiveInteger().default(DEFAULT_INDEX_CACHE_ENTRIES),
  indexTtlMs: positiveInteger().default(DEFAULT_INDEX_TTL_MS),
  fileSafeSizeBytes: natural().default(DEFAULT_FILE_SAFE_SIZE_BYTES),
  fileTextLimit: natural().default(DEFAULT_FILE_TEXT_LIMIT),
  dirTreeDepth: natural().default(DEFAULT_DIR_TREE_DEPTH),
  dirTreeLines: natural().default(DEFAULT_DIR_TREE_LINES),
  dirFileSizeBytes: natural().default(DEFAULT_DIR_FILE_SIZE_BYTES),
  dirFileTextLimit: natural().default(DEFAULT_DIR_FILE_TEXT_LIMIT),
  dirFileCount: natural().default(DEFAULT_DIR_FILE_COUNT),
  dirMessageLimit: natural().default(DEFAULT_DIR_MESSAGE_LIMIT),
  maxContextTokens: positiveInteger().default(DEFAULT_MAX_CONTEXT_TOKENS),
  maxRefsPerTurn: natural().default(DEFAULT_MAX_REFS_PER_TURN),
})

// ── token scanning ───────────────────────────────────────────────────────────

const AT_TOKEN_RE = /(?:^|[\s\u3000])@([^\s@]+)/g
const BRACED_REFERENCE_RE = /(?:^|[\s\u3000])@\{([^}\n]*)\}/g
const BACKTICK_TOKEN_RE = /`([^`\n]+)`/g
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、"')\]}>]+$/
/** Dynamic Cordis plugin ids like `abc-123` must never be hijacked. */
const DYNAMIC_PLUGIN_ID_RE = /^[a-z]{3,6}-\d+$/i

export interface ScannedReference {
  readonly index: number
  readonly token: string
  /** Structured references are exact paths and must not fall back to suffix matching. */
  readonly exact: boolean
}

/** Decode the delimiter escaping used by the Client's ReferenceCodec. */
export function decodeFileReference(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Extract reference tokens from one text block:
 * structured `@{path}` references, legacy `@token` mentions (trailing
 * punctuation stripped, dynamic plugin ids skipped), and backtick short paths
 * (whitespace-containing ones skipped), merged back into document order.
 */
export function scanReferences(text: string): ScannedReference[] {
  const found: ScannedReference[] = []
  for (const match of text.matchAll(BRACED_REFERENCE_RE)) {
    const encoded = match[1] ?? ''
    if (encoded === '') continue
    const token = decodeFileReference(encoded)
    if (token === undefined || token === '') continue
    found.push({ index: match.index, token, exact: true })
  }
  for (const match of text.matchAll(AT_TOKEN_RE)) {
    const raw = match[1] ?? ''
    const token = raw.replace(TRAILING_PUNCT_RE, '')
    if (token === '') continue
    if (DYNAMIC_PLUGIN_ID_RE.test(token)) continue
    // A braced reference is handled by the exact scanner above. Do not also
    // treat its opening fragment as a legacy token.
    if (token.startsWith('{')) continue
    found.push({ index: match.index, token, exact: false })
  }
  for (const match of text.matchAll(BACKTICK_TOKEN_RE)) {
    const token = match[1] ?? ''
    if (token === '' || /\s/.test(token)) continue
    found.push({ index: match.index, token, exact: false })
  }
  return found
    .sort((a, b) => a.index - b.index)
}

/** Backward-compatible token projection used by existing callers/tests. */
export function scanTokens(text: string): string[] {
  return scanReferences(text).map(entry => entry.token)
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
 * Flatten a legacy path token into the chip-compatible mention shape used by
 * old drafts: `/` and `.` both become `-` (mirror of the client's
 * `flattenPath`).
 */
function flattenPath(path: string): string {
  return path.replace(/[/.]/g, '-')
}

/**
 * Every flattened suffix token of a workspace-relative path (last 1..n
 * segments). Legacy client drafts emit `@<minimal unique suffix>` chips
 * (files: `parent/name`, directories: `name`, extended on collisions), so a
 * token resolves to the single row that carries it as some suffix.
 */
function suffixFlattenTokens(path: string): string[] {
  const segments = path.split('/')
  const out: string[] = []
  for (let k = 1; k <= segments.length; k++) {
    out.push(flattenPath(segments.slice(-k).join('/')))
  }
  return out
}

/** Workspace-relative display path for a directly-resolved token. */
function relFor(cwd: string, token: string): string {
  const value = isAbsolute(token) ? relativePath(cwd, token) : token
  const rel = normalizePath(value).replace(/\\/g, '/').replace(/^\.\//, '')
  return rel.replace(/\/+$/, '')
}

/** Format the `<file_context>` message text (handoff template). */
function fileContextText(rel: string, read: BoundedText, limit: number): string {
  const content = read.truncated
    ? `${read.text}\n… [truncated at ${limit} characters]`
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
  static Config: Schema<Config> = Config

  private readonly config: Config
  private readonly noiseDirs: ReadonlySet<string>
  private readonly indexCache = new Map<string, { rows: IndexRow[]; at: number }>()
  private readonly indexFlights = new Map<string, Promise<IndexRow[]>>()
  /** Per-agent turn budget: at most 5 injected references per turn, deduped by path. */
  private readonly turnState = new Map<string, {
    turn: number
    paths: Set<string>
    count: number
    contextTokens: number
  }>()

  constructor(ctx: Context, config: Config = DEFAULT_CONFIG) {
    super(ctx, 'fileIndex')
    this.config = config
    this.noiseDirs = new Set(config.noiseDirs)
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
    if (query.trim() === '') return { files: rows, cacheTtlMs: this.config.indexTtlMs }
    return { files: rankRows(rows, query, 20), cacheTtlMs: this.config.indexTtlMs }
  }

  /** Cached, single-flight index of the agent's workspace. */
  async ensureIndex(agent: Agent): Promise<IndexRow[]> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return []
    return this.ensureIndexByCwd(cwd)
  }

  private ensureIndexByCwd(cwd: string): Promise<IndexRow[]> {
    const cached = this.indexCache.get(cwd)
    if (cached !== undefined && Date.now() - cached.at < this.config.indexTtlMs) {
      this.indexCache.delete(cwd)
      this.indexCache.set(cwd, cached)
      return Promise.resolve(cached.rows)
    }
    const flight = this.indexFlights.get(cwd)
    if (flight !== undefined) return flight
    const build = this.buildIndex(cwd).then((rows) => {
      this.indexCache.set(cwd, { rows, at: Date.now() })
      while (this.indexCache.size > this.config.indexCacheEntries) {
        const oldest = this.indexCache.keys().next().value
        if (oldest === undefined) break
        this.indexCache.delete(oldest)
      }
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
    let head = 0
    while (head < queue.length && rows.length < this.config.indexLimit) {
      const { target, rel, depth } = queue[head++]!
      let entries: FsDirEntry[]
      try {
        entries = await this.ctx.fs.listDir(target)
      } catch (error) {
        this.warn(`failed to list directory "${rel || cwd}"`, error)
        continue
      }
      for (const entry of entries) {
        if (rows.length >= this.config.indexLimit) break
        if (!this.ctx.fs.contains(root, entry.target)) {
          this.warn(`skipping workspace entry outside root: "${entry.name}"`, 'outside workspace')
          continue
        }
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.type === 'directory') {
          if (this.noiseDirs.has(entry.name)) continue
          rows.push({ type: 'directory', path, name: entry.name, dir: rel })
          if (depth < this.config.indexDepth) {
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
      if (payload.signal.aborted || injected.length === 0) return decision
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
        for (const reference of scanReferences(block.text)) {
          const { token } = reference
          if (signal.aborted || state.count >= this.config.maxRefsPerTurn) return injected
          let hits: RefHit[]
          try {
            hits = await this.resolveRefs(cwd, token, signal, reference.exact)
          } catch (error) {
            if (signal.aborted) return injected
            this.warn(`failed to resolve reference "${token}"`, error)
            continue
          }
          for (const hit of hits) {
            if (signal.aborted || state.count >= this.config.maxRefsPerTurn) return injected
            if (state.paths.has(hit.path)) continue
            const remainingTokens = this.config.maxContextTokens - state.contextTokens
            if (remainingTokens <= 0) return injected
            const built = await this.buildRefMessage(
              hit,
              cwd,
              signal,
              Math.max(256, remainingTokens * 4),
            )
            if (signal.aborted) return injected
            if (built === undefined) continue
            const estimatedTokens = this.estimateMessageTokens(built)
            if (estimatedTokens > remainingTokens) {
              this.warn(
                `skipping referenced ${hit.kind} "${hit.path}" because its context `
                + `estimate (${estimatedTokens} tokens) exceeds the remaining `
                + `budget (${remainingTokens} tokens)`,
                'context budget',
              )
              continue
            }
            state.paths.add(hit.path)
            injected.push(built)
            state.count += 1
            state.contextTokens += estimatedTokens
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
  private async resolveRefs(
    cwd: string,
    token: string,
    signal: AbortSignal,
    exact = false,
  ): Promise<RefHit[]> {
    const norm = normPath(token)
    if (norm === '') return []
    const dirIntent = token.endsWith('/')
    // 1) direct resolution
    try {
      const root = await this.ctx.fs.resolve(cwd, { signal })
      const target = await this.ctx.fs.resolve(token, { cwd, signal })
      if (!this.ctx.fs.contains(root, target)) return []
      const info = await this.ctx.fs.stat(target, signal)
      if (info !== undefined && (info.type === 'file' || info.type === 'directory')) {
        if (dirIntent && info.type !== 'directory') return []
        const rel = relFor(cwd, norm)
        return [{ kind: info.type, path: rel, target }]
      }
    } catch {
      if (exact) return []
      // fall through to index suffix matching for legacy references
    }
    if (exact) return []
    if (signal.aborted) return []
    // 2) index suffix matching
    const rows = await this.ensureIndexByCwd(cwd)
    if (signal.aborted) return []
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
    // 3) flattened legacy mention-token suffix matching: old client drafts
    // contain `@<minimal unique suffix>` tokens (`/` and `.` both become `-`),
    // which the built-in reference-chip scans require. A token resolves when
    // exactly one index row carries it as a flattened suffix; collisions
    // (two rows sharing the token) or zero matches inject nothing.
    if (!dirIntent) {
      const matched = rows.filter(row => suffixFlattenTokens(row.path).includes(norm))
      if (matched.length === 1) {
        return [{ kind: matched[0]!.type, path: matched[0]!.path }]
      }
    }
    return []
  }

  /** Build the injected message for one resolved hit; undefined = contained failure. */
  private async buildRefMessage(
    hit: RefHit,
    cwd: string,
    signal: AbortSignal,
    charLimit: number,
  ): Promise<UserMessage | undefined> {
    try {
      const text = hit.kind === 'file'
        ? await this.buildFileText(hit, cwd, signal, charLimit)
        : await this.buildDirText(hit, cwd, signal, charLimit)
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
      if (signal.aborted) return undefined
      this.warn(`failed to read referenced ${hit.kind} "${hit.path}"`, error)
      return undefined
    }
  }

  private async buildFileText(
    hit: RefHit,
    cwd: string,
    signal: AbortSignal,
    charLimit: number,
  ): Promise<string | undefined> {
    const target = hit.target ?? await this.ctx.fs.resolve(hit.path, { cwd, signal })
    if (!(await this.isInsideWorkspace(cwd, target, signal))) return undefined
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') return undefined
    const limit = Math.min(this.config.fileTextLimit, charLimit)
    const read = await this.readFileText(target, info, signal, limit)
    return fileContextText(hit.path, read, limit)
  }

  /** readText for small files; streamText with a cap for large/unknown-size ones. */
  private async readFileText(
    target: FsTarget,
    info: FsInfo,
    signal: AbortSignal,
    limit: number,
  ): Promise<BoundedText> {
    if (info.size !== undefined && info.size <= this.config.fileSafeSizeBytes) {
      return bounded(await this.ctx.fs.readText(target, signal), limit)
    }
    let out = ''
    for await (const chunk of await this.ctx.fs.streamText(target, signal)) {
      out += chunk
      if (out.length >= limit) break
    }
    return bounded(out, limit)
  }

  /**
   * Codex-style directory snapshot: a depth-3 dir-first tree plus the text of
   * up to 8 small files inside it, under one 60 000-character budget.
   */
  private async buildDirText(
    hit: RefHit,
    cwd: string,
    signal: AbortSignal,
    charLimit: number,
  ): Promise<string | undefined> {
    const messageLimit = Math.min(this.config.dirMessageLimit, charLimit)
    const target = hit.target ?? await this.ctx.fs.resolve(hit.path, { cwd, signal })
    const root = await this.ctx.fs.resolve(cwd, { signal })
    if (!this.ctx.fs.contains(root, target)) return undefined
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'directory') return undefined

    const treeLines: string[] = [`${hit.path}/`]
    const contentCandidates: Array<{ rel: string; target: FsTarget; size: number | undefined }> = []
    let fileCount = 0
    let dirCount = 0
    const queue: Array<{ target: FsTarget; rel: string; depth: number }> = [
      { target, rel: hit.path, depth: 0 },
    ]
    let head = 0
    while (head < queue.length && treeLines.length < this.config.dirTreeLines) {
      if (signal.aborted) return undefined
      const current = queue[head++]!
      if (current.depth >= this.config.dirTreeDepth) continue
      let entries: FsDirEntry[]
      try {
        entries = await this.ctx.fs.listDir(current.target, signal)
      } catch (error) {
        if (signal.aborted) return undefined
        this.warn(`failed to list directory "${current.rel}" for dir context`, error)
        continue
      }
      const dirs = entries.filter(entry => entry.type === 'directory' && !this.noiseDirs.has(entry.name))
      const files = entries.filter(entry => entry.type === 'file')
      for (const entry of [...dirs, ...files]) {
        if (!this.ctx.fs.contains(root, entry.target)) continue
        if (treeLines.length >= this.config.dirTreeLines) break
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
      if (signal.aborted) return undefined
      if (sections.length >= this.config.dirFileCount) break
      if (candidate.size !== undefined && candidate.size > this.config.dirFileSizeBytes) continue
      let text: string
      try {
        text = await this.ctx.fs.readText(candidate.target, signal)
      } catch (error) {
        if (signal.aborted) return undefined
        continue
      }
      if (text.slice(0, 512).includes('\0')) continue
      sections.push({ rel: candidate.rel, read: bounded(text, this.config.dirFileTextLimit) })
    }
    if (signal.aborted) return undefined

    const counts = `${fileCount} files, ${dirCount} dirs; contents of ${sections.length} files included`
    const header = `The user referenced this workspace directory: ${hit.path}/ (${counts})`
    // Assemble under one message budget: header + tree first, then file
    // sections, each truncated to the remaining budget.
    const budgetFor = (prefix: string): number => Math.max(0, messageLimit - prefix.length)
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
    if (body.length > messageLimit) {
      const note = '\n… [directory context truncated]'
      body = `${body.slice(0, Math.max(0, messageLimit - note.length))}${note}`
    }
    return `<dir_context>\n${body}\n</dir_context>`
  }

  private async isInsideWorkspace(cwd: string, target: FsTarget, signal: AbortSignal): Promise<boolean> {
    const root = await this.ctx.fs.resolve(cwd, { signal })
    return this.ctx.fs.contains(root, target)
  }

  // ── shared state ───────────────────────────────────────────────────────────

  private estimateMessageTokens(message: UserMessage): number {
    const meter = this.ctx.get('tokenMeter') as { estimateMessage?: (value: unknown) => number } | undefined
    if (meter?.estimateMessage !== undefined) {
      try {
        const measured = meter.estimateMessage(message)
        if (Number.isFinite(measured) && measured > 0) return Math.ceil(measured)
      } catch (error) {
        this.warn('token meter failed to estimate file context; using character fallback', error)
      }
    }
    const chars = message.content.reduce((total, block) => (
      block.type === 'text' ? total + block.text.length : total
    ), 0)
    return Math.max(1, Math.ceil(chars / 4))
  }

  private turnBudget(agentId: string, turn: number): {
    turn: number
    paths: Set<string>
    count: number
    contextTokens: number
  } {
    const existing = this.turnState.get(agentId)
    if (existing !== undefined && existing.turn === turn) return existing
    const state = { turn, paths: new Set<string>(), count: 0, contextTokens: 0 }
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
