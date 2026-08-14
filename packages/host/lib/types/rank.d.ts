/**
 * Candidate ranking shared verbatim between the Host `fileIndex.list`
 * filtering and the Client local candidate filtering (the two sides must
 * agree on order, see the handoff §0 requirement of a flicker-free menu).
 */
/** One index entry shape both sides rank over. */
export interface RankableRow {
    readonly type: 'file' | 'directory';
    /** Workspace-relative path, forward slashes, no trailing slash. */
    readonly path: string;
    /** Basename. */
    readonly name: string;
    /** Parent directory relative path ('' at the workspace root). */
    readonly dir: string;
}
/** Normalize a query: lowercase, backslashes become forward slashes. */
export declare function normalizeQuery(query: string): string;
/**
 * Rank one row against a normalized query:
 * 0 base === query > 1 base.startsWith > 2 path.startsWith > 3 path.includes;
 * undefined = no match (filtered out). Directories compare with a trailing
 * `/` in their base so a `dir/` query matches them exactly.
 */
export declare function rankScore(row: RankableRow, query: string): number | undefined;
/**
 * Filter and sort rows for a query: ascending rank, then ascending path
 * length, then lexical path order; capped at `limit`.
 */
export declare function rankRows<T extends RankableRow>(rows: readonly T[], query: string, limit?: number): T[];
//# sourceMappingURL=rank.d.ts.map