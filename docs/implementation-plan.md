# DSH Dev Reloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an official-format DSH bundle that starts a detached local-development supervisor, automatically builds or reloads DSH and linked plugins, waits for active work before full restarts, and refreshes the original Web GUI once recovery is healthy.

**Architecture:** A Cordis host bridge owns DSH-facing settings, activity observation, and same-origin routes; a detached Node supervisor owns discovery, watching, builds, process lifecycle, and local authenticated IPC; a client-plugin owns the settings card and once-only browser recovery. Shared protocol and state modules are the only contracts between layers, and every external effect is behind a test seam.

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`, TypeScript 6, ESM host/supervisor output, DSH factory-form CJS browser output, pnpm 11, Cordis 4, DSH `0.1.0-rc.6`, Schemastery, Chokidar 4, React 18, tsdown, Vitest 4, node:http, node:net, node:child_process.

## Global Constraints

- The product is for local development only; it is not a production process manager.
- The package name and Cordis id are exactly `dsh-dev-reloader`; the settings namespace is exactly `dsh-dev-reloader`.
- The primary install path is `dsh plugin --profile web add github:lhzcode/dsh-dev-reloader`; local development uses an absolute `link:` spec.
- The plugin must start or reuse the supervisor automatically after its first DSH load; no separate `pnpm dev` command is part of normal use.
- Reuse DSH configuration HMR, Cordis HMR, and client HMR; implement only orchestration around them.
- Automatic full restarts wait indefinitely while activity is nonzero or unknown. Only the explicit GUI force action may bypass the gate.
- Preserve the exact Node executable, execArgv, argv, cwd, inherited in-memory environment, profile, and Web URL across restart.
- Browser reload happens once, only after HTTP health and the new bridge `bootId` are both ready.
- Tests use temporary `DSH_HOME` directories and OS-assigned ports; no automated test may bind or replace `127.0.0.1:3080`.
- Spawn executable plus argv arrays with `shell: false`; never compose an untrusted shell string.
- State and logs must not persist environment variables, tokens, authorization headers, or complete sensitive command output.
- POSIX state directories use mode `0700`; token and lock files use mode `0600`. Windows uses a per-user named pipe and the same random-token handshake.
- Unknown source code impact fails closed to a full build/restart plan; unknown lock ownership fails closed and is never stolen.
- `README.md` is the English default entry and `README.zh.md` is the Chinese translation, matching the DSH plugin convention. Neither compares named community plugins.
- Do not publish npm packages or GitHub Releases. The final remote is the public repository `lhzcode/dsh-dev-reloader`.
- Follow TDD for every behavior task: failing test, observed failure, minimal implementation, passing focused test, broader verification, commit.

---

## File Map

### Package and build surface

- `package.json` — official DSH bundle/client metadata, exports, scripts, engines, dependencies.
- `cordis.patch.yml` — inserts one `dsh-dev-reloader` host plugin entry.
- `tsconfig.json` — strict host/supervisor/client declaration build.
- `tsdown.config.ts` — bundles only the browser entry to the DSH factory-loader artifact `lib/client.js`.
- `vitest.config.ts` — unit/integration test selection and timeouts.
- `.gitignore` — ignores local state while the precompiled `lib/` distribution remains tracked.
- `LICENSE` — MIT license.

### Shared contracts

- `src/shared/protocol.ts` — versioned bridge/supervisor/browser messages, bounded parsing, public redaction.
- `src/shared/state.ts` — legal supervisor state transitions and public status projection.
- `src/shared/config.ts` — serializable supervisor configuration shared by host and supervisor.

### Supervisor core

- `src/supervisor/paths.ts` — state directory, socket/pipe, token, lock, log paths.
- `src/supervisor/lock.ts` — single-instance lease and stale-lock proof.
- `src/supervisor/ipc.ts` — authenticated length-bounded NDJSON server/client.
- `src/supervisor/discovery.ts` — DSH checkout and local bundle discovery.
- `src/supervisor/classifier.ts` — pure change-to-action classification and action merging.
- `src/supervisor/runner.ts` — argv-only one-shot and persistent child execution with bounded output.
- `src/supervisor/watcher.ts` — Chokidar watch-plan lifecycle and output filtering.
- `src/supervisor/scheduler.ts` — debounce, serialization, dirty follow-up cycles.
- `src/supervisor/task-gate.ts` — bridge/local activity snapshots and fail-closed waiting.
- `src/supervisor/health-check.ts` — bounded HTTP plus bridge readiness checks.
- `src/supervisor/lifecycle.ts` — host adoption, graceful restart, crash recovery, stop semantics.
- `src/supervisor/handoff.ts` — authenticated prepare/commit/abort supervisor replacement.
- `src/supervisor/supervisor.ts` — orchestration over the preceding interfaces only.
- `src/supervisor/cli.ts` — real-adapter composition and detached/handoff bootstrap.

### Host bridge

- `src/bridge/activity.ts` — Agent/job activity snapshot adapter.
- `src/bridge/client.ts` — supervisor IPC connection and status store.
- `src/bridge/routes.ts` — loopback-only status/health/command routes.
- `src/bridge/spawn.ts` — detached supervisor startup and launch-spec capture.
- `src/index.ts` — Config schema, settings wiring, bridge composition, Cordis exports.

### Browser client

- `src/client/context-types.ts` — DSH client declaration merges.
- `src/client/locales.ts` — Chinese and English copy.
- `src/client/api.ts` — same-origin host status/command transport.
- `src/client/reconnect.ts` — pure bootId decision plus polling/sessionStorage adapter.
- `src/client/SettingsCard.tsx` — settings card and status/actions.
- `src/client/styles.ts` — namespaced CSS injection.
- `src/client/index.tsx` — locale, settings scope, status store, slot registration.

### Tests and fixtures

- `tests/unit/*.test.ts` — pure and adapter-focused tests mirroring source modules.
- `tests/helpers/temp-layout.ts` — temporary DSH home/profile/checkouts and symlinks.
- `tests/helpers/process-harness.ts` — bounded child start/output/cleanup utilities.
- `tests/helpers/eventually.ts` — deadline assertions without arbitrary sleeps.
- `tests/fixtures/fake-host.ts` — ephemeral health server and signal/bridge recorder.
- `tests/fixtures/fake-builder.ts` — configurable build success/failure/blocking recorder.
- `tests/integration/*.test.ts` — singleton, build routing, gate, restart, crash, handoff, bundle smoke.

### Documentation and automation

- `README.md`, `README.zh.md` — install, use, security, troubleshooting, development.
- `docs/architecture.md` — short current architecture derived from the approved spec.
- `.github/workflows/ci.yml` — Node 22/24 checks on Linux, macOS, Windows.

---

### Task 1: Package Foundation and Shared Contracts

**Files:**
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `tsconfig.json`
- Create: `tsdown.config.ts`
- Create: `vitest.config.ts`
- Create: `src/shared/config.ts`
- Create: `src/shared/protocol.ts`
- Create: `src/index.ts` (minimal buildable host entry, expanded in Task 10)
- Create: `src/client/index.tsx` (minimal buildable client entry, expanded in Task 11)
- Create: `src/shared/state.ts`
- Create: `tests/unit/protocol.test.ts`
- Create: `tests/unit/state.test.ts`

**Interfaces:**
- Produces: `SupervisorConfig`, `CommandTemplate`, `HostLaunchSpec`, `ActivitySnapshot`, `BridgeHello`, `BridgeEvent`, `SupervisorCommand`, `SupervisorEvent`, `PublicSupervisorStatus`, `transitionSupervisorState()`, `parseWireEnvelope()`.
- Consumes: no project code.

- [ ] **Step 1: Create package metadata and build configuration**

Use the exact package identity and official bundle shape:

```json
{
  "name": "dsh-dev-reloader",
  "version": "0.1.0",
  "description": "Local-development auto reload and restart supervisor for DeepSeek Harness",
  "license": "MIT",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "packageManager": "pnpm@11.8.0",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-settings-plugins"
      ],
      "platform": "web"
    }
  },
  "files": ["lib/**/*.js", "lib/**/*.map", "lib/types/**/*.d.ts", "cordis.patch.yml", "src", "README.md", "README.zh.md", "docs", "LICENSE"],
  "scripts": {
    "clean": "node -e \"fs.rmSync('lib',{recursive:true,force:true})\"",
    "build": "pnpm clean && tsc -p tsconfig.json && tsdown",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "verify": "pnpm typecheck && pnpm test && pnpm build"
  }
}
```

Add exact runtime/dev dependencies with `pnpm add` rather than editing the lockfile manually: Cordis `^4.0.1`, DSH `^0.1.0-rc.6`, Schemastery `^3.18.1`, Chokidar `^4.0.3`, React `^18.2.0`, TypeScript `^6.0.3`, tsdown `^0.22.2`, Vitest `^4.1.8`, jsdom `29.1.1`, and matching Node/React types.

Create minimal buildable host/client entries before the first build:

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'dsh-dev-reloader'
export const inject: string[] = []
export function apply(_ctx: Context): void {}

// src/client/index.tsx
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
export const name = 'dsh-dev-reloader-client'
export const inject: string[] = []
export function apply(_ctx: ClientContext): void {}
```

