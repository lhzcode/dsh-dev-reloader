import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PROTOCOL_VERSION, type PublicSupervisorStatus, type SupervisorCommand } from '../../src/shared/protocol.js'
import { DEFAULT_SUPERVISOR_CONFIG, type SupervisorConfig } from '../../src/shared/config.js'
import { connectToSupervisor, type IpcClient } from '../../src/supervisor/ipc.js'
import { resolveRuntimePaths, type RuntimePaths } from '../../src/supervisor/paths.js'
import { ensureBuiltPackage } from './ensure-build.js'
import { createTempLayout, type TempLayout } from './temp-layout.js'
import { spawnFakeHost, type FakeHostProcess } from './process-harness.js'

export const INTEGRATION_TOOL = fileURLToPath(new URL('../fixtures/integration-tool.mjs', import.meta.url))
export const FAKE_HOST_FIXTURE = fileURLToPath(new URL('../fixtures/fake-host.ts', import.meta.url))
const SUPERVISOR_CLI = fileURLToPath(new URL('../../lib/supervisor/cli.js', import.meta.url))

export interface IntegrationHarnessOptions {
  readonly profile?: string
  /** Extra config fields to push to the supervisor (merged over sensible small timeout defaults). */
  readonly config?: Partial<SupervisorConfig>
  /** When true, a fresh supervisor process is spawned as a daemon subprocess. */
  readonly subprocess?: boolean
  /** When true, lifecycle-spawned replacement hosts exit immediately (crash-recovery). */
  readonly crashImmediate?: boolean
  /** When set, lifecycle-spawned replacement hosts serve health briefly then crash. */
  readonly crashAfterMs?: number
  /** When true, adopt every replacement host the supervisor spawns via a fresh bridge (crash circuit). */
  readonly autoReconnect?: boolean
}

export interface SupervisorProcess {
  readonly child: ChildProcess
  readonly pid: number
  readonly ready: Promise<string> // the supervisor.stateDir once the socket exists
  /** Captured stderr (for diagnostics). */
  readonly stderr: string
  stop(): Promise<void>
}

export interface IntegrationHarness {
  readonly profile: string
  readonly dshHome: string
  readonly stateDir: string
  readonly endpoint: string
  readonly token: string
  /** The web URL (host:port) the supervisor serves. */
  readonly webUrl: string
  readonly layout: TempLayout
  /** Real IPC client connected as the "host" bridge (first hello). */
  readonly bridge: IpcClient
  /** The fake host backing the bridge launch identity. */
  readonly fakeHost: FakeHostProcess
  status(): PublicSupervisorStatus
  updateConfig(config: SupervisorConfig): Promise<void>
  waitForStatus(predicate: (status: PublicSupervisorStatus) => boolean, timeoutMs?: number): Promise<void>
  emitActivity(snapshot: import('../../src/shared/protocol.js').ActivitySnapshot): Promise<void>
  emitHostDisposing(): Promise<void>
  emitHmrReload(entries: readonly string[]): Promise<void>
  requestRestart(force: boolean): Promise<void>
  /** Issue a restart command without awaiting its completion (used to observe a gated restart pending). */
  fireRestart(force: boolean): Promise<import('../../src/supervisor/ipc.js').IpcCommandResult>
  connectDuplicateBridge(): Promise<IpcClient>
  setBuildMode(mode: 'ok' | 'fail' | 'block'): Promise<void>
  changePluginSource(relative: string, content?: string): Promise<void>
  pluginRoot(): string
  /** Kill the backing fake host (drives a crash/restart path). */
  killHost(): Promise<void>
  /**
   * Reconnect the bridge to a newly spawned host whose /health now serves a
   * different boot id. The real DSH host reconnects its bridge after a restart,
   * which the supervisor's restart health check waits for; the harness must do
   * the same so a replacement host can go healthy.
   */
  reconnectToCurrentHost(): Promise<string>
  /**
   * Wait (bounded) for the served host to change away from `previousBootId`
   * and reconnect the bridge to it. Returns the new boot id. Mirrors the real
   * DSH host reconnecting its bridge after a supervisor restart / crash
   * recovery, which the supervisor's health check requires.
   */
  waitForHostReplacement(previousBootId: string, timeoutMs?: number): Promise<string>
  /** The boot id currently served at the supervisor's webUrl (new host after a restart). */
  currentHostBootId(): Promise<string>
  /** True while the supervisor's webUrl responds to /health. */
  hostHealth(): Promise<boolean>
  /** Wait (bounded) until the served host health reports a fresh boot id. */
  waitForHostBootId(newBootId: string, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export interface StartedIntegrationHarness extends IntegrationHarness {
  readonly supervisor: SupervisorProcess
}

let supervisorLock: Promise<void> | undefined
export function ensureSupervisorBuilt(): Promise<void> {
  if (supervisorLock !== undefined) return supervisorLock
  supervisorLock = ensureBuiltPackage()
  return supervisorLock
}

export async function startIntegrationHarness(
  options: IntegrationHarnessOptions = {},
): Promise<StartedIntegrationHarness> {
  await ensureSupervisorBuilt()
  // Recover from any fixture leaked by an earlier test that timed out before its
  // `close()` ran. Only processes at least ~20s old are reaped, so concurrent
  // live fixtures in other vitest workers are never touched.
  await reapStaleFixtureProcesses()
  // Guard against any internal stall so a start neither hangs the suite nor
  // leaks a half-spawned supervisor.
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('integration harness start timed out after 8s')), 8_000)
    timer.unref?.()
  })
  return await Promise.race([startInner(options), deadline])
}

