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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RankableRow } from './rank.ts';
/** Stable plugin identity used in injected message sources. */
export declare const name = "file-mention";
/** One index row: a file or directory of the workspace, relative to cwd. */
export interface IndexRow extends RankableRow {
    readonly type: 'file' | 'directory';
    readonly path: string;
    readonly name: string;
    readonly dir: string;
}
/** Request shape of the `fileIndex/list` Remote method. */
export interface IndexRequest {
    readonly query?: string;
}
/** Result shape of the `fileIndex/list` Remote method. */
export interface IndexResult {
    readonly files: readonly IndexRow[];
    /** Whether the returned rows cover the configured workspace scope. */
    readonly complete: boolean;
    /** Monotonic workspace revision; increments when Host observes a mutation. */
    readonly revision: number;
    /** Cache lifetime to use for the client's settled snapshot. */
    readonly cacheTtlMs: number;
}
/** Deployment controls for indexing and context injection. */
export interface Config {
    /** Directory names skipped while indexing and snapshotting. */
    noiseDirs: string[];
    /** Maximum number of file and directory rows in one workspace index. */
    indexLimit: number;
    /** Maximum directory traversal depth for the workspace index. */
    indexDepth: number;
    /** Maximum number of distinct workspace indexes retained in memory. */
    indexCacheEntries: number;
    /** Workspace index cache lifetime, in milliseconds. */
    indexTtlMs: number;
    /** Maximum rows retained by the shared query-search catalog. */
    searchIndexLimit: number;
    /** Maximum number of cwd query-search catalogs retained in memory. */
    searchCacheEntries: number;
    /** Maximum file size read through readText before streaming/truncation. */
    fileSafeSizeBytes: number;
    /** Maximum characters injected for one referenced file. */
    fileTextLimit: number;
    /** Maximum directory depth included in a directory snapshot. */
    dirTreeDepth: number;
    /** Maximum tree lines included in a directory snapshot. */
    dirTreeLines: number;
    /** Maximum file size eligible for directory snapshot contents. */
    dirFileSizeBytes: number;
    /** Maximum characters included for one directory snapshot file. */
    dirFileTextLimit: number;
    /** Maximum number of file contents included in one directory snapshot. */
    dirFileCount: number;
    /** Maximum total characters in one directory context message. */
    dirMessageLimit: number;
    /** Maximum estimated tokens injected by file/directory references per turn. */
    maxContextTokens: number;
    /** Maximum references injected during one turn. */
    maxRefsPerTurn: number;
}
/** Pre-step payload projection this plugin reads. */
interface PreStepPayload {
    readonly agent: Agent;
    readonly messages: readonly UserMessage[];
    readonly turn: number;
    readonly step: number;
    readonly signal: AbortSignal;
}
/** Cordis validates this schema before constructing the service. */
export declare const Config: Schema<Config>;
export interface ScannedReference {
    readonly index: number;
    readonly token: string;
    /** Structured references are exact paths and must not fall back to suffix matching. */
    readonly exact: boolean;
}
/** Decode the delimiter escaping used by the Client's ReferenceCodec. */
export declare function decodeFileReference(value: string): string | undefined;
/**
 * Extract reference tokens from one text block:
 * structured `@{path}` references, legacy `@token` mentions (trailing
 * punctuation stripped, dynamic plugin ids skipped), and backtick short paths
 * (whitespace-containing ones skipped), merged back into document order.
 */
export declare function scanReferences(text: string): ScannedReference[];
/** Backward-compatible token projection used by existing callers/tests. */
export declare function scanTokens(text: string): string[];
/**
 * The `fileIndex` Remote service + pre-step injection plugin.
 */
export default class FileIndexService extends TypertRemoteService {
    static inject: string[];
    static Config: Schema<Config>;
    private readonly config;
    private readonly noiseDirs;
    private readonly indexCache;
    private readonly indexFlights;
    private readonly searchCache;
    private readonly searchFlights;
    private readonly queryCache;
    private readonly queryFlights;
    /** Prevent an in-flight pre-mutation walk from repopulating the cache. */
    private readonly indexGenerations;
    /** Per-agent turn budget: at most 5 injected references per turn, deduped by path. */
    private readonly turnState;
    constructor(ctx: Context, config?: Config);
    /**
     * Remote method `fileIndex/list`. An empty query returns the complete
     * cached index; otherwise the shared ranking rules apply, capped at 20 rows.
     * Incomplete snapshots are explicitly marked so the Client can query the
     * Host instead of pretending that a capped snapshot is exhaustive.
     */
    list(agent: Agent, request: IndexRequest): Promise<IndexResult>;
    /** Cached, single-flight index of the agent's workspace. */
    ensureIndex(agent: Agent): Promise<IndexRow[]>;
    /** Invalidate cached snapshots after a mutation (or explicitly in tests). */
    invalidateIndex(cwd?: string): void;
    private deleteQueryEntries;
    private deleteSearchEntries;
    private ensureIndexSnapshot;
    private ensureIndexByCwd;
    /** Search the configured workspace scope when the bounded snapshot is partial. */
    private ensureQueryByCwd;
    /** Build one shared metadata catalog for all incomplete-snapshot queries. */
    private ensureSearchCatalogByCwd;
    /** BFS walk of the workspace: files and directories, noise dirs skipped. */
    private buildIndex;
    /** Full metadata walk shared by all queries until TTL or mutation invalidation. */
    private buildSearchIndex;
    /**
     * The prepended `agent/pre-step` listener body (exposed as a method for
     * unit testing; the constructor wires it with `{ prepend: true }`).
     */
    handlePreStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
    private collectInjected;
    /**
     * Resolve one token to 0–2 hits. A trailing `/` is directory intent.
     * Direct resolve+stat wins; otherwise index suffix matching picks
     * files first, then directories; 0 or >2 matches inject nothing.
     */
    private resolveRefs;
    /** Build the injected message for one resolved hit; undefined = contained failure. */
    private buildRefMessage;
    private buildFileText;
    /** readText for small files; streamText with a cap for large/unknown-size ones. */
    private readFileText;
    /**
     * Codex-style directory snapshot: a depth-3 dir-first tree plus the text of
     * up to 8 small files inside it, under one 60 000-character budget.
     */
    private buildDirText;
    private isInsideWorkspace;
    private estimateMessageTokens;
    private turnBudget;
    private warn;
}
export {};
//# sourceMappingURL=index.d.ts.map