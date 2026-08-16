# dsh-dev-reloader

English | [中文](README.zh.md)

An official-format DeepSeek Harness (DSH) bundle that provides automatic reload and restart **for local development only**. Installed as a DSH plugin, it starts a detached dev supervisor that watches DSH source checkouts and locally linked plugins, and chooses config HMR, Cordis HMR, client HMR, or a full build-and-restart based on what changed.

> **Local-only warning**: This is for local development only. The supervisor watches real source, runs local build scripts, and may terminate and relaunch the DSH process. **Do not install on shared or production servers.** Build commands are trusted code from your local source projects and consume real local resources.

## What it does

- Built as an official host/client bundle; `dsh` connects to or starts the supervisor automatically on every launch — no separate `pnpm dev` needed for normal use.
- Auto-discovers DSH source checkouts and locally linked plugins (`link:` / `file:` / `workspace:`).
- Classifies each change and picks the strongest applicable action: config HMR, server HMR, client HMR, dependency-install + restart, or full build + restart.
- Waits for active work before a full restart; only the separately confirmed GUI **Force restart** action bypasses the activity gate and may interrupt work.
- Refreshes the original URL exactly once, only after the new host is HTTP-healthy and the new bridge `bootId` is ready.
- The detached supervisor survives DSH exit; normal stop, plugin HMR unload, disable, and host crash are distinguished.
- Crash recovery uses exponential backoff with a circuit breaker; self-update hands off through a one-use local channel.

## Compatibility

| Item | Requirement |
|---|---|
| Platforms | Linux, macOS, Windows |
| Node.js | `^22.19.0` or `>=24.0.0` |
| DSH | `0.1.0-rc.6` and the same ABI series |
| pnpm | 11 (`packageManager` declares `pnpm@11.8.0`; use 11.x for local dev) |
| Browser | Web platform (`dsh.client.platform` is `web`) |
| Install | GitHub bundle or local `link:`; **no npm release and no GitHub Release** |

## GitHub install

```sh
dsh plugin --profile web add github:lhzcode/dsh-dev-reloader
```

After the add command succeeds, restart DSH once so the new bundle joins the composition:

```sh
dsh web
```

After that the plugin connects to or starts the supervisor on every DSH launch.

## Precompiled GitHub bundle

The repository tracks the generated `lib/` distribution. GitHub installation uses those reviewed artifacts directly and does not run dependency build scripts, so users do not need to add this package to pnpm `allowBuilds`.

Contributors must run `pnpm build` and commit the matching `lib/` changes whenever source output changes. CI packs the committed distribution before rebuilding it, then rejects stale generated output.

## Local clone / build / link

```sh
git clone https://github.com/lhzcode/dsh-dev-reloader.git
cd dsh-dev-reloader
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add link:$PWD
```

You **must build `lib/` first**, then install with the absolute `link:$PWD`. After first load the supervisor can also watch this package and safely hand off to its own replacement.

## First restart and the GUI card

Restart DSH once (`dsh web`). The host bridge automatically connects to or starts the supervisor, which becomes ready once its watch plan is up. After a full restart DSH runs as a child of the supervisor.

The Web settings card (slot `settings.plugin.item`, namespace `dsh-dev-reloader`) uses the same staged form behavior and visual tokens as other plugin configuration cards. It exposes every supervisor field, marks unsaved edits, validates before Save, resets fields to the inherited DSH configuration, and keeps the immutable profile visible but read-only. The operations section shows the current phase and provides **rebuild**, **restart**, and **force restart**; force restart requires double confirmation and interrupts active work. On rc.6 Web builds that do not expose third-party settings namespaces, the card transparently uses a loopback-only namespace transport while DSH `SettingsProvider` remains the sole persistence and validation owner. The official `settingsScope` always takes precedence when available.

## Discovery and classification

- **DSH checkout**: root with `pnpm-workspace.yaml`, root package metadata naming the DSH root, and `apps/web`.
- **Linked plugins**: resolved through the current profile's `package.json` (`link:` / `file:` / `workspace:`), following the real path.
- Extra source roots can be set via `sourceRoots` (default: auto-discovered).

Default classification: `cordis.patch.yml` under profile/home → config HMR; server plugin source → build + Cordis HMR; client-plugin source → keep the `dev:web` watcher running and rely on client HMR; manifest/build config → build + full restart; DSH shell/shared packages → repo build + full restart; root lockfile → `pnpm install --frozen-lockfile` + full restart; docs/tests/Git/built output → ignored; unclassifiable runtime code → fail closed with a full build and restart.

## Configuration

