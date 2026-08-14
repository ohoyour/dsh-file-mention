# @ohoyo/dsh-client-ui-file-mention

DeepSeek Harness web client half of the file/directory mention plugin: the **`@`
input-trigger source** (`trigger: '@'`, `name: 'file'`, `order: -1`).

## How it works

- The plugin's async `apply` first mounts a hand-written Typert contribution
  (`ctx.remote.$mount(TYPERT_REMOTE)`, namespace `fileIndex` — the third-party
  equivalent of what `@deepseek-ai/dsh-api-remotes` does for built-in namespaces),
  then registers the source.
- **No per-keystroke RPC**: a sessionId-level cache (host-configured TTL + single-flight)
  fetches the full index once (`fileIndex.list(sessionId, { query: '' })`) and
  `candidates()` filters/ranks locally with the same rules as the Host — the
  flicker-free guarantee.
- Candidates: files `📄` `name` + parent-dir description; directories `📁`
  `name/`; clashing basenames become `dir/名字` (directories keep `/`) so menu
  React keys stay unique.
- `onPick` returns the plain-text reference (the same decision as
  ui-skill / ui-subagent): `` `parent-last-segment/name` `` (directories with a
  trailing `/`); the Host pre-step boundary resolves it against the workspace.
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

Tests (vitest, 21 cases) cover contribution mounting, single-flight caching,
local filtering, basename disambiguation, short-form picks (file/directory),
failure containment, aborted keystrokes, TTL expiry, unsupported path names,
style cleanup, and the warm hook.

## License

MIT
