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

/**
 * The inserted plain-text mention for one row: `@<flattened full path>` —
 * the full relative path (not the short form) so the flattened token stays
 * unambiguous across directories.
 */
export function mentionToken(row: RankableRow): string {
  return `@${flattenPath(row.path)}`
}