async function startInner(
  options: IntegrationHarnessOptions,
): Promise<StartedIntegrationHarness> {
  const profile = options.profile ?? 'web'
  const layout = await createTempLayout(profile)
  const dshHome = layout.dshHome
  const paths = await resolveRuntimePaths({ dshHome, profile })
  const pluginRoot = join(layout.dshHome, 'plugins', 'dr-integration-plugin')
  const withPlugin = async () => {
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      name: 'integration-profile',
      private: true,
      dependencies: { 'dr-integration-plugin': `file:${pluginRoot}` },
    })
    await layout.writeJson(join(pluginRoot, 'package.json'), {
      name: 'dr-integration-plugin',
      version: '1.0.0',
      type: 'module',
      main: './lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      scripts: {
        build: `node ${INTEGRATION_TOOL} build`,
        'dev:web': `node ${INTEGRATION_TOOL} dev-web`,
      },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    })
    await layout.writeText(join(pluginRoot, 'cordis.patch.yml'), '- insert: []\n')
    await layout.writeText(join(pluginRoot, 'src', 'index.ts'), 'export const a = 1\n')
    await layout.writeText(join(pluginRoot, 'src', 'client', 'index.tsx'), 'export const b = 1\n')
    await layout.writeText(join(pluginRoot, 'tsconfig.json'), '{}\n')
    await layout.writeText(join(pluginRoot, 'tsdown.config.ts'), 'export default {}\n')
    // build-mode lives under generated/ (ignored) so writing it never re-triggers
    // a watch cycle and destabilizes the routing assertion.
    await layout.writeText(join(pluginRoot, 'generated', 'build-mode'), 'ok')
  }
  await withPlugin()

  // Discovery canonicalizes the project root (realpath). Chokidar reports events
  // against the canonical watched root, so the harness must write through the
  // same canonical path (/var -> /private/var on macOS) or watcher matching of
  // the emitted relative path fails.
  const canonicalPluginRoot = await realpath(pluginRoot)

  try {
    const supervisor = await spawnSupervisorProcess(layout, profile)
    const stateDir = await supervisor.ready
    const token = await readToken(stateDir)
    const fakeHost = spawnFakeHost()

    // Wait for the fake host to be live before wiring the bridge.
    await fakeHost.ready

    // Pass the fake host's OS port into the launch env so any lifecycle-spawned
    // replacement (restart/crash) binds the same port and serves the same URL.
    let launch = await buildLaunch(layout, profile, fakeHost, options.crashImmediate, options.crashAfterMs)

    const statusRef: { current: PublicSupervisorStatus } = {
      current: { phase: 'starting', changedAt: Date.now() },
    }
    // Monotonic sequence for the harness's post-reconnect activity snapshots.
    let activitySequence = 0
    let bridge = await connectToSupervisor({
      endpoint: paths.endpoint,
      token,
      hello: { hostPid: launch.pid, bootId: launch.bootId, launch },
      onEvent: event => {
        if (event.type === 'status') statusRef.current = event.status
      },
    })
    // Every live bridge (including reconnection stand-ins) is tracked so `close`
    // can reap them. The primary `bridge` is the latest; an old bridge that fired
    // an in-flight restart command must stay open until that command resolves.
    const bridges = new Set<IpcClient>([bridge])

    const initialConfig = defaultConfig(profile, options.config)
    await bridge.request(updateConfigCommand(initialConfig))
    // Bootstrap the status cache (initial transitions are broadcast before this
    // bridge authenticates, so explicitly refresh once now — the command queue
    // is free at this point).
    await bridge.request({ protocolVersion: PROTOCOL_VERSION, type: 'get-status', requestId: 'bootstrap-status' })
      .catch(() => undefined)

    const harness: StartedIntegrationHarness = {
      profile,
      dshHome,
      stateDir,
      endpoint: paths.endpoint,
      token,
      webUrl: launch.webUrl,
      layout,
      bridge,
      fakeHost,
      supervisor,
      status: () => statusRef.current,
      updateConfig: async config => { await bridge.request(updateConfigCommand(config)) },
      waitForStatus: async (predicate, timeoutMs = 10_000) => {
        // Status transitions broadcast immediately, but a replacement bridge
        // can connect at the same instant as the final recovery event. Issue a
        // bounded low-frequency get-status command as an anti-race snapshot;
        // command dispatch remains available while restart work is in flight.
        const deadline = Date.now() + timeoutMs
        let nextProbeAt = 0
        for (;;) {
          if (predicate(statusRef.current)) return
          const checkedAt = Date.now()
          if (checkedAt >= nextProbeAt) {
            nextProbeAt = checkedAt + 250
            await bridge.request({
              protocolVersion: PROTOCOL_VERSION,
              type: 'get-status',
              requestId: `status-${randomUUID()}`,
            }).catch(() => undefined)
          }
          if (Date.now() > deadline) {
            throw new Error(`status did not match within ${timeoutMs}ms: ${statusRef.current.phase} ${statusRef.current.reason ?? ''}`)
          }
          await delay(15)
        }
      },
      emitActivity: async snapshot => {
        await bridge.emit({ protocolVersion: PROTOCOL_VERSION, type: 'activity', snapshot })
      },
      emitHostDisposing: async () => {
        await bridge.emit({ protocolVersion: PROTOCOL_VERSION, type: 'host-disposing', hostPid: launch.pid })
      },
      emitHmrReload: async entries => {
        await bridge.emit({ protocolVersion: PROTOCOL_VERSION, type: 'hmr-reload', entries })
      },
      requestRestart: async force => {
        await bridge.request(restartCommand(force))
      },
      fireRestart: force => bridge.request(restartCommand(force)),
      connectDuplicateBridge: async () => {
        const duplicate = await connectToSupervisor({
          endpoint: paths.endpoint,
          token,
          hello: { hostPid: launch.pid, bootId: launch.bootId, launch },
          onEvent: () => undefined,
        })
        bridges.add(duplicate)
        return duplicate
      },
      setBuildMode: async mode => {
        await writePluginFile(join(canonicalPluginRoot, 'generated', 'build-mode'), mode)
      },
      changePluginSource: async (relative, content = '') => {
        await writePluginFile(join(canonicalPluginRoot, relative), content)
      },
      pluginRoot: () => canonicalPluginRoot,
      killHost: async () => {
        await fakeHost.stop()
      },
      reconnectToCurrentHost: async () => {
        // A replacement host after a restart binds the same port and serves a
        // fresh boot id. Open a fresh bridge (like the real DSH host does) so
        // the supervisor's crash/restart health check can observe the new boot
        // id and adopt the live replacement pid as the new host. The previous
        // bridge (which may hold an in-flight restart command) is left open and
        // reaped together with all other bridges on `close`.
        const bootId = await currentHealthBootId(launch.webUrl)
        const pid = await currentHostPid(launch.webUrl)
        const next = await connectToSupervisor({
          endpoint: paths.endpoint,
          token,
          hello: { hostPid: pid, bootId, launch: { ...launch, pid, bootId } },
          onEvent: event => {
            if (event.type === 'status') statusRef.current = event.status
          },
        })
        bridges.add(next)
        bridge = next
        launch = { ...launch, pid, bootId }
        // Mirror the real host bridge, which publishes an initial activity
        // snapshot as soon as it connects. Without this, the supervisor's gate
        // stays bridge-unknown after a generation change and any queued or later
        // full-restart cycle would wait on the gate forever (stuck in
        // pending-restart) instead of reopening on fresh activity.
        await next.emit({
          protocolVersion: PROTOCOL_VERSION,
          type: 'activity',
          snapshot: {
            sequence: ++activitySequence,
            capturedAt: Date.now(),
            runningAgents: 0,
            runningJobs: 0,
            stoppingJobs: 0,
          },
        })
        return bootId
      },
      waitForHostReplacement: async (previousBootId, timeoutMs = 12_000) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          try {
            const candidate = await currentHealthBootId(launch.webUrl)
            if (candidate !== previousBootId) {
              // Retry reconnection: the freshly spawned replacement can briefly
              // not accept a bridge (pid/ready race), so retry until it lands.
              try {
                return await harness.reconnectToCurrentHost()
              } catch {
                // fall through and retry the whole cycle until the deadline
              }
            }
          } catch {
            // host not serving a fresh boot id yet, retry
          }
          if (Date.now() > deadline) {
            const status = statusRef.current
            throw new Error(
              `host never served a replacement boot id (was ${previousBootId || 'none'}; `
              + `phase=${status.phase}; reason=${status.reason ?? 'none'}; error=${status.error ?? 'none'}; `
              + `fakePid=${fakeHost.child.pid ?? 'none'}; fakeExit=${fakeHost.child.exitCode ?? 'null'}; `
              + `fakeSignal=${fakeHost.child.signalCode ?? 'null'})`,
            )
          }
          await delay(80)
        }
      },
      currentHostBootId: async () => {
        return currentHealthBootId(launch.webUrl)
      },
      hostHealth: async () => {
        try {
          await harness.currentHostBootId()
          return true
        } catch {
          return false
        }
      },
      waitForHostBootId: async (newBootId, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          try {
            if (await harness.currentHostBootId() === newBootId) return
          } catch {
            // host not serving yet
          }
          if (Date.now() > deadline) {
            throw new Error(`host never served boot id ${newBootId}`)
          }
          await delay(30)
        }
      },
      close: async () => {
        // Stop the supervisor first so any in-flight IPC command (e.g. a gated
        // restart) is answered by the still-alive supervisor (ok:false on abort)
        // before the bridge socket is closed, avoiding orphaned rejections.
        await supervisor.stop().catch(() => undefined)
        await Promise.all([...bridges].map(client => client.close().catch(() => undefined)))
        await fakeHost.stop().catch(() => undefined)
        // Reap the supervisor's detached children (replacement fake hosts,
        // dev-web watchers) and anything still bound to this run's port.
        await reapProcessTree(supervisor.pid)
        await reapPortProcesses(launch.webUrl)
        await layout.cleanup()
      },
    }
    if (options.autoReconnect) {
      startAutoReconnect(harness)
    }
    return harness
  } catch (error) {
    await layout.cleanup()
    throw error
  }
}

