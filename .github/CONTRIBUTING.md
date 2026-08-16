# Contributing

Thanks for improving `dsh-dev-reloader`. The plugin controls local build and restart processes, so changes should preserve its fail-closed security and activity-gating behavior.

## Development setup

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Requirements: Node.js `^22.19.0 || >=24.0.0` and pnpm 11.x.

## Pull requests

- Keep changes focused and add or update tests for behavior changes.
- Preserve executable-plus-argv command boundaries; do not concatenate untrusted shell strings.
- Treat IPC authentication, runtime paths, loopback authorization, activity gates, process ownership, and restart recovery as security-sensitive boundaries.
- Update both `README.md` and `README.zh.md` when user-visible behavior changes.
- Run `pnpm verify` and `git diff --check` before submitting.
- Do not include credentials, private paths, generated `lib/`, packaged tarballs, or local DSH runtime state.

## Security reports

Follow [SECURITY.md](SECURITY.md) instead of opening a public vulnerability issue.
