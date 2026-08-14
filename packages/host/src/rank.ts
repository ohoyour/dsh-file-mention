/**
 * Candidate ranking shared verbatim between the Host `fileIndex.list`
 * filtering and the Client local candidate filtering (the two sides must
 * agree on order, see the handoff §0 requirement of a flicker-free menu).
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
 * Rank one row against a normalized query:
 * 0 base === query > 1 base.startsWith > 2 path.startsWith > 3 path.includes;
 * undefined = no match (filtered out). Directories compare with a trailing
 * `/` in their base so a `dir/` query matches them exactly.
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

/**
 * Filter and sort rows for a query: ascending rank, then ascending path
 * length, then lexical path order; capped at `limit`.
 */
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