All mutable fields are editable from the Web card, validated by DSH settings, and applied live; watch-affecting fields trigger an atomic watch-plan replacement. On the rc.6 compatibility path, Save sends one revision-fenced mutation batch; the official scope remains preferred and uses its native field mutation API. Reset removes the user overrides so schema defaults and composition values are inherited again.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Start the supervisor; `false` stops it and closes the connection |
| `profile` | string | `'web'` | Profile the supervisor serves (immutable at runtime) |
| `sourceRoots` | string[] | `[]` | Extra source-checkout roots (default auto-discovered) |
| `webUrl` | string | resolved from the Web host | Web URL the new host must keep |
| `debounceMs` | number | `250` | File-event debounce window |
| `healthTimeoutMs` | number | `60000` | Total health-check timeout for a new host |
| `shutdownGraceMs` | number | `10000` | Grace before escalating termination |
| `bridgeGraceMs` | number | `10000` | Grace for the bridge to reappear after HMR/start |
| `crashWindowMs` | number | `60000` | Crash-circuit observation window |
| `maxCrashRestarts` | number | `3` | Max crash restarts in the window before failing |
| `ignored` | string[] | `[]` | Additional ignore globs |
| `projectOverrides` | object[] | `[]` | Per-root `build` / `devWeb` (executable + argv) overrides |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` | Supervisor log level |

## Logs and troubleshooting

- Private runtime dir: `<DSH home>/plugins/dsh-dev-reloader/<profile>/` (`DSH_HOME` when set, otherwise DSH's canonical default; `0700` dirs and `0600` token/lock files on POSIX).
- Supervisor log: `supervisor.log` in that directory.
- Build failure keeps the old DSH serving and does not restart; retried on the next source change. A crash loop enters `failed` after `maxCrashRestarts` and recovers via the GUI "rebuild" or a DSH restart. A `pending-restart` wait clears once active agents/jobs finish, or with an explicit force restart.

## Pause and uninstall

- **Pause**: turn off the "Enable" toggle (`enabled:false`) — the supervisor stops and the connection closes; a running DSH is unaffected.
- **Uninstall**: remove the plugin (`dsh plugin --profile web remove dsh-dev-reloader`) and restart DSH. You may delete the leftover `<DSH home>/plugins/dsh-dev-reloader/` directory.

## Model experience

| Surface | Effect |
|---|---|
| System prompt | None |
| Model tools | None |
| Token cost | No per-request token cost |
| Session log | Reads activity only; adds no session events |
| Active work | Automatic and normal restarts wait; an explicitly confirmed force restart may interrupt work |

## Capability and security boundary

- Management ops are enabled only over loopback; non-loopback peers get redacted status at most and can never trigger a restart.
- GUI writes require a same-origin request validated server-side; proxied, cross-origin, or non-JSON requests are rejected.
- The local control channel (Unix socket; named pipe on Windows) and token files are restricted to the current user (`0700` / `0600`).
- Mutual-HMAC challenge-response proves knowledge of a random per-instance token; the token itself never crosses the wire.
- The full environment survives only in memory for a supervisor spawned by the current DSH — never written to state files or logs.
- Processes use executable + argv and never concatenate an untrusted command string. `shell:false` is retained except for the exact `pnpm`/`pnpm.cmd` shim boundary on Windows, where Node must invoke the trusted package-manager wrapper.
- Watchers only enter auto-discovered or explicitly configured real directories.
- Auto mode never force-interrupts active work; unknown activity waits by default.
- No remote/push capability; nothing is exported to external services.

## Development, testing, and contributing

Requirements: Node.js `^22.19.0 || >=24.0.0`, pnpm 11.

```sh
pnpm install
pnpm build
pnpm verify                 # typecheck + all tests + build
pnpm test:unit
pnpm test:integration      # includes bundle smoke
```

All automated tests use a temporary `DSH_HOME` and OS-assigned ephemeral ports; they never bind or replace `127.0.0.1:3080`. Read the [approved design](docs/design.md) and [implementation plan](docs/implementation-plan.md) before changing lifecycle behavior.

## Documentation

All non-package documentation is collected under [docs/](docs/README.md):

- [Architecture](docs/architecture.md)
- [Visual architecture](docs/architecture.html)
- [Approved design](docs/design.md)
- [Implementation plan](docs/implementation-plan.md)
- [Changelog](CHANGELOG.md)
- [Contributing guide](https://github.com/lhzcode/dsh-dev-reloader/blob/main/.github/CONTRIBUTING.md)
- [Security policy](https://github.com/lhzcode/dsh-dev-reloader/blob/main/.github/SECURITY.md)

## Known limitations

- Local development only: discovered source trees and their build scripts are trusted.
- The browser client is Web-only.
- Unusual checkout layouts may need explicit `sourceRoots` or `projectOverrides`.
- Changing the profile bundle list still requires restarting that profile.
- The package is installed from GitHub or a local checkout and is not published to npm.

## License

[MIT](LICENSE)
