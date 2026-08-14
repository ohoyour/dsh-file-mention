# @ohoyo/dsh-file-mention-host

DeepSeek Harness host half of the @file/@directory mention plugin. A **class plugin**
(`export default FileIndexService extends TypertRemoteService` — the same mounting
pattern as `@deepseek-ai/dsh-cordis-host-runner`), it provides two capabilities:

## A. `fileIndex` Remote service

Typert namespace `fileIndex`, method `@Remote('list') list(agent, request)`:

- BFS-walks the session workspace (`agent.session.header.cwd`), indexing **files and
  directories** with `{ type, path, name, dir }` rows (relative, forward slashes).
- Skips noise dirs (`node_modules`, `.git`, `dist`, …), capped at 5000 rows / depth 14.
- Cached per cwd (TTL 15 s) with single-flight in-flight dedupe.
- `query: ''` returns the whole index (the client filters locally per keystroke);
  otherwise the shared ranking rules apply (base === query > base.startsWith >
  path.startsWith > path.includes, then path length, top 20).

The runtime has no generated typert descriptor, so the gateway's **SRC fallback**
derives the invocation descriptor from the `typertRemote` binding, the `@Remote`
marker, and the literal parameter names (`agent`, `request`) — the built
`lib/index.js` must keep them intact (tsdown does not minify).

## B. `agent/pre-step` reference injection

A prepended listener scans user-message text for `@token` and `` `short/path` ``
references (dynamic plugin ids `abc-123` are never hijacked) and resolves them:

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
  skipped — injection never blocks a turn.

## Development

```sh
pnpm build && pnpm test
```

Tests (vitest, 26 cases) cover the index (files + dirs, noise skipping, ranking),
the injection paths (`` `short/` ``, `` `short` ``, `@path`, suffix matching, dedupe,
5-ref cap, dynamic-id skip, reject/abort passthrough), and a real event-bus
integration that mounts the plugin as a class plugin and drives the scoped
`agent/pre-step` waterfall.

## License

MIT