These entries are temporary compile-safe seams, not shipped behavior; Tasks 10 and 11 replace them before integration.

Use this bundle patch:

```yaml
- insert:
    - id: dsh-dev-reloader
      name: dsh-dev-reloader
```

- [ ] **Step 2: Write failing protocol and state tests**

`tests/unit/protocol.test.ts` must assert valid version-1 parsing, rejection of unknown versions, malformed JSON, and a frame over `64 * 1024` bytes. `tests/unit/state.test.ts` must assert `starting -> watching -> building -> pending-restart -> restarting -> recovering -> watching` and reject `paused -> restarting` without an explicit resume event.

```ts
expect(() => parseWireEnvelope('{"protocolVersion":2,"type":"heartbeat"}')).toThrow(/protocol/i)
expect(() => transitionSupervisorState(paused, { type: 'restart-ready' })).toThrow(/illegal/i)
```

- [ ] **Step 3: Run focused tests and observe failure**

Run: `pnpm test:unit -- tests/unit/protocol.test.ts tests/unit/state.test.ts`

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 4: Implement minimal shared contracts**

Define `PROTOCOL_VERSION = 1`, the exact public phases from the design, immutable message unions, and a JSON parser that checks object shape/version/frame byte length. `HostLaunchSpec.env` is marked in-memory-only and excluded by `toPublicStatus()` and every serialization helper.

Core signatures:

```ts
export interface CommandTemplate {
  executable: string
  args: readonly string[]
  cwd?: string
}

export const MAX_FRAME_BYTES = 64 * 1024
export function parseWireEnvelope(line: string): WireEnvelope
export function transitionSupervisorState(state: SupervisorState, event: SupervisorStateEvent): SupervisorState
export function toPublicStatus(state: SupervisorState): PublicSupervisorStatus
```

- [ ] **Step 5: Run unit tests, typecheck, and build**

Run: `pnpm test:unit -- tests/unit/protocol.test.ts tests/unit/state.test.ts && pnpm typecheck && pnpm build`

Expected: all commands exit 0; `lib/index.js` and `lib/client.js` are generated from the minimal compile-safe entries, while shared contracts emit declarations.

- [ ] **Step 6: Commit foundation**

```sh
git add .gitignore LICENSE package.json pnpm-lock.yaml cordis.patch.yml tsconfig.json tsdown.config.ts vitest.config.ts src/index.ts src/client/index.tsx src/shared tests/unit
git commit -m "chore: initialize dsh dev reloader package"
```

---

### Task 2: Runtime Paths, Permissions, and Singleton Lock

**Files:**
- Create: `src/supervisor/paths.ts`
- Create: `src/supervisor/lock.ts`
- Create: `tests/unit/paths.test.ts`
- Create: `tests/unit/lock.test.ts`