/** Continuously adopt any replacement host the supervisor spawns (crash circuit). */
function startAutoReconnect(harness: IntegrationHarness): void {
  let knownBootId: string | undefined
  const timer = setInterval(() => {
    void (async () => {
      try {
        const bootId = await currentHealthBootId(harness.webUrl)
        if (knownBootId !== undefined && bootId !== knownBootId) {
          knownBootId = await harness.reconnectToCurrentHost()
        } else {
          knownBootId = knownBootId ?? bootId
        }
      } catch {
        // host not serving yet; keep polling
      }
    })()
  }, 60)
  timer.unref?.()
}

function defaultConfig(profile: string, overrides: Partial<SupervisorConfig> | undefined): SupervisorConfig {
  return {
    ...DEFAULT_SUPERVISOR_CONFIG,
    profile,
    debounceMs: 1,
    healthTimeoutMs: 6_000,
    shutdownGraceMs: 2_000,
    bridgeGraceMs: 2_000,
    crashWindowMs: 2_000,
    maxCrashRestarts: 3,
    ignored: ['generated/**'],
    ...overrides,
  }
}

async function spawnSupervisorProcess(layout: TempLayout, profile: string): Promise<SupervisorProcess> {
  const child = spawn(process.execPath, [SUPERVISOR_CLI, '--serve', '--profile', profile], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: layout.dshHome },
    detached: true,
  })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  child.on('error', () => undefined)

  const paths = await resolveRuntimePaths({ dshHome: layout.dshHome, profile })
  const socket = paths.endpoint
  const ready = (async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`supervisor exited early (${child.exitCode}, ${child.signalCode}): ${stderr}`)
      }
      try {
        const { access } = await import('node:fs/promises')
        await access(socket)
        return paths.stateDir
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`supervisor socket did not appear: ${stderr}`)
        }
        await delay(25)
      }
    }
  })()

  return {
    child,
    pid: child.pid!,
    ready,
    stderr,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') {
        // Windows signals terminate Node immediately, bypassing the
        // supervisor's graceful watcher cleanup. Kill the complete fixture
        // tree explicitly so pnpm/cmd watcher descendants cannot survive.
        await reapProcessTree(child.pid!)
      } else {
        child.kill('SIGTERM')
      }
      await waitForExit(child, 3_000)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await waitForExit(child, 1_000)
    },
  }
}

