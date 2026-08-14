# @ohoyo/dsh-file-mention

DeepSeek Harness profile bundle for the file/directory mention plugin. Registering
this package in a profile's `dsh.profile.bundles` applies `cordis.patch.yml`, which
inserts both composition rows:

```yaml
- insert:
    - id: file-mention-host
      name: '@ohoyo/dsh-file-mention-host'
    - id: client-file-mention
      name: '@ohoyo/dsh-client-ui-file-mention'
```

- `file-mention-host` is an ordinary host row (the `fileIndex` Remote service +
  `agent/pre-step` injection).
- `client-file-mention` carries the client package's `dsh.client` metadata; the
  modules node half scans it into `window.__DSH_BOOT__` and serves
  `/plugins/@ohoyo/dsh-client-ui-file-mention/client.js`.

The bundle declares both packages as `workspace:^` dependencies (rewritten to
concrete `^` versions by `pnpm publish` and `pnpm pack`) and ships no compiled entry of its own —
`lib/index.js` exists only so the package exports `"."` for tooling.

To tune the Host limits in a profile, override the inserted row in that
profile's `cordis.patch.yml` and keep the package name on the row:

```yaml
- id: file-mention-host
  name: '@ohoyo/dsh-file-mention-host'
  config:
    indexTtlMs: 30000
    maxRefsPerTurn: 3
```

All other fields retain their schema defaults.

## License

MIT