**Interfaces:**
- Consumes: `SupervisorConfig.profile` from Task 1.
- Produces: `RuntimePaths`, `resolveRuntimePaths()`, `SupervisorLockRecord`, `LockLease`, `acquireSupervisorLock()`, `probeLockOwner()`.

- [ ] **Step 1: Write failing path and lock tests**

Cover POSIX socket paths, Windows pipe names, profile isolation, `0700/0600` modes, live/stale/unknown lock probes, and concurrent acquisition. Unknown ownership must reject with `LOCK_OWNERSHIP_UNKNOWN`.

```ts
await expect(acquireSupervisorLock(paths, async () => 'unknown')).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
```

- [ ] **Step 2: Run tests and observe missing-module failure**

Run: `pnpm test:unit -- tests/unit/paths.test.ts tests/unit/lock.test.ts`

Expected: FAIL because `paths.ts` and `lock.ts` do not exist.

- [ ] **Step 3: Implement runtime paths and atomic lock acquisition**

Use `$DSH_HOME/plugins/dsh-dev-reloader/{profile}/`. Create the directory recursively, chmod it on POSIX, write token/lock through same-directory temporary files, fsync/rename, and validate a stored `pid`, `startedAt`, `instanceId`, and `endpoint`. Only delete a lock after the probe returns `stale`.

```ts
export async function acquireSupervisorLock(
  paths: RuntimePaths,
  probe: (record: SupervisorLockRecord) => Promise<'live' | 'stale' | 'unknown'>,
): Promise<LockLease>
```

- [ ] **Step 4: Run focused and shared tests**

Run: `pnpm test:unit -- tests/unit/paths.test.ts tests/unit/lock.test.ts tests/unit/protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit singleton storage**

```sh
git add src/supervisor/paths.ts src/supervisor/lock.ts tests/unit/paths.test.ts tests/unit/lock.test.ts
git commit -m "feat: add secure supervisor singleton storage"
```

---

### Task 3: Authenticated Local IPC

**Files:**
- Create: `src/supervisor/ipc.ts`
- Create: `tests/unit/ipc.test.ts`
- Create: `tests/helpers/eventually.ts`

**Interfaces:**
- Consumes: protocol parsers and `RuntimePaths.endpoint/tokenFile`.
- Produces: `IpcServer`, `IpcClient`, `listenForBridges()`, `connectToSupervisor()`.

- [ ] **Step 1: Write failing IPC tests**

Test fragmented NDJSON frames, two frames in one read, oversize frames, malformed JSON, wrong token, wrong protocol version, stale host PID rejection, response correlation, and disconnect cleanup. Use an actual temporary Unix socket on POSIX and a generated named pipe path on Windows.

- [ ] **Step 2: Run tests and observe failure**

Run: `pnpm test:unit -- tests/unit/ipc.test.ts`

Expected: FAIL on missing `ipc.ts`.

- [ ] **Step 3: Implement framed authenticated RPC**

Use `node:net`; buffer by bytes until newline; reject before parsing once a frame exceeds `MAX_FRAME_BYTES`. The first message must be `BridgeHello`; no command/event is accepted before token/version/PID validation.

```ts
export async function listenForBridges(options: {
  endpoint: string
  token: string
  validateHost(hello: BridgeHello): Promise<boolean>
  onEvent(event: BridgeEvent): void
}): Promise<IpcServer>
```

Every pending RPC rejects with `IPC_DISCONNECTED` when the socket closes.

- [ ] **Step 4: Run IPC and lock suites**

Run: `pnpm test:unit -- tests/unit/ipc.test.ts tests/unit/lock.test.ts`

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit IPC**

```sh
git add src/supervisor/ipc.ts tests/unit/ipc.test.ts tests/helpers/eventually.ts
git commit -m "feat: add authenticated local supervisor ipc"
```

---

### Task 4: Source and Linked-Plugin Discovery

**Files:**
- Create: `src/supervisor/discovery.ts`
- Create: `tests/helpers/temp-layout.ts`
- Create: `tests/unit/discovery.test.ts`

**Interfaces:**
- Consumes: `SupervisorConfig.sourceRoots/profile`.
- Produces: `ProjectDescriptor`, `DiscoveryResult`, `discoverProjects()`.

- [ ] **Step 1: Build failing discovery fixtures**

Create temporary fixtures for explicit source roots, `DSH_DEV_SOURCE_ROOT`, argv/cwd ancestor discovery, published runtime-only DSH packages, `workspace:`, `link:`, `file:`, external pnpm symlinks, duplicate realpaths, client/server entries, output roots, and missing package manifests.

- [ ] **Step 2: Run discovery tests and observe failure**

Run: `pnpm test:unit -- tests/unit/discovery.test.ts`

Expected: FAIL on missing discovery API.

- [ ] **Step 3: Implement deterministic discovery**

Realpath before deduplication. A DSH checkout requires `pnpm-workspace.yaml`, root package metadata naming the DSH root, and `apps/web`; an installed package without those markers is reported as runtime-only. Read `$DSH_HOME/profiles/{profile}/package.json`, resolve local specs and symlinks, then derive:

```ts
export interface ProjectDescriptor {
  id: string
  kind: 'dsh-checkout' | 'linked-plugin'
  root: string
  workspaceRoot: string
  packageName?: string
  serverEntries: readonly string[]
  clientEntries: readonly string[]
  manifests: readonly string[]
  build?: CommandTemplate
  devWeb?: CommandTemplate
  outputRoots: readonly string[]
}
```

Warnings are structured and sorted; project order is deterministic by realpath.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test:unit -- tests/unit/discovery.test.ts`

Expected: PASS on the current OS; Windows-specific fixture branches run under CI later.

- [ ] **Step 5: Commit discovery**

```sh
git add src/supervisor/discovery.ts tests/helpers/temp-layout.ts tests/unit/discovery.test.ts
git commit -m "feat: discover dsh checkouts and linked plugins"
```

---

### Task 5: Change Classification and Plan Merging

**Files:**
- Create: `src/supervisor/classifier.ts`
- Create: `tests/unit/classifier.test.ts`

