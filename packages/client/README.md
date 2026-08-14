# @ohoyo/dsh-client-ui-file-mention

DeepSeek Harness web client half of the file/directory mention plugin: the **`@`
input-trigger source** (`trigger: '@'`, `name: 'file'`, `order: -1`).

## How it works

- The plugin's async `apply` first mounts a hand-written Typert contribution
  (`ctx.remote.$mount(TYPERT_REMOTE)`, namespace `fileIndex` — the third-party
  equivalent of what `@deepseek-ai/dsh-api-remotes` does for built-in namespaces),
  then registers the source.
- A complete snapshot uses a sessionId-level cache (host-configured TTL +
  single-flight) and `candidates()` filters/ranks locally with the same rules as
  the Host — the flicker-free fast path. When the Host marks the snapshot
  `complete: false` because the workspace exceeds the index cap, each distinct
  non-empty query is resolved remotely and retained in a bounded per-session
  TTL cache. The Host shares one bounded metadata catalog across those queries,
  avoiding repeated workspace walks while typing. Incomplete-mode queries use a
  50 ms abort-aware debounce, so superseded keystrokes do not start an RPC.
  Each response also carries a Host mutation `revision`; if a query observes a
  newer revision than the base snapshot, the client returns that query result
  but discards its session cache so the next request refetches the base index.
- Candidates: files `📄` `name` + parent-dir description; directories `📁`
  `name/`; clashing basenames become `dir/名字` (directories keep `/`) so menu
  React keys stay unique.
- `onPick` returns a structured `ReferenceInsert` with the exact workspace path
  and a short display label. The source codec serializes it at submit time as
  `@{path}`, preserving spaces, punctuation, and duplicate basenames.
- `warm()` prewarms the session cache; every remote failure returns `[]` and logs.

## Build artifacts

- `lib/index.js` — empty node half so the composition row mounts on the Host.
- `lib/client.js` — the browser bundle: a CJS factory-form artifact that registers
  through `window.__ModuleLoader__.load({ id, factory })` (the harness
  `clientBundle` preset recipe), with `zod` inlined (the contribution codecs) and
  no `@deepseek-ai/*` value imports (bundle purity).

The `dsh.client` package.json metadata (`inject` + `platform: "web"`) is what the
modules node half scans into `window.__DSH_BOOT__` and serves as
`/plugins/<id>/client.js`.

## Development

```sh
pnpm build && pnpm test
```

Tests (vitest) cover contribution mounting, single-flight caching, local
filtering, basename disambiguation, structured picks (including spaces),
codec serialization, failure containment, aborted keystrokes, TTL expiry,
style cleanup, and the warm hook.

## License

MIT
