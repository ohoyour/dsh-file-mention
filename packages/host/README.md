# @ohoyo/dsh-file-mention-host

DeepSeek Harness host half of the @file/@directory mention plugin. A **class plugin**
(`export default FileIndexService extends TypertRemoteService` — the same mounting
pattern as `@deepseek-ai/dsh-cordis-host-runner`), it provides two capabilities:

## A. `fileIndex` Remote service

Typert namespace `fileIndex`, method `@Remote('list') list(agent, request)`:

- BFS-walks the session workspace (`agent.session.header.cwd`), indexing **files and
  directories** with `{ type, path, name, dir }` rows (relative, forward slashes).
- Skips noise dirs (`node_modules`, `.git`, `dist`, …), capped at 5000 rows / depth 14.
- Cached per cwd (default TTL 15 s; configurable) with single-flight in-flight dedupe;
  the cache keeps at most 32 cwd indexes (`indexCacheEntries`). Successful `write`
  and `edit` filesystem observations invalidate the cached snapshots.
- `query: ''` returns the snapshot plus `complete` and a monotonic `revision`;
  `complete: false` means the
  configured row cap or a listing failure prevented an exhaustive walk. Otherwise
  the shared ranking rules apply (base === query > base.startsWith >
  path.startsWith > path.includes, then path length, top 20). For an incomplete
  snapshot, the first non-empty query builds a shared cwd metadata catalog;
  subsequent queries reuse it and only cache their top matches. The catalog is
  bounded by `searchIndexLimit` rows and `searchCacheEntries` workspaces.

The runtime has no generated typert descriptor, so the gateway's **SRC fallback**
derives the invocation descriptor from the `typertRemote` binding, the `@Remote`
marker, and the literal parameter names (`agent`, `request`) — the built
`lib/index.js` must keep them intact (tsdown does not minify).

## B. `agent/pre-step` reference injection

A prepended listener scans user-message text for structured `@{exact/path}`,
legacy `@token`, and `` `short/path` `` references (dynamic plugin ids
`abc-123` are never hijacked) and resolves them:

- Structured `@{exact/path}` references are decoded and resolved only as the
  exact workspace-relative path. Paths containing spaces and delimiter
  characters round-trip through the Client codec.
- Legacy references retain the compatibility behavior below:

1. token with trailing `/` = directory intent → direct resolve+stat, else index
   suffix match among directories;
2. otherwise direct resolve+stat first, then index suffix match (files before
   directories); 0 or >2 matches inject nothing.

- **@file** → `<file_context>` with the full content (≤400 KB via `readText`,
  larger/unknown via `streamText`, capped at 60 000 chars with a truncation note).
- **@dir** → `<dir_context>` Codex-style snapshot: depth-3 dir-first tree (≤200
  lines) plus up to 8 text files (≤32 KB, binary-sniffed, 24 000 chars each) under
  a 60 000-char total budget.
- At most 5 references per turn, deduped by path; every I/O failure is logged and
  skipped — injection never blocks a turn. The default aggregate context budget
  is 12,000 estimated tokens (`maxContextTokens`); Harness `tokenMeter` is used
  when available, otherwise a conservative character estimate is used.

## Configuration

The plugin exports a Schemastery `Config` schema. Defaults preserve the limits
above, while deployments can override index depth/size/TTL and directory/file
context budgets from the composition row's `config` object. The `fileIndex/list`
  response carries the configured index TTL and mutation revision to the browser
  so host and client caches use one policy and can discard stale query results.
  Large-workspace query catalogs are independently bounded
  by `searchIndexLimit` (default 100,000 rows) and `searchCacheEntries` (default 4).

## Development

```sh
pnpm build && pnpm test
```

Tests (vitest) cover the index (files + dirs, noise skipping, ranking),
the injection paths (`` `short/` ``, `` `short` ``, `@path`, suffix matching, dedupe,
5-ref cap, dynamic-id skip, reject/abort passthrough), and a real event-bus
integration that mounts the plugin as a class plugin and drives the scoped
`agent/pre-step` waterfall.

## License

MIT