**Interfaces:**
- Consumes: `ProjectDescriptor`.
- Produces: `ChangeEvent`, `Impact`, `ChangeAction`, `ChangePlan`, `classifyChange()`, `mergeActions()`.

- [ ] **Step 1: Write a table-driven failing classification suite**

Cover every design row: patch HMR, server HMR, client HMR, manifest/build config full restart, DSH Shell/shared package full restart, lockfile dependency plan, docs/tests/Git ignored, output ignored, and unknown runtime source full restart. Mixed actions must keep all builds/watchers and choose the maximum impact.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm test:unit -- tests/unit/classifier.test.ts`

Expected: FAIL on missing classifier.

- [ ] **Step 3: Implement pure classification**

Use project-relative POSIX-normalized paths only; do not read the filesystem. Rank impact exactly as `ignore < config-hmr < server-hmr < client-hmr < full-restart`, while retaining both server/client watchers when builds are independent. Lockfiles produce a structured `dependency-install` action. The execution cycle runs the discovered package manager as `pnpm install --frozen-lockfile` in the workspace root before build; a failed install is treated exactly like a failed build and never restarts DSH.

- [ ] **Step 4: Run tests**

Run: `pnpm test:unit -- tests/unit/classifier.test.ts tests/unit/discovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit classification**

```sh
git add src/supervisor/classifier.ts tests/unit/classifier.test.ts
git commit -m "feat: classify development changes deterministically"
```

---

### Task 6: Safe Runner, Watch Plan, and Serialized Scheduler

**Files:**
- Create: `src/supervisor/runner.ts`
- Create: `src/supervisor/watcher.ts`
- Create: `src/supervisor/scheduler.ts`
- Create: `tests/fixtures/fake-builder.ts`
- Create: `tests/unit/runner.test.ts`
- Create: `tests/unit/watcher.test.ts`
- Create: `tests/unit/scheduler.test.ts`

**Interfaces:**
- Consumes: `ProjectDescriptor`, `ChangePlan`.
- Produces: `CommandSpec`, `CommandRunner`, `PersistentProcess`, `WatchPlanController`, `ChangeScheduler`.

- [ ] **Step 1: Write failing command-runner tests**

Assert exact executable/args/cwd/env forwarding, `shell: false`, bounded stdout/stderr tails, token redaction, abort behavior, and persistent process reuse by key.

- [ ] **Step 2: Write failing watcher and scheduler tests**

Use fake clocks to prove debounce, one active cycle, one dirty follow-up after 100 events during a blocked build, build failure suppression, close semantics, output-root exclusion, and atomic watcher-plan replacement.

- [ ] **Step 3: Run focused tests and observe failure**

Run: `pnpm test:unit -- tests/unit/runner.test.ts tests/unit/watcher.test.ts tests/unit/scheduler.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 4: Implement runner and watcher registry**

```ts
export interface CommandRunner {
  run(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult>
  ensurePersistent(key: string, command: CommandSpec): Promise<PersistentProcess>
  stopAll(): Promise<void>
}
```

Use Chokidar 4 with real roots and explicit ignored paths. Start a replacement watch plan before closing the previous plan; if replacement setup fails, retain the previous valid plan.

- [ ] **Step 5: Implement scheduler**

`createChangeScheduler()` owns the debounce timer, pending event map, current execution, dirty flag, idle waiters, and shutdown. A failed cycle returns `{ kind: 'build-failed' }` and cannot invoke restart hooks.

- [ ] **Step 6: Run suites**

Run: `pnpm test:unit -- tests/unit/runner.test.ts tests/unit/watcher.test.ts tests/unit/scheduler.test.ts tests/unit/classifier.test.ts`

Expected: PASS and no leaked children/watchers.

- [ ] **Step 7: Commit execution pipeline**

```sh
git add src/supervisor/runner.ts src/supervisor/watcher.ts src/supervisor/scheduler.ts tests/fixtures/fake-builder.ts tests/unit/runner.test.ts tests/unit/watcher.test.ts tests/unit/scheduler.test.ts
git commit -m "feat: schedule safe builds and development watchers"
```

---

### Task 7: Fail-Closed Activity Gate

**Files:**
- Create: `src/supervisor/task-gate.ts`
- Create: `tests/unit/task-gate.test.ts`

**Interfaces:**
- Consumes: `ActivitySnapshot`.
- Produces: `TaskGate`, `GateDecision`, `createTaskGate()`.

- [ ] **Step 1: Write failing gate tests**

Test active agents, running jobs, stopping jobs, local builds, disconnected bridge, stale activity sequence rejection, waiters, abort, and force bypass remaining outside the gate.

```ts
expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })
const finish = gate.beginLocalTask('build:plugin-a')
finish()
expect(gate.inspect()).toEqual({ open: true })
```

- [ ] **Step 2: Run and observe failure**

Run: `pnpm test:unit -- tests/unit/task-gate.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement gate**

Bridge disconnect immediately closes the gate. Only a strictly newer `sequence` snapshot can reopen it. `waitUntilOpen` has no timeout and resolves all current waiters only when agents, running jobs, stopping jobs, and local tasks are zero.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test:unit -- tests/unit/task-gate.test.ts`

```sh
git add src/supervisor/task-gate.ts tests/unit/task-gate.test.ts
git commit -m "feat: defer restarts until dsh activity is idle"
```

---

### Task 8: Host Lifecycle, Health, and Crash Recovery

**Files:**
- Create: `src/supervisor/health-check.ts`
- Create: `src/supervisor/lifecycle.ts`
- Create: `tests/fixtures/fake-host.ts`
- Create: `tests/helpers/process-harness.ts`
- Create: `tests/unit/health-check.test.ts`
- Create: `tests/unit/lifecycle.test.ts`

**Interfaces:**
- Consumes: `HostLaunchSpec`, public state events, bridge readiness callback.
- Produces: `AdoptedHost`, `HostLifecycle`, `HealthObservation`, `createHostLifecycle()`.

- [ ] **Step 1: Create failing health tests**

Use an OS-assigned fake-host port. Assert HTTP-only is insufficient, bridge-only is insufficient, wrong bootId is insufficient, and both signals for the new bootId pass before timeout.

- [ ] **Step 2: Create failing lifecycle tests**

Cover adopting a non-child PID without spawning, exact launch reuse, planned notification, graceful signal, shutdown grace escalation, port release, one replacement spawn, unhealthy-live-child suppression, normal host-disposing stop, HMR disposal while PID survives, unannounced crash recovery, exponential backoff, and circuit opening after `maxCrashRestarts`.

- [ ] **Step 3: Run and observe failures**

Run: `pnpm test:unit -- tests/unit/health-check.test.ts tests/unit/lifecycle.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 4: Implement health checker and planned restart**