export interface SecondSupervisorResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/**
 * Spawn a *second* supervisor CLI against an already-owned DSH home/profile.
 * The first supervisor holds the lock, so this process must fail to acquire it,
 * print the failure to stderr, and exit nonzero (the CLI's direct-entry guard).
 */
export function spawnSecondSupervisor(dshHome: string, profile: string): Promise<SecondSupervisorResult> {
  return new Promise<SecondSupervisorResult>((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR_CLI, '--serve', '--profile', profile], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: dshHome },
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

async function buildLaunch(
  layout: TempLayout,
  profile: string,
  fakeHost: FakeHostProcess,
  crashImmediate = false,
  crashAfterMs = 0,
): Promise<import('../../src/shared/protocol.js').HostLaunchSpec> {
  const ready = await fakeHost.ready
  return {
    pid: ready.pid,
    bootId: ready.bootId,
    nodeExecutable: process.execPath,
    execArgv: [],
    argv: [FAKE_HOST_FIXTURE],
    cwd: layout.root,
    env: {
      FAKE_HOST_PORT: String(ready.port),
      FAKE_HOST_BOOT_ID: ready.bootId,
      FAKE_HOST_EXIT_IMMEDIATE: crashImmediate ? '1' : '',
      ...(crashAfterMs > 0 ? { FAKE_HOST_CRASH_AFTER_MS: String(crashAfterMs) } : {}),
    },
    profile,
    webUrl: `http://127.0.0.1:${ready.port}`,
  }
}

async function readToken(stateDir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const token = (await readFile(join(stateDir, 'supervisor.token'), 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid supervisor token')
  return token
}

function updateConfigCommand(config: SupervisorConfig): SupervisorCommand {
  return { protocolVersion: PROTOCOL_VERSION, type: 'update-config', requestId: `cfg-${randomUUID()}`, config }
}

/** Write a plugin-source file at an arbitrary (canonical) filesystem path. */
async function writePluginFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

function restartCommand(force: boolean): SupervisorCommand {
  return { protocolVersion: PROTOCOL_VERSION, type: 'restart', requestId: `restart-${randomUUID()}`, force }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>(resolve => child.once('close', () => resolve())),
    delay(timeoutMs),
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

interface FakeHostHealth {
  readonly bootId: string
  readonly pid: number
}

/** GET <webUrl>/health and return the fixture identity (throws on failure/timeout). */
async function currentHostHealth(webUrl: string): Promise<FakeHostHealth> {
  const { get } = await import('node:http')
  return new Promise<FakeHostHealth>((resolve, reject) => {
    let request: ReturnType<typeof get> | undefined
    const timer = setTimeout(() => {
      request?.destroy()
      finish(new Error(`health check timed out: ${webUrl}/health`))
    }, 6_000)
    timer.unref?.()
    let settled = false
    const finish = (error: unknown, health?: FakeHostHealth) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(health!)
    }
    try {
      request = get(webUrl + '/health', response => {
        let body = ''
        response.on('data', chunk => { body += chunk.toString() })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { bootId?: unknown; pid?: unknown }
            if (typeof parsed.bootId !== 'string' || !Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) {
              throw new Error('invalid fake-host health response')
            }
            finish(undefined, { bootId: parsed.bootId, pid: Number(parsed.pid) })
          } catch (error) {
            finish(error)
          }
        })
      })
    } catch (error) {
      finish(error)
      return
    }
    request.on('error', error => finish(error))
  })
}

