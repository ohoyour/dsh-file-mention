/**
 * Client-side candidate ranking and formatting. The ranking rules are the
 * same as the Host's (packages/host/src/rank.ts) so the menu order stays
 * stable between the first fetch and the local per-keystroke filtering.
 */

/** One index entry shape both sides rank over. */
export interface RankableRow {
  readonly type: 'file' | 'directory'
  /** Workspace-relative path, forward slashes, no trailing slash. */
  readonly path: string
  /** Basename. */
  readonly name: string
  /** Parent directory relative path ('' at the workspace root). */
  readonly dir: string
}

/** Normalize a query: lowercase, backslashes become forward slashes. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\\/g, '/')
}

/**
 * Rank one row against a query: 0 base === query > 1 base.startsWith >
 * 2 path.startsWith > 3 path.includes; undefined = no match. Directory
 * bases compare with a trailing `/`.
 */
export function rankScore(row: RankableRow, query: string): number | undefined {
  const q = normalizeQuery(query)
  if (q === '') return 0
  const base = (row.name + (row.type === 'directory' ? '/' : '')).toLowerCase()
  const path = row.path.toLowerCase()
  if (base === q) return 0
  if (base.startsWith(q)) return 1
  if (path.startsWith(q)) return 2
  if (path.includes(q)) return 3
  return undefined
}

/** Filter and sort rows for a query, capped at `limit`. */
export function rankRows<T extends RankableRow>(rows: readonly T[], query: string, limit = 20): T[] {
  const q = normalizeQuery(query)
  const scored: Array<{ row: T; score: number }> = []
  for (const row of rows) {
    const score = rankScore(row, q)
    if (score !== undefined) scored.push({ row, score })
  }
  scored.sort((a, b) => a.score - b.score
    || a.row.path.length - b.row.path.length
    || a.row.path.localeCompare(b.row.path))
  return scored.slice(0, limit).map(entry => entry.row)
}

/** One rendered menu candidate plus its backing row. */
export interface RankedCandidate<T extends RankableRow> {
  readonly name: string
  readonly description: string | undefined
  readonly icon: string
  readonly row: T
}

/**
 * Render candidates. Files: `name` with 📄; directories: `name/` with 📁.
 * When basenames clash (directories compared with their trailing `/`), the
 * name becomes `dir/名字` (+ `/` for directories) so menu React keys stay
 * unique.
 */
export function uniqueCandidates<T extends RankableRow>(rows: readonly T[]): Array<RankedCandidate<T>> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.type === 'directory' ? `${row.name}/` : row.name
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return rows.map((row) => {
    const base = row.type === 'directory' ? `${row.name}/` : row.name
    const clash = (counts.get(base) ?? 0) > 1
    const name = clash
      ? `${row.dir}/${row.name}${row.type === 'directory' ? '/' : ''}`
      : base
    return {
      name,
      description: row.dir === '' ? undefined : row.dir,
      icon: row.type === 'directory' ? '📁' : '📄',
      row,
    }
  })
}

/**
 * Flatten a workspace-relative path into a chip-compatible mention name:
 * both `/` and `.` become `-`, so the result matches the `[\w-]+` shape the
 * built-in reference-chip scans accept (the composer decoration scan and the
 * conversation bubble scan both reject `/` and `.`; backtick-wrapped paths
 * therefore never chip). The Host resolves the flattened token by applying
 * the same rule to every index row.
 */
export function flattenPath(path: string): string {
  return path.replace(/[/.]/g, '-')
}

/** Every flattened suffix token of a path (last 1..n segments). */
export function suffixFlattenTokens(path: string): string[] {
  const segments = path.split('/')
  const out: string[] = []
  for (let k = 1; k <= segments.length; k++) {
    out.push(flattenPath(segments.slice(-k).join('/')))
  }
  return out
}

/**
 * Frequency table of every flattened suffix token across the settled index:
 * the client picks each row's SHORTEST token whose frequency is 1 (see
 * `mentionToken`), and the Host accepts a token only when exactly one row
 * carries it as a suffix — both sides read the same table shape.
 */
export function buildMentionCounts(rows: readonly RankableRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const token of suffixFlattenTokens(row.path)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * The inserted plain-text mention for one row: `@<minimal unique suffix>`.
 * Base form — files: `parent-last-segment/name`, directories: `name` — is
 * extended one path segment at a time while its flattened token collides
 * with another row's suffix. `src/views/kabuto/statistics/warning-disposal-report/index.vue`
 * therefore yields `@warning-disposal-report-index-vue` (unique), while two
 * `b/x.ts` files in different parents yield `@a-b-x-ts` / `@c-b-x-ts`.
 */
export function mentionToken(row: RankableRow, counts: ReadonlyMap<string, number>): string {
  const segments = row.path.split('/')
  const baseLength = row.type === 'directory' ? 1 : Math.min(2, segments.length)
  for (let k = baseLength; k <= segments.length; k++) {
    const candidate = flattenPath(segments.slice(-k).join('/'))
    if ((counts.get(candidate) ?? 0) <= 1) return `@${candidate}`
  }
  // Everything collides (flatten collisions at the full path): emit the full
  // form; the Host's ambiguity rule skips it rather than injecting wrongly.
  return `@${flattenPath(row.path)}`
}

/** The mention name (token without `@`) — the lexicon roll entry per row. */
export function mentionName(row: RankableRow, counts: ReadonlyMap<string, number>): string {
  return mentionToken(row, counts).slice(1)
}

/**
 * The human display path for a row — the real path, slashes and dots intact:
 * files `parent-last-segment/name`, directories just their name with a
 * trailing `/` (Codex convention). This is the occurrence-chip LABEL
 * (arbitrary text, so special characters are fine); only the model-facing
 * token is flattened.
 */
export function displayPath(row: RankableRow): string {
  if (row.type === 'directory') return `${row.name}/`
  const segments = row.dir.split('/').filter(Boolean)
  const parent = segments[segments.length - 1]
  return parent === undefined || parent === '' ? row.name : `${parent}/${row.name}`
}