`restart()` owns the entire ordered sequence; the caller may not duplicate lifecycle steps:

```ts
export interface HostLifecycle {
  adopt(launch: HostLaunchSpec): Promise<AdoptedHost>
  restart(request: RestartRequest): Promise<RestartResult>
  observeUnexpectedExit(host: AdoptedHost, signal?: AbortSignal): Promise<'restarted' | 'circuit-open'>
  dispose(): Promise<void>
}
```

Use the saved `nodeExecutable`, `execArgv`, `argv`, `cwd`, and in-memory `env`. Poll PID/port with deadlines, not arbitrary sleeps.

- [ ] **Step 5: Implement normal-stop/HMR/crash distinction**

A planned restart owns the current disposal. An unplanned `host-disposing` followed by exit stops the supervisor. A bridge disposal while PID remains live starts `bridgeGraceMs`; reconnection cancels it. A disappearance without disposal is a crash.

- [ ] **Step 6: Run lifecycle suites**

Run: `pnpm test:unit -- tests/unit/health-check.test.ts tests/unit/lifecycle.test.ts`

Expected: PASS; all fake children are cleaned by test teardown.

- [ ] **Step 7: Commit lifecycle**

```sh
git add src/supervisor/health-check.ts src/supervisor/lifecycle.ts tests/fixtures/fake-host.ts tests/helpers/process-harness.ts tests/unit/health-check.test.ts tests/unit/lifecycle.test.ts
git commit -m "feat: supervise dsh restart and crash recovery"
```

---

### Task 9: Supervisor Orchestration and CLI Composition

**Files:**
- Create: `src/supervisor/supervisor.ts`
- Create: `src/supervisor/cli.ts`
- Create: `tests/unit/supervisor.test.ts`
- Create: `tests/unit/cli.test.ts`

**Interfaces:**
- Consumes: IPC, discovery, classifier, runner, watcher, scheduler, task gate, lifecycle, state machine.
- Produces: `DevReloaderSupervisor`, `createSupervisor()`, CLI modes `--serve` and `--handoff`.

- [ ] **Step 1: Write failing orchestration tests with fakes**

Assert startup discovery/watch installation, build failure leaves host untouched, config HMR completion, server HMR waiting for an explicit `hmr/reload` acknowledgement, HMR timeout escalation to full restart, client watcher completion, full restart entering pending, bridge unknown remaining pending, idle gate continuing, explicit `restart force:true` bypassing the gate, duplicate commands being idempotent, and pause stopping watchers without killing DSH.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm test:unit -- tests/unit/supervisor.test.ts tests/unit/cli.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement orchestrator**

`supervisor.ts` may import interfaces but must not read package files, classify paths, spawn processes, or parse sockets directly. It maps domain events to state transitions and calls adapters. A server-HMR cycle completes only after the host bridge reports an `hmr/reload` acknowledgement for the affected entry; expiry of `bridgeGraceMs` escalates to a full restart. A client-HMR cycle ensures the persistent watcher; a full-restart cycle waits on the task gate unless command.force is true.

- [ ] **Step 4: Compose real adapters in CLI**

`cli.ts` resolves runtime paths, obtains the lock, loads the token, starts IPC, performs discovery, installs watchers, adopts the hello host, and registers signal cleanup. Validate CLI input without a shell parser.

- [ ] **Step 5: Run focused and cumulative unit suites**

Run: `pnpm test:unit -- tests/unit/supervisor.test.ts tests/unit/cli.test.ts tests/unit/scheduler.test.ts tests/unit/lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit orchestrator**

```sh
git add src/supervisor/supervisor.ts src/supervisor/cli.ts tests/unit/supervisor.test.ts tests/unit/cli.test.ts
git commit -m "feat: orchestrate automatic dsh development reloads"
```

---

### Task 10: Cordis Host Bridge and Official Settings

**Files:**
- Create: `src/bridge/activity.ts`
- Create: `src/bridge/client.ts`
- Create: `src/bridge/routes.ts`
- Create: `src/bridge/spawn.ts`
- Modify: `src/index.ts`
- Create: `tests/unit/activity.test.ts`
- Create: `tests/unit/routes.test.ts`
- Create: `tests/unit/spawn.test.ts`
- Create: `tests/unit/host-plugin.test.ts`

**Interfaces:**
- Consumes: DSH `ctx.agents.list()/roots()`, `ctx.jobs.list(agent)`, `ctx.jobs.onJobsChanged()`, `ctx.webServer.register()`, `installSettingsSection()`, local IPC client.
- Produces: Cordis `name`, `inject`, `Config`, `apply(ctx, config)`; routes `/plugins/dsh-dev-reloader/status`, `/health`, `/command`.

- [ ] **Step 1: Write failing activity adapter tests**

Use fake registries. Count running roots, deduplicate jobs visible through multiple agents by job id, count both `running` and `stopping`, include unowned jobs, increment a monotonic snapshot sequence, publish on `agent/status` plus `onJobsChanged`, and forward Cordis `hmr/reload` acknowledgements with the reloaded entry identities.

- [ ] **Step 2: Write failing route and spawn tests**

GET status/health may return redacted data. POST command requires loopback remote address, same-origin request, JSON content type, body at most 64 KiB, and a known command. Non-loopback and forwarded remote requests return 403. Detached spawn uses `process.execPath`, resolved `lib/supervisor/cli.js`, `detached: true`, ignored stdio, and `unref()`.

- [ ] **Step 3: Write failing host plugin lifecycle test**

Assert one settings namespace, one supervisor connection, one route set, dynamic config forwarding, explicit disable stop, and complete Cordis disposal cleanup. Generic HMR disposal must not delete the supervisor lock.

- [ ] **Step 4: Run tests and observe failure**

Run: `pnpm test:unit -- tests/unit/activity.test.ts tests/unit/routes.test.ts tests/unit/spawn.test.ts tests/unit/host-plugin.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement Config and settings wiring**