async function currentHealthBootId(webUrl: string): Promise<string> {
  return (await currentHostHealth(webUrl)).bootId
}

/** Resolve the PID served by the platform-neutral fake-host health fixture. */
async function currentHostPid(webUrl: string): Promise<number> {
  return (await currentHostHealth(webUrl)).pid
}

async function killPid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

/** Kill the fake host still serving this URL, if any. */
async function reapPortProcesses(webUrl: string): Promise<void> {
  try {
    const { pid } = await currentHostHealth(webUrl)
    if (pid > 1) await killPid(pid)
  } catch {
    // no fixture is serving the URL
  }
}

/** Kill any dsh-reloader fixture process that has been alive for at least 20s. */
async function reapStaleFixtureProcesses(): Promise<void> {
  const { execFile } = await import('node:child_process')
  if (process.platform === 'win32') {
    const script = [
      '$cutoff = (Get-Date).AddSeconds(-20);',
      'Get-CimInstance Win32_Process | Where-Object {',
      '  $_.ProcessId -gt 1 -and $_.CreationDate -lt $cutoff -and',
      "  ($_.CommandLine -like '*fake-host.ts*' -or",
      "    $_.CommandLine -like '*integration-tool.mjs*' -or",
      "    $_.CommandLine -like '*lib*supervisor*cli.js*')",
      '} | ForEach-Object { $_.ProcessId }',
    ].join('\n')
    const output: string = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(-2_000) || error.message
          reject(new Error(`failed to enumerate stale Windows fixtures: ${detail}`))
        } else {
          resolve(stdout)
        }
      })
    })
    const pids = output.split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isInteger(pid) && pid > 1)
    await Promise.all(pids.map(pid => reapProcessTree(pid)))
    return
  }

  const output: string = await new Promise(resolve => {
    // `lstart` text varies by locale, so force `LC_ALL=C` for a stable English
    // format. (`etimes` is Linux-only and macOS /bin/ps rejects it.)
    execFile('/bin/ps', ['-axo', 'pid=,lstart=,command='], {
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      resolve(error ? '' : stdout)
    })
  })
  const now = Date.now()
  const cutoff = now - 20_000
  const fixtures = ['tests/fixtures/fake-host.ts', 'tests/fixtures/integration-tool.mjs', 'lib/supervisor/cli.js']
  for (const line of output.split('\n')) {
    if (!fixtures.some(fixture => line.includes(fixture))) continue
    const match = /^\s*(\d+)\s+(.+?)\s{2,}(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const started = Date.parse(match[2] ?? '')
    // Fail safe: only reap a fixture proven older than ~20s; an unparseable
    // start time never reaps (a live fixture must survive).
    if (!Number.isInteger(pid) || pid <= 1) continue
    if (!Number.isNaN(started) && started < cutoff) void killPid(pid)
  }
}

/**
 * Kill the whole descendant process tree rooted at `ppid` (scoped to one run's
 * supervisor, so it never touches another vitest worker's fixtures).
 */
async function reapProcessTree(root: number): Promise<void> {
  if (!Number.isInteger(root) || root <= 1) return
  const { execFile } = await import('node:child_process')
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      execFile('taskkill.exe', ['/pid', String(root), '/t', '/f'], () => resolve())
    })
    return
  }

  const output: string = await new Promise(resolve => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], (error, stdout) => {
      resolve(error ? '' : stdout)
    })
  })
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (ppid > 0) {
      const list = children.get(ppid) ?? []
      list.push(pid)
      children.set(ppid, list)
    }
  }
  // Breadth-first descendant collection.
  const descendants: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of children.get(parent) ?? []) {
      descendants.push(child)
      queue.push(child)
    }
  }
  // Kill grandchildren-first so no orphaned process is left behind.
  await Promise.all(descendants.filter(pid => pid !== root).map(pid => killPid(pid)))
}