Export a Schemastery schema with the approved fields and safe defaults. Use:

```ts
const ns = settingsNamespace('dsh-dev-reloader')
installSettingsSection(ctx, ns, Config, entryConfig, {
  setSource(current) { source = current },
  onChange() { bridge.updateConfig(source()) },
})
```

Required injects are `webServer`, `agents`, and `jobs`; `settings` remains optional through `installSettingsSection`.

- [ ] **Step 6: Implement bridge composition and routes**

Capture `HostLaunchSpec` from current process facts and `ctx.webServer.host/port`; create a random `bootId` per host load. Register routes through `ctx.effect(() => ctx.webServer.register(...))`. Keep environment only in the IPC hello object and never return it from routes.

- [ ] **Step 7: Run host tests and typecheck**

Run: `pnpm test:unit -- tests/unit/activity.test.ts tests/unit/routes.test.ts tests/unit/spawn.test.ts tests/unit/host-plugin.test.ts && pnpm typecheck`

Expected: PASS against DSH rc.6 types.

- [ ] **Step 8: Commit host bridge**

```sh
git add src/bridge src/index.ts tests/unit/activity.test.ts tests/unit/routes.test.ts tests/unit/spawn.test.ts tests/unit/host-plugin.test.ts
git commit -m "feat: add dsh host bridge and settings"
```

---

### Task 11: Browser Settings Card and Once-Only Recovery

**Files:**
- Create: `src/client/context-types.ts`
- Create: `src/client/locales.ts`
- Create: `src/client/api.ts`
- Create: `src/client/reconnect.ts`
- Create: `src/client/SettingsCard.tsx`
- Create: `src/client/styles.ts`
- Modify: `src/client/index.tsx`
- Create: `tests/unit/reconnect.test.ts`
- Create: `tests/unit/client-api.test.ts`
- Create: `tests/unit/settings-card.test.tsx`

**Interfaces:**
- Consumes: DSH `slots`, `locale`, `settingsScope`; host routes.
- Produces: client plugin `name = 'dsh-dev-reloader-client'`, settings slot registration id `dsh-dev-reloader`, `decideRecovery()`.

- [ ] **Step 1: Write failing pure recovery tests**

Test unhealthy response, absent bridge, same bootId, new bootId, `waiting -> reloading`, and new-page clearing. Prove repeated health responses never cause two reload calls.

```ts
expect(decideRecovery(waiting, { healthy: true, bridgeReady: true, bootId: 'new' })).toMatchObject({ type: 'reload' })
expect(decideRecovery(reloadingNew, { healthy: true, bridgeReady: true, bootId: 'new' })).toEqual({ type: 'clear' })
```

- [ ] **Step 2: Write failing API and card tests**

Mock fetch and settings scope. Test status rendering, enabled toggle, rebuild, normal restart, force confirmation, read-only settings, failed command display, and cleanup of polling/subscriptions.

- [ ] **Step 3: Run and observe failure**

Run: `pnpm test:unit -- tests/unit/reconnect.test.ts tests/unit/client-api.test.ts tests/unit/settings-card.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Implement reconnect and API modules**

Store marker key `dsh.devReloader.recovery.v1` in `sessionStorage`. Start polling on `restart-planned` or connection failure, use `cache: 'no-store'`, and reload only after health plus new bootId. Abort timers/fetch on plugin disposal.

- [ ] **Step 5: Implement official settings card registration**

Follow the DSH settings slot pattern:

```ts
export const inject = ['slots', 'locale', 'settingsScope']
ctx.effect(() => ctx.locale.register('dev-reloader.card', { zh, en }))
const scope = ctx.settingsScope.bind({ namespace: 'dsh-dev-reloader' })
ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
  name: 'settings.plugin.item',
  id: 'dsh-dev-reloader',
  order: 40,
  locale: 'dev-reloader.card',
  inject: () => ({ hooks: { devReloader: store }, set, clear, command }),
}, SettingsCard))
```

The force button requires a second explicit confirmation state and copy warning that active work may be interrupted.

- [ ] **Step 6: Run client tests and browser bundle build**

Run: `pnpm test:unit -- tests/unit/reconnect.test.ts tests/unit/client-api.test.ts tests/unit/settings-card.test.tsx && pnpm typecheck && pnpm build`

Expected: PASS and `lib/client.js` exists as one browser bundle.

- [ ] **Step 7: Commit client plugin**

```sh
git add src/client tests/unit/reconnect.test.ts tests/unit/client-api.test.ts tests/unit/settings-card.test.tsx tsdown.config.ts
git commit -m "feat: add web controls and restart recovery"
```

---

### Task 12: Supervisor Self-Handoff

**Files:**
- Create: `src/supervisor/handoff.ts`
- Modify: `src/supervisor/cli.ts`
- Modify: `src/supervisor/supervisor.ts`
- Create: `tests/unit/handoff.test.ts`
- Create: `tests/integration/self-handoff.test.ts`

**Interfaces:**
- Consumes: lock, authenticated IPC, current host/adapters, public state.
- Produces: `HandoffSnapshot`, `SupervisorHandoff`, prepare/commit/abort protocol.

- [ ] **Step 1: Write failing handoff state tests**

Test prepare validation, standby not watching before commit, old freeze, atomic ownership transfer, successful commit, pre-commit abort resume, post-commit single endpoint, and ambiguous ownership fail-closed behavior.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm test:unit -- tests/unit/handoff.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement one-time authenticated handoff channel**

Transfer the in-memory launch environment only through a one-use local socket; never write it to disk or argv. Protocol order is `hello -> snapshot -> prepared -> freeze -> commit -> committed`. Old supervisor exits only after `committed`; any earlier error invokes `resume()`.

- [ ] **Step 4: Write and run process integration test**

Start old and standby supervisors with a fake host and temporary state root. Assert only one accepts status commands after commit and failed preparation leaves the old process responsive.

Run: `pnpm test:integration -- tests/integration/self-handoff.test.ts`

Expected: PASS with deadline-bounded cleanup.

- [ ] **Step 5: Commit handoff**

```sh
git add src/supervisor/handoff.ts src/supervisor/cli.ts src/supervisor/supervisor.ts tests/unit/handoff.test.ts tests/integration/self-handoff.test.ts
git commit -m "feat: hand off supervisor updates safely"
```

---

### Task 13: End-to-End Integration and Bundle Smoke

**Files:**
- Create: `tests/integration/supervisor-singleton.test.ts`
- Create: `tests/integration/build-routing.test.ts`
- Create: `tests/integration/restart-gate.test.ts`
- Create: `tests/integration/restart-recovery.test.ts`
- Create: `tests/integration/crash-recovery.test.ts`
- Create: `tests/integration/bundle-smoke.test.ts`
- Modify: test helpers/fixtures as required by observed failures.

**Interfaces:**
- Consumes: all runtime modules and built package.
- Produces: regression evidence for the complete local workflow.

- [ ] **Step 1: Write failing singleton and routing integrations**

Use a temporary DSH home/profile and fake projects. Verify one supervisor, duplicate bridge reuse, server build/HMR route, client persistent watcher route, manifest full restart route, ignored output, and build failure retaining the host.

- [ ] **Step 2: Write failing gate/recovery/crash integrations**

Prove an active Agent/job snapshot leaves restart pending, idle releases it, unknown bridge remains pending, forced command bypasses, same URL recovers with a new bootId, normal stop does not respawn, and crash recovery is bounded.

- [ ] **Step 3: Write bundle smoke test**

Pack the project with `pnpm pack --pack-destination /tmp/dsh-dev-reloader-pack-test`, install the tarball into a temporary profile fixture, inspect package metadata and patch composition, import the Host export, execute the browser artifact through a stub DSH module loader and invoke its registered factory, and assert no build path references the local repository.

- [ ] **Step 4: Run integrations and fix only evidenced gaps**

Run: `pnpm test:integration`

Expected: PASS; every test uses an OS-assigned port and temporary state directory. Investigate every nonzero exit and leaked process before proceeding.

- [ ] **Step 5: Run complete verification**

Run: `pnpm verify`

Expected: typecheck, all tests, and production build exit 0.

- [ ] **Step 6: Commit integration coverage**

```sh
git add tests/integration tests/helpers tests/fixtures
git commit -m "test: cover complete dsh reload lifecycle"
```

---

### Task 14: Documentation, Architecture, and CI

**Files:**
- Create: `README.md`
- Create: `README.zh.md`
- Create: `docs/architecture.md`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` only if package-validation evidence requires metadata corrections.

**Interfaces:**
- Consumes: verified commands, routes, settings, config schema, status names.
- Produces: user-facing installation/support contract and CI gates.

- [ ] **Step 1: Write README from verified behavior**

The Chinese translation covers the same verified contract as the English default README: purpose/local-only warning, capabilities, compatibility table, precompiled GitHub install without dependency build scripts, local clone/build/link, first restart, GUI states/actions, discovery/classification, config table, logs/troubleshooting, pause/uninstall, security, development/testing, license. Use these commands:

```sh
dsh plugin --profile web add github:lhzcode/dsh-dev-reloader

git clone https://github.com/lhzcode/dsh-dev-reloader.git
cd dsh-dev-reloader
pnpm install
pnpm build
dsh plugin --profile web add link:$PWD
```

Do not claim npm or Release availability and do not compare named community projects.

- [ ] **Step 2: Write architecture and English README**

`docs/architecture.md` documents the three-process boundary, IPC trust boundary, action classification, state machine, and restart sequence. English README contains the same commands, safety boundary, and compatibility facts without duplicating the full design spec.

- [ ] **Step 3: Add cross-platform CI**

Create a GitHub Actions matrix for `ubuntu-latest`, `macos-latest`, and `windows-latest`, Node 22 and 24, pnpm 11.8.0. Each job runs `pnpm install --frozen-lockfile` and `pnpm verify`. Add a separate pack smoke step on Ubuntu.

- [ ] **Step 4: Validate docs and package**

Run:

```sh
pnpm verify
pnpm pack --pack-destination /tmp/dsh-dev-reloader-pack
node -e "const p=require('./package.json'); if(p.name!=='dsh-dev-reloader'||!p.dsh?.bundle?.patch||!p.dsh?.client) process.exit(1)"
```

Expected: all exit 0; inspect tarball contents and confirm README commands match package metadata.

- [ ] **Step 5: Commit docs and CI**

```sh
git add README.md README.zh.md docs .github/workflows/ci.yml package.json pnpm-lock.yaml
git commit -m "docs: document dsh dev reloader usage"
```

---

### Task 15: Final Review, Disposable DSH Smoke, and Public GitHub Upload

**Files:**
- Review: every tracked source, test, config, workflow, and documentation file.
- Modify: only files implicated by review or fresh verification failures.

**Interfaces:**
- Consumes: complete project.
- Produces: clean verified public repository `https://github.com/lhzcode/dsh-dev-reloader`.

- [ ] **Step 1: Invoke required review and completion skills**

Load `requesting-code-review` for an independent implementation/spec review, address only technically verified findings, then load `verification-before-completion` before any success claim.

- [ ] **Step 2: Run fresh full verification**

Run:

```sh
pnpm verify
git status --short
git log --oneline --decorate -15
```

Expected: `pnpm verify` exits 0 and status is clean.

- [ ] **Step 3: Run a disposable real-DSH smoke test without touching 3080**

Create a temporary `DSH_HOME`, copy only the installed Web profile metadata needed for resolution, install the local absolute `link:` package into that temporary profile, and run the exact current DSH executable on an OS-assigned/non-3080 port as a managed background job. Verify `--dump-config` contains one `dsh-dev-reloader` row, the bridge reports healthy, and stopping the host terminates the supervisor. Collect and stop every background job before proceeding.

- [ ] **Step 4: Create the public GitHub repository and push**

The user has explicitly authorized GitHub upload and selected public visibility. Confirm `gh auth status`, then run:

```sh
gh repo create lhzcode/dsh-dev-reloader --public --source . --remote origin --push
```

If the remote already exists, verify ownership with `gh repo view lhzcode/dsh-dev-reloader`, add the exact remote URL, and push `main`. Do not create a Release or publish npm.

- [ ] **Step 5: Verify remote and CI**

Run:

```sh
gh repo view lhzcode/dsh-dev-reloader --json nameWithOwner,visibility,url,defaultBranchRef
gh run list --repo lhzcode/dsh-dev-reloader --limit 5
```

Wait for the pushed CI run only when needed to establish final status. Capture and inspect a failure with `run_id="$(gh run list --repo lhzcode/dsh-dev-reloader --limit 1 --json databaseId --jq '.[0].databaseId')"` followed by `gh run view "$run_id" --repo lhzcode/dsh-dev-reloader --log-failed`; fix locally, rerun `pnpm verify`, commit, and push.

- [ ] **Step 6: Report delivery**

Report the clickable GitHub URL, primary local files, verification commands and fresh results, CI state, installation command, and any explicitly unverified current-3080 behavior. Do not claim the current GUI changed unless the user separately installs the plugin into the active profile and refreshes that exact URL.

---

### Task 16: Standard Full Settings Form with Single-Repository rc.6 Compatibility

**Approved outcome:** expose the complete `dsh-dev-reloader` configuration as a standard staged settings form while keeping DSH `SettingsProvider` as the only persistence and validation owner. Use official browser `settingsScope` whenever it is ready; only a loopback, same-origin, namespace-specific Host transport may cover rc.6's third-party namespace gap. No second settings document, third-party package patch, or architecture-diagram change is allowed.

**Files:**
- Create: `src/bridge/settings.ts`
- Create: `src/client/settings-transport.ts`
- Create: `src/client/settings-form.ts`
- Create: `src/client/settings-card.css.ts`
- Modify: `src/index.ts`, `src/client/index.tsx`, `src/client/SettingsCard.tsx`, client locale/types/API surfaces
- Create: `tests/unit/settings-bridge.test.ts`, `tests/unit/settings-transport.test.ts`
- Modify: `tests/unit/host-plugin.test.ts`, `tests/unit/settings-card.test.tsx`, bundle smoke tests
- Modify: README/CHANGELOG and the textual browser↔Host route inventory in architecture/design docs; preserve every existing diagram.

**Interface and authority:**
- Host GET returns one redacted descriptor (resolved value, base, user, revision, writable) for exactly `dsh-dev-reloader`.
- Host POST accepts bounded, first-level `set`/`unset` ops plus `expectedRevision`, delegates atomically to `SettingsProvider.mutate`, and returns the newly redacted descriptor.
- Reads are loopback-only and uncached. Writes additionally require same-origin Host/Origin, JSON content type, a bounded body, known fields, JSON-shaped values, and optimistic revision fencing.
- The client selector uses the official scope while `ready`. It starts the compatibility transport only for `unavailable` loopback Host mode, switches back when official state becomes ready, and never creates process-local persistence.
- The form stages edits. In compatibility mode, Save sends one revision-fenced mutation batch and Reset unsets every editable field in one batch; the preferred official scope uses its native field mutation API. Supervisor commands continue through the existing command route.

**Form coverage:**
- General: `enabled`, immutable `profile` display, optional `webUrl`, `logLevel`.
- Watch: line-list editors for `sourceRoots` and `ignored`; natural-number input for `debounceMs`.
- Lifecycle: natural-number inputs for health, shutdown, bridge, crash window, and maximum crash restarts.
- Advanced: validated JSON editor for `projectOverrides`.
- Standard card behavior: matching DSH Web UI visual tokens, dirty marker, Save/Reset, saving state, field/transport errors, read-only state, and status/rebuild/restart/force-restart controls.

- [x] **Step 1: Add failing Host settings-bridge tests**

Cover redacted descriptor reads, loopback/origin/media/body guards, malformed/unknown ops, optimistic conflicts, atomic set+unset mutation, namespace disposal, and bounded errors.

- [x] **Step 2: Implement the Host bridge and replace helper-only registration**

Register the namespace once on the settings fiber, preserve source/watch hooks, mount routes on that same lifetime, and make every response derive from `SettingsProvider.describe({ redactSecrets: true })`.

- [x] **Step 3: Add failing client transport tests**

Prove referentially stable snapshots, official-ready precedence, loopback-only fallback, one revision-fenced compatibility Save/Reset batch, native official field writes, write serialization, conflict/error reload, disposal, and return to official ownership.

- [x] **Step 4: Implement client transport and staged form model**

Keep parsing/serialization pure and test arrays, natural numbers, optional URL, log levels, project override JSON, dirty detection, reset ops, and validation errors.

- [x] **Step 5: Replace degraded card with the complete standard form**

Render all approved fields with shared visual tokens and accessible labels, preserve command confirmation/recovery behavior, and show unavailable only when both official and compatibility transports fail.

- [x] **Step 6: Run focused and full verification**

Run the new unit suites, existing Host/card/routes/bundle tests, `pnpm verify`, a deterministic second build, and `git diff --check`.

- [ ] **Step 7: Verify the existing GUI without replacing its server**

Rebuild tracked Web artifacts, refresh `http://127.0.0.1:3080`, and prove the card shows the full writable form with no unavailable warning. Exercise one reversible field Save and Reset, verify the Host descriptor revision/value, and leave user configuration unchanged.

- [ ] **Step 8: Review, integrate, and verify remote CI**

Request findings-first review, resolve Critical/Important and validated Minors, amend the authorized single root commit with the GitHub noreply identity, push with an exact force lease, and verify the full OS/Node matrix plus Git install smoke. Do not create a Tag or Release.
