import { describe, expect, it, vi } from 'vitest'

import type { SupervisorConfig } from '../../src/shared/config.js'
import { PROTOCOL_VERSION, type HostLaunchSpec } from '../../src/shared/protocol.js'
import type { ChangePlan } from '../../src/supervisor/classifier.js'
import type { ProjectDescriptor } from '../../src/supervisor/discovery.js'
import type { HostLifecycle } from '../../src/supervisor/lifecycle.js'
import type { CommandRunner } from '../../src/supervisor/runner.js'
import type { ChangeScheduler, ChangeSchedulerOptions } from '../../src/supervisor/scheduler.js'
import type { TaskGate } from '../../src/supervisor/task-gate.js'
import type { CreateWatchPlanControllerOptions, WatchPlanController } from '../../src/supervisor/watcher.js'
import { createSupervisor } from '../../src/supervisor/supervisor.js'
import {
  createHandoffFollow,
  type HandoffChannel,
  type HandoffMessage,
} from '../../src/supervisor/handoff.js'

const project: ProjectDescriptor = {
  id: 'plugin',
  kind: 'linked-plugin',
  root: '/repo/plugin',
  workspaceRoot: '/repo',
  packageName: 'plugin',
  serverEntries: ['/repo/plugin/src/index.ts'],
  clientEntries: ['/repo/plugin/src/client.ts'],
  manifests: ['/repo/plugin/package.json'],
  build: { executable: 'pnpm', args: ['build'], cwd: '/repo/plugin' },
  devWeb: { executable: 'pnpm', args: ['dev:web'], cwd: '/repo/plugin' },
  outputRoots: ['/repo/plugin/lib'],
}

const launch: HostLaunchSpec = {
  pid: 41,
  bootId: 'old-boot',
  nodeExecutable: '/node',
  execArgv: [],
  argv: ['/dsh', 'web'],
  cwd: '/repo',
  env: {},
  profile: 'web',
  webUrl: 'http://127.0.0.1:1',
}

function plan(impact: ChangePlan['impact'], actions: ChangePlan['actions']): ChangePlan {
  return { impact, actions }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const baseConfig: SupervisorConfig = {
  enabled: true,
  profile: 'web',
  sourceRoots: [],
  debounceMs: 1,
  healthTimeoutMs: 100,
  shutdownGraceMs: 100,
  bridgeGraceMs: 20,
  crashWindowMs: 100,
  maxCrashRestarts: 3,
  ignored: ['generated/**'],
  projectOverrides: [],
  logLevel: 'info',
}

interface HarnessOptions {
  readonly buildExitCode?: number
  readonly gateOpen?: boolean
  readonly bridgeGraceMs?: number
  readonly discover?: () => Promise<{ projects: readonly ProjectDescriptor[]; warnings: readonly [] }>
  readonly replace?: WatchPlanController['replace']
  readonly restart?: HostLifecycle['restart']
  readonly disposingResult?: Awaited<ReturnType<HostLifecycle['observeHostDisposing']>>
  readonly observeHostDisposing?: HostLifecycle['observeHostDisposing']
  readonly unexpectedExitResult?: Awaited<ReturnType<HostLifecycle['observeUnexpectedExit']>>
  readonly observeUnexpectedExit?: HostLifecycle['observeUnexpectedExit']
  readonly ensurePersistent?: CommandRunner['ensurePersistent']
  readonly createLifecycle?: (config: SupervisorConfig, launch: HostLaunchSpec) => HostLifecycle
  readonly createScheduler?: (options: ChangeSchedulerOptions, defaultScheduler: ChangeScheduler) => ChangeScheduler
}

function lifecycleStub(overrides: Partial<HostLifecycle> = {}): HostLifecycle {
  const adopted = { pid: 41, bootId: 'old-boot', launch, source: 'adopted' as const }
  const replacement = { ...adopted, pid: 42, bootId: 'new-boot', source: 'spawned' as const }
  return {
    adopt: vi.fn(async adoptedLaunch => ({ ...adopted, pid: adoptedLaunch.pid, bootId: adoptedLaunch.bootId, launch: adoptedLaunch })),
    restart: vi.fn(async () => ({
      host: replacement,
      health: { healthy: true as const, httpReady: true, bridgeReady: true, expectedBootId: 'new-boot', observedBootId: 'new-boot' },
    })),
    observeUnexpectedExit: vi.fn(async () => 'restarted'),
    observeHostDisposing: vi.fn(async () => 'reconnected'),
    observeBridgeConnected: vi.fn(),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  }
}

function harness(options: HarnessOptions = {}) {
  let schedulerOptions!: ChangeSchedulerOptions
  const schedulerOptionsHistory: ChangeSchedulerOptions[] = []
  let watcherOptions!: CreateWatchPlanControllerOptions
  const watcher: WatchPlanController = {
    replace: vi.fn(options.replace ?? (async watchPlan => ({
      promoted: true,
      watchedRoots: watchPlan.projects.map(item => item.root),
      degradedRoots: [],
    }))),
    inspect: vi.fn(() => ({ promoted: true, watchedRoots: [project.root], degradedRoots: [] })),
    close: vi.fn(async () => undefined),
  }
  const scheduler: ChangeScheduler = {
    enqueue: vi.fn(),
    waitForIdle: vi.fn(async () => ({ kind: 'success' as const })),
    close: vi.fn(async () => undefined),
  }
  const runner: CommandRunner = {
    run: vi.fn(async () => ({
      exitCode: options.buildExitCode ?? 0,
      signal: null,
      stdout: '',
      stderr: options.buildExitCode ? 'compile failed' : '',
    })),
    ensurePersistent: vi.fn(options.ensurePersistent ?? (async (key, command) => ({
      key,
      command,
      pid: 88,
      done: new Promise(() => undefined),
      stop: async () => undefined,
    }))),
    stopAll: vi.fn(async () => undefined),
    persistentCount: 0,
  }
  let gateOpen = options.gateOpen ?? true
  let openGate!: () => void
  const gateWait = new Promise<void>(resolve => { openGate = resolve })
  const gate: TaskGate & { bridgeReplaced(): void } = {
    inspect: vi.fn(() => gateOpen ? { open: true as const } : { open: false as const, reason: 'bridge-unknown' as const }),
    updateActivity: vi.fn(() => true),
    bridgeDisconnected: vi.fn(),
    bridgeReplaced: vi.fn(),
    beginLocalTask: vi.fn(() => vi.fn()),
    waitUntilOpen: vi.fn(async signal => {
      if (gateOpen) return
      await Promise.race([
        gateWait,
        new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
      ])
    }),
  }
  const lifecycle = lifecycleStub({
    ...(options.restart === undefined ? {} : { restart: vi.fn(options.restart) }),
    observeUnexpectedExit: vi.fn(options.observeUnexpectedExit ?? (async () => options.unexpectedExitResult ?? 'restarted')),
    observeHostDisposing: vi.fn(options.observeHostDisposing ?? (async () => options.disposingResult ?? 'reconnected')),
  })
  const statuses: string[] = []
  const discover = vi.fn(options.discover ?? (async () => ({ projects: [project], warnings: [] as const })))
  const createWatcher = vi.fn((value: CreateWatchPlanControllerOptions) => { watcherOptions = value; return watcher })
  const createScheduler = vi.fn((value: ChangeSchedulerOptions) => {
    schedulerOptions = value
    schedulerOptionsHistory.push(value)
    return options.createScheduler?.(value, scheduler) ?? scheduler
  })
  const supervisor = createSupervisor({
    config: { ...baseConfig, bridgeGraceMs: options.bridgeGraceMs ?? baseConfig.bridgeGraceMs },
    discover,
    createWatcher,
    createScheduler,
    runner,
    gate,
    lifecycle,
    ...(options.createLifecycle === undefined ? {} : { createLifecycle: options.createLifecycle }),
    createBootId: () => 'new-boot',
    publishStatus: status => { statuses.push(status.phase) },
  })
  return {
    supervisor, watcher, scheduler, runner, gate, lifecycle, statuses, discover, createWatcher, createScheduler,
    getSchedulerOptions: () => schedulerOptions,
    getSchedulerOptionsAt: (index: number) => schedulerOptionsHistory[index]!,
    getWatcherOptions: () => watcherOptions,
    openGate: () => { gateOpen = true; openGate() },
  }
}

describe('DevReloaderSupervisor', () => {
  it('discovers projects, installs the watch plan, and wires watcher events to the scheduler', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    expect(h.watcher.replace).toHaveBeenCalledWith({ projects: [project], ignored: ['generated/**'] })
    const event = { kind: 'change' as const, project, origin: 'project' as const, path: 'src/index.ts' }
    h.getWatcherOptions().onEvent(event)
    expect(h.scheduler.enqueue).toHaveBeenCalledWith(event)
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('resets bridge activity generations only when adopting a different host identity', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    expect(h.gate.bridgeReplaced).toHaveBeenCalledOnce()

    // Same-generation hello: no reset.
    h.supervisor.prepareBridge(launch)
    expect(h.gate.bridgeReplaced).toHaveBeenCalledOnce()

    // New generation (pid/boot change): the synchronous prepareBridge resets.
    h.supervisor.prepareBridge({ ...launch, pid: 42, bootId: 'next-boot' })
    expect(h.gate.bridgeReplaced).toHaveBeenCalledTimes(2)

    // bridgeConnected itself must not re-reset (the reset belongs to prepareBridge).
    await h.supervisor.bridgeConnected({ ...launch, pid: 42, bootId: 'next-boot' })
    expect(h.gate.bridgeReplaced).toHaveBeenCalledTimes(2)
  })

  it('leaves the host untouched and reports degraded when a build fails', async () => {
    const h = harness({ buildExitCode: 1 })
    await h.supervisor.start(launch)
    const result = await h.getSchedulerOptions().runBuilds(plan('server-hmr', [{
      kind: 'build', impact: 'server-hmr', projectId: project.id, command: project.build!,
    }]), new AbortController().signal)
    expect(result).toEqual({ kind: 'build-failed', error: 'compile failed' })
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
    expect(h.supervisor.status.phase).toBe('degraded')
  })

  it('completes config HMR and ensures a persistent client watcher', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    await h.getSchedulerOptions().runBuilds(plan('config-hmr', []), new AbortController().signal)
    await h.getSchedulerOptions().onReady(plan('config-hmr', []))
    expect(h.supervisor.status.phase).toBe('watching')

    await h.getSchedulerOptions().runBuilds(plan('client-hmr', []), new AbortController().signal)
    await h.getSchedulerOptions().onReady(plan('client-hmr', [{
      kind: 'client-watch', impact: 'client-hmr', projectId: project.id, command: project.devWeb!,
    }]))
    expect(h.runner.ensurePersistent).toHaveBeenCalledWith('client-watch:plugin', project.devWeb)
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('requires an explicit matching server HMR acknowledgement', async () => {
    const h = harness({ bridgeGraceMs: 1_000 })
    await h.supervisor.start(launch)
    await h.getSchedulerOptions().runBuilds(plan('server-hmr', []), new AbortController().signal)
    const ready = h.getSchedulerOptions().onReady(plan('server-hmr', [{
      kind: 'server-hmr', impact: 'server-hmr', projectId: project.id, path: 'src/index.ts',
    }]))
    await Promise.resolve()
    expect(h.supervisor.status.phase).toBe('hmr-wait')
    await h.supervisor.handleBridgeEvent({ protocolVersion: PROTOCOL_VERSION, type: 'hmr-reload', entries: ['other.ts'] })
    expect(h.supervisor.status.phase).toBe('hmr-wait')
    await h.supervisor.handleBridgeEvent({ protocolVersion: PROTOCOL_VERSION, type: 'hmr-reload', entries: ['src/index.ts'] })
    await ready
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('escalates an expired server HMR wait to a gated full restart', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ bridgeGraceMs: 10 })
      await h.supervisor.start(launch)
      await h.getSchedulerOptions().runBuilds(plan('server-hmr', []), new AbortController().signal)
      const ready = h.getSchedulerOptions().onReady(plan('server-hmr', [{
        kind: 'server-hmr', impact: 'server-hmr', projectId: project.id, path: 'src/index.ts',
      }]))
      await vi.advanceTimersByTimeAsync(10)
      await ready
      expect(h.lifecycle.restart).toHaveBeenCalledOnce()
      expect(h.supervisor.status.phase).toBe('watching')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a full restart pending while bridge activity is unknown, then continues when idle', async () => {
    const h = harness({ gateOpen: false })
    await h.supervisor.start(launch)
    const restart = h.supervisor.requestRestart({ force: false, reason: 'source change' })
    await Promise.resolve()
    expect(h.supervisor.status.phase).toBe('pending-restart')
    expect(h.supervisor.status.reason).toBe('source change')
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
    h.openGate()
    await restart
    expect(h.lifecycle.restart).toHaveBeenCalledOnce()
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('force bypasses the gate and duplicate restarts share one transaction', async () => {
    const h = harness({ gateOpen: false })
    await h.supervisor.start(launch)
    const first = h.supervisor.requestRestart({ force: false, reason: 'manual' })
    const duplicate = h.supervisor.requestRestart({ force: false, reason: 'manual' })
    const forced = h.supervisor.requestRestart({ force: true, reason: 'manual' })
    await Promise.all([first, duplicate, forced])
    expect(h.lifecycle.restart).toHaveBeenCalledOnce()
  })

  it('pause closes watchers and persistent helpers without killing DSH', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    await h.supervisor.pause()
    expect(h.watcher.close).toHaveBeenCalledOnce()
    expect(h.runner.stopAll).toHaveBeenCalledOnce()
    expect(h.lifecycle.dispose).not.toHaveBeenCalled()
    expect(h.supervisor.status.phase).toBe('paused')
  })

  it('lets a planned restart own host disposal and passes its abort signal to lifecycle', async () => {
    const restarting = deferred<Awaited<ReturnType<HostLifecycle['restart']>>>()
    let restartSignal: AbortSignal | undefined
    const h = harness({
      restart: async request => {
        restartSignal = request.signal
        return restarting.promise
      },
    })
    await h.supervisor.start(launch)
    const restart = h.supervisor.requestRestart({ force: true, reason: 'planned' })
    await vi.waitFor(() => expect(h.lifecycle.restart).toHaveBeenCalledOnce())

    await h.supervisor.handleBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid,
    })
    expect(h.lifecycle.observeHostDisposing).not.toHaveBeenCalled()
    expect(restartSignal).toBeInstanceOf(AbortSignal)

    restarting.resolve({
      host: { pid: 42, bootId: 'new-boot', launch: { ...launch, pid: 42, bootId: 'new-boot' }, source: 'spawned' },
      health: { healthy: true, httpReady: true, bridgeReady: true, expectedBootId: 'new-boot', observedBootId: 'new-boot' },
    })
    await restart
  })

  it('ignores stale host disposal before disconnecting the active bridge gate', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    vi.mocked(h.gate.bridgeDisconnected).mockClear()

    await h.supervisor.handleBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid + 1,
    })

    expect(h.gate.bridgeDisconnected).not.toHaveBeenCalled()
    expect(h.lifecycle.observeHostDisposing).not.toHaveBeenCalled()
  })

  it('stops on an unplanned host stop but keeps supervising a bridge reconnection', async () => {
    const stopped = harness({ disposingResult: 'stopped' })
    await stopped.supervisor.start(launch)
    await stopped.supervisor.handleBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid,
    })
    expect(stopped.lifecycle.dispose).toHaveBeenCalledOnce()
    expect(stopped.supervisor.status.phase).toBe('paused')

    const reconnected = harness({ disposingResult: 'reconnected' })
    await reconnected.supervisor.start(launch)
    await reconnected.supervisor.handleBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid,
    })
    await reconnected.supervisor.bridgeConnected(launch)
    expect(reconnected.lifecycle.observeBridgeConnected).toHaveBeenCalled()
    expect(reconnected.lifecycle.dispose).not.toHaveBeenCalled()
    expect(reconnected.supervisor.status.phase).toBe('watching')
  })

  it('routes unexpected exits through lifecycle and opens the circuit as failed', async () => {
    const recovered = harness({ unexpectedExitResult: 'restarted' })
    await recovered.supervisor.start(launch)
    await recovered.supervisor.observeUnexpectedExit(launch.pid)
    expect(recovered.lifecycle.observeUnexpectedExit).toHaveBeenCalledOnce()
    expect(recovered.supervisor.status.phase).toBe('restarting')
    await recovered.supervisor.observeUnexpectedExit(launch.pid)
    expect(recovered.lifecycle.observeUnexpectedExit).toHaveBeenCalledOnce()
    await recovered.supervisor.bridgeConnected({ ...launch, pid: 42, bootId: 'crash-boot' })
    expect(recovered.supervisor.status.phase).toBe('watching')

    const circuit = harness({ unexpectedExitResult: 'circuit-open' })
    await circuit.supervisor.start(launch)
    await circuit.supervisor.observeUnexpectedExit(launch.pid)
    expect(circuit.supervisor.status.phase).toBe('failed')
  })

  it('does not return from pause until an in-flight restart is aborted and settled', async () => {
    const restartSettled = deferred<Awaited<ReturnType<HostLifecycle['restart']>>>()
    let observedSignal: AbortSignal | undefined
    const h = harness({
      restart: request => {
        observedSignal = request.signal
        return restartSettled.promise
      },
    })
    await h.supervisor.start(launch)
    const restart = h.supervisor.requestRestart({ force: true, reason: 'manual' })
    await vi.waitFor(() => expect(h.lifecycle.restart).toHaveBeenCalledOnce())
    let pauseReturned = false
    const pause = h.supervisor.pause().then(() => { pauseReturned = true })
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true))
    expect(pauseReturned).toBe(false)
    restartSettled.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(restart).rejects.toMatchObject({ name: 'AbortError' })
    await pause
    expect(h.supervisor.status.phase).toBe('paused')
    expect(h.statuses).not.toContain('recovering')
  })

  it('shares concurrent startup and fully unwinds a failed attempt before retry', async () => {
    const discovery = deferred<{ projects: readonly ProjectDescriptor[]; warnings: readonly [] }>()
    const concurrent = harness({ discover: () => discovery.promise })
    const first = concurrent.supervisor.start(launch)
    let secondReturned = false
    const second = concurrent.supervisor.start(launch).then(() => { secondReturned = true })
    await vi.waitFor(() => expect(concurrent.discover).toHaveBeenCalledOnce())
    expect(secondReturned).toBe(false)
    discovery.resolve({ projects: [project], warnings: [] })
    await Promise.all([first, second])
    expect(concurrent.createWatcher).toHaveBeenCalledOnce()
    expect(concurrent.lifecycle.adopt).toHaveBeenCalledOnce()

    let attempt = 0
    const retry = harness({
      replace: async watchPlan => {
        attempt += 1
        if (attempt === 1) throw new Error('watch setup failed')
        return { promoted: true, watchedRoots: watchPlan.projects.map(item => item.root), degradedRoots: [] }
      },
    })
    await expect(retry.supervisor.start(launch)).rejects.toThrow('watch setup failed')
    expect(retry.watcher.close).toHaveBeenCalledOnce()
    expect(retry.scheduler.close).toHaveBeenCalledOnce()
    await retry.supervisor.start(launch)
    expect(retry.createWatcher).toHaveBeenCalledTimes(2)
    expect(retry.lifecycle.adopt).toHaveBeenCalledOnce()
    expect(retry.supervisor.status.phase).toBe('watching')
  })

  it('serializes manual restart against build readiness and ignores the stale cycle', async () => {
    const build = deferred<{ exitCode: number; signal: null; stdout: string; stderr: string }>()
    const h = harness()
    vi.mocked(h.runner.run).mockImplementationOnce(() => build.promise)
    await h.supervisor.start(launch)
    const changePlan = plan('server-hmr', [
      { kind: 'build', impact: 'server-hmr', projectId: project.id, command: project.build! },
      { kind: 'server-hmr', impact: 'server-hmr', projectId: project.id, path: 'src/index.ts' },
    ])
    const builds = h.getSchedulerOptions().runBuilds(changePlan, new AbortController().signal)
    await vi.waitFor(() => expect(h.runner.run).toHaveBeenCalledOnce())
    const restart = h.supervisor.requestRestart({ force: true, reason: 'manual' })
    build.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    expect(await builds).toEqual({ kind: 'success' })
    await restart
    await expect(h.getSchedulerOptions().onReady(changePlan)).resolves.toBeUndefined()
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('degrades when persistent client watcher setup fails and leaves the host untouched', async () => {
    const h = harness({ ensurePersistent: async () => { throw new Error('dev:web failed') } })
    await h.supervisor.start(launch)
    const clientPlan = plan('client-hmr', [{
      kind: 'client-watch', impact: 'client-hmr', projectId: project.id, command: project.devWeb!,
    }])
    await h.getSchedulerOptions().runBuilds(clientPlan, new AbortController().signal)
    await expect(h.getSchedulerOptions().onReady(clientPlan)).resolves.toBeUndefined()
    expect(h.supervisor.status.phase).toBe('degraded')
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
  })

  it('aborts crash recovery before pause returns and reports recovery failures', async () => {
    let recoverySignal: AbortSignal | undefined
    const recovering = deferred<'restarted' | 'circuit-open'>()
    const h = harness({
      observeUnexpectedExit: (_host, signal) => {
        recoverySignal = signal
        return recovering.promise
      },
    })
    await h.supervisor.start(launch)
    const recovery = h.supervisor.observeUnexpectedExit(launch.pid)
    await vi.waitFor(() => expect(h.lifecycle.observeUnexpectedExit).toHaveBeenCalledOnce())
    const pause = h.supervisor.pause()
    await vi.waitFor(() => expect(recoverySignal?.aborted).toBe(true))
    recovering.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(recovery).resolves.toBeUndefined()
    await pause
    expect(h.supervisor.status.phase).toBe('paused')

    const failed = harness({ observeUnexpectedExit: async () => { throw new Error('recovery health failed') } })
    await failed.supervisor.start(launch)
    await expect(failed.supervisor.observeUnexpectedExit(launch.pid)).rejects.toThrow('recovery health failed')
    expect(failed.supervisor.status.phase).toBe('degraded')
  })

  it('reserves rebuild restart ownership so pause cancels it and manual restart joins it', async () => {
    const build = deferred<{ exitCode: number; signal: null; stdout: string; stderr: string }>()
    const h = harness({ gateOpen: false })
    vi.mocked(h.runner.run).mockImplementationOnce((_command, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      void build.promise.then(resolve, reject)
    }))
    await h.supervisor.start(launch)
    const rebuild = h.supervisor.rebuild()
    const manual = h.supervisor.requestRestart({ force: true, reason: 'manual joins rebuild' })
    expect(manual).toBe(rebuild)
    const pause = h.supervisor.pause()
    await expect(rebuild).rejects.toMatchObject({ name: 'AbortError' })
    await pause
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
  })

  it('keeps the previous watch plan and degrades when config replacement fails', async () => {
    let discoveries = 0
    const h = harness({
      discover: async () => {
        discoveries += 1
        if (discoveries === 2) throw new Error('rediscovery failed')
        return { projects: [project], warnings: [] }
      },
    })
    await h.supervisor.start(launch)
    const updated = { ...baseConfig, ignored: ['next/**'] }
    await expect(h.supervisor.updateConfig(updated)).rejects.toThrow('rediscovery failed')
    expect(h.watcher.replace).toHaveBeenCalledOnce()
    expect(h.supervisor.status.phase).toBe('degraded')
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
    await h.supervisor.updateConfig(updated)
    expect(h.watcher.replace).toHaveBeenLastCalledWith({ projects: [project], ignored: ['next/**'] })
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('keeps the active watch plan, config, and scheduler when replacement scheduler construction fails', async () => {
    let schedulerCreations = 0
    const h = harness({
      createScheduler: (_schedulerOptions, defaultScheduler) => {
        schedulerCreations += 1
        if (schedulerCreations === 2) throw new Error('scheduler construction failed')
        return defaultScheduler
      },
    })
    await h.supervisor.start(launch)
    const updated = { ...baseConfig, debounceMs: 2, ignored: ['next/**'] }

    await expect(h.supervisor.updateConfig(updated)).rejects.toThrow('scheduler construction failed')

    expect(h.watcher.replace).toHaveBeenCalledOnce()
    expect(h.scheduler.close).not.toHaveBeenCalled()
    const event = { kind: 'change' as const, project, origin: 'project' as const, path: 'src/index.ts' }
    h.getWatcherOptions().onEvent(event)
    expect(h.scheduler.enqueue).toHaveBeenCalledWith(event)

    await h.supervisor.updateConfig({ ...baseConfig, ignored: ['later/**'] })
    expect(h.createScheduler).toHaveBeenCalledTimes(2)
    expect(h.watcher.replace).toHaveBeenLastCalledWith({ projects: [project], ignored: ['later/**'] })
  })

  it('clears stale ready cycles when adapters close before a resumed scheduler becomes ready', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    const firstScheduler = h.getSchedulerOptionsAt(0)
    const restartPlan = plan('full-restart', [])
    await firstScheduler.runBuilds(restartPlan, new AbortController().signal)

    await h.supervisor.pause()
    await h.supervisor.updateConfig(baseConfig)
    const resumedScheduler = h.getSchedulerOptionsAt(1)
    await resumedScheduler.runBuilds(restartPlan, new AbortController().signal)
    await resumedScheduler.onReady(restartPlan)

    expect(h.lifecycle.restart).toHaveBeenCalledOnce()
  })

  it('atomically replaces watch configuration and deduplicates rebuild commands', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    const updated = { ...baseConfig, ignored: ['next/**'] }
    await h.supervisor.updateConfig(updated)
    expect(h.watcher.replace).toHaveBeenLastCalledWith({ projects: [project], ignored: ['next/**'] })

    const build = deferred<{ exitCode: number; signal: null; stdout: string; stderr: string }>()
    vi.mocked(h.runner.run).mockImplementationOnce(() => build.promise)
    const first = h.supervisor.rebuild()
    const duplicate = h.supervisor.rebuild()
    build.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    await Promise.all([first, duplicate])
    expect(h.runner.run).toHaveBeenCalledOnce()
    expect(h.lifecycle.restart).toHaveBeenCalledOnce()

    await h.supervisor.pause()
    await expect(h.supervisor.rebuild()).rejects.toThrow(/paused/i)
    await expect(h.supervisor.updateConfig(updated)).resolves.toBeUndefined()
    expect(h.supervisor.status.phase).toBe('watching')
    expect(h.createWatcher).toHaveBeenCalledTimes(2)
  })

  it('rejects reverse-order rebuild while pause cancels and settles the original restart', async () => {
    const h = harness({ gateOpen: false })
    await h.supervisor.start(launch)
    const restart = h.supervisor.requestRestart({ force: false, reason: 'restart first' })
    const rebuild = h.supervisor.rebuild()

    await expect(rebuild).rejects.toThrow('restart already in progress')
    expect(h.runner.run).not.toHaveBeenCalled()

    const pause = h.supervisor.pause()
    await expect(restart).rejects.toMatchObject({ name: 'AbortError' })
    await pause
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
    expect(h.supervisor.status.phase).toBe('paused')
  })

  it('replaces lifecycle policy atomically and routes later operations through the replacement', async () => {
    const replacement = lifecycleStub()
    const createLifecycle = vi.fn(() => replacement)
    const h = harness({ createLifecycle })
    await h.supervisor.start(launch)
    const updated = {
      ...baseConfig,
      healthTimeoutMs: 321,
      shutdownGraceMs: 322,
      bridgeGraceMs: 323,
      crashWindowMs: 324,
      maxCrashRestarts: 4,
    }

    await h.supervisor.updateConfig(updated)
    expect(createLifecycle).toHaveBeenCalledWith(updated, launch)
    expect(replacement.adopt).toHaveBeenCalledWith(launch)
    expect(h.lifecycle.dispose).toHaveBeenCalledOnce()

    await h.supervisor.requestRestart({ force: true, reason: 'new policy' })
    expect(replacement.restart).toHaveBeenCalledOnce()
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
  })

  it('commits a replacement lifecycle and degrades without rejecting when old lifecycle cleanup fails', async () => {
    const replacement = lifecycleStub()
    const createLifecycle = vi.fn(() => replacement)
    const h = harness({ createLifecycle })
    vi.mocked(h.lifecycle.dispose).mockRejectedValueOnce(new Error('old lifecycle cleanup failed'))
    await h.supervisor.start(launch)
    const updated = { ...baseConfig, healthTimeoutMs: 321 }

    await expect(h.supervisor.updateConfig(updated)).resolves.toBeUndefined()

    expect(h.supervisor.status).toMatchObject({
      phase: 'degraded',
      error: 'old lifecycle cleanup failed',
    })
    await h.supervisor.requestRestart({ force: true, reason: 'replacement remains active' })
    expect(replacement.restart).toHaveBeenCalledOnce()
    expect(h.lifecycle.restart).not.toHaveBeenCalled()
    await h.supervisor.updateConfig({ ...updated, ignored: ['next/**'] })
    expect(createLifecycle).toHaveBeenCalledOnce()
  })

  it('retains old lifecycle and configuration when replacement adoption fails', async () => {
    const candidate = lifecycleStub({
      adopt: vi.fn(async () => { throw new Error('candidate adoption failed') }),
    })
    const createLifecycle = vi.fn(() => candidate)
    const h = harness({ createLifecycle })
    await h.supervisor.start(launch)
    const updated = { ...baseConfig, healthTimeoutMs: 321, ignored: ['next/**'] }

    await expect(h.supervisor.updateConfig(updated)).rejects.toThrow('candidate adoption failed')
    expect(candidate.dispose).toHaveBeenCalledOnce()
    expect(h.lifecycle.dispose).not.toHaveBeenCalled()
    expect(h.watcher.replace).toHaveBeenCalledOnce()

    await h.supervisor.requestRestart({ force: true, reason: 'old policy remains' })
    expect(h.lifecycle.restart).toHaveBeenCalledOnce()
  })

  it('rejects lifecycle policy changes without a replacement seam and rejects profile changes', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    await expect(h.supervisor.updateConfig({ ...baseConfig, healthTimeoutMs: 321 }))
      .rejects.toThrow(/lifecycle replacement/i)
    await expect(h.supervisor.updateConfig({ ...baseConfig, profile: 'other' }))
      .rejects.toThrow(/profile.*fixed/i)
    expect(h.discover).toHaveBeenCalledOnce()
    expect(h.watcher.replace).toHaveBeenCalledOnce()
  })

  it('resets an open lifecycle circuit before GUI force restart recovery', async () => {
    const replacement = lifecycleStub()
    const createLifecycle = vi.fn(() => replacement)
    const h = harness({ unexpectedExitResult: 'circuit-open', createLifecycle })
    await h.supervisor.start(launch)
    await h.supervisor.observeUnexpectedExit(launch.pid)
    expect(h.supervisor.status.phase).toBe('failed')

    await h.supervisor.requestRestart({ force: true, reason: 'GUI force recovery' })
    expect(createLifecycle).toHaveBeenCalledWith(baseConfig, launch)
    expect(replacement.adopt).toHaveBeenCalledWith(launch)
    expect(replacement.restart).toHaveBeenCalledOnce()
    expect(h.lifecycle.dispose).toHaveBeenCalledOnce()
    expect(h.statuses).toEqual(expect.arrayContaining([
      'failed', 'starting', 'watching', 'pending-restart', 'restarting', 'recovering', 'watching',
    ]))
    expect(h.supervisor.status.phase).toBe('watching')
  })

  it('rebuilds through a reset lifecycle after circuit-open and stays failed without the seam', async () => {
    const replacement = lifecycleStub()
    const recoverable = harness({
      gateOpen: false,
      unexpectedExitResult: 'circuit-open',
      createLifecycle: vi.fn(() => replacement),
    })
    await recoverable.supervisor.start(launch)
    await recoverable.supervisor.observeUnexpectedExit(launch.pid)
    await recoverable.supervisor.rebuild()
    expect(replacement.restart).toHaveBeenCalledOnce()
    expect(recoverable.runner.run).toHaveBeenCalledOnce()
    expect(recoverable.supervisor.status.phase).toBe('watching')

    const bounded = harness({ unexpectedExitResult: 'circuit-open' })
    await bounded.supervisor.start(launch)
    await bounded.supervisor.observeUnexpectedExit(launch.pid)
    await expect(bounded.supervisor.requestRestart({ force: true, reason: 'GUI force recovery' }))
      .rejects.toThrow(/lifecycle replacement.*failed state/i)
    expect(bounded.supervisor.status.phase).toBe('failed')
    expect(bounded.lifecycle.restart).not.toHaveBeenCalled()
  })

  it('keeps the serialized tail free while host disposal is pending so a restart still proceeds', async () => {
    const disposing = deferred<Awaited<ReturnType<HostLifecycle['observeHostDisposing']>>>()
    const h = harness({ observeHostDisposing: () => disposing.promise })
    await h.supervisor.start(launch)

    const disposal = h.supervisor.handleBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid,
    })
    await vi.waitFor(() => expect(h.lifecycle.observeHostDisposing).toHaveBeenCalledOnce())

    const restart = h.supervisor.requestRestart({ force: true, reason: 'during grace' })
    await vi.waitFor(() => expect(h.lifecycle.restart).toHaveBeenCalled())
    expect(h.lifecycle.observeHostDisposing).toHaveBeenCalledOnce()

    disposing.resolve('reconnected')
    await Promise.all([disposal, restart])
  })

  it('defers watcher degradation during a restart and applies it after recovery', async () => {
    const restarting = deferred<Awaited<ReturnType<HostLifecycle['restart']>>>()
    const h = harness({ restart: () => restarting.promise })
    await h.supervisor.start(launch)
    const restart = h.supervisor.requestRestart({ force: true, reason: 'manual' })
    await vi.waitFor(() => expect(h.lifecycle.restart).toHaveBeenCalledOnce())
    expect(h.supervisor.status.phase).toBe('restarting')

    h.getWatcherOptions().onError(new Error('watch exploded'))
    expect(h.supervisor.status.phase).toBe('restarting')

    restarting.resolve({
      host: { pid: 42, bootId: 'new-boot', launch: { ...launch, pid: 42, bootId: 'new-boot' }, source: 'spawned' },
      health: { healthy: true, httpReady: true, bridgeReady: true, expectedBootId: 'new-boot', observedBootId: 'new-boot' },
    })
    await restart
    expect(h.supervisor.status).toMatchObject({ phase: 'degraded', error: 'watch exploded' })
  })

  it('ignores a duplicate unexpected-exit report once the crash circuit has opened', async () => {
    const h = harness({ unexpectedExitResult: 'circuit-open' })
    await h.supervisor.start(launch)
    await h.supervisor.observeUnexpectedExit(launch.pid)
    expect(h.supervisor.status.phase).toBe('failed')

    await expect(h.supervisor.observeUnexpectedExit(launch.pid)).resolves.toBeUndefined()
    expect(h.lifecycle.observeUnexpectedExit).toHaveBeenCalledOnce()
  })

  it('landing a failed restart still transitions to degraded instead of stranding', async () => {
    const h = harness({
      restart: async () => { throw new Error('restart failed') },
    })
    await h.supervisor.start(launch)
    await expect(h.supervisor.requestRestart({ force: true, reason: 'manual' }))
      .rejects.toThrow('restart failed')
    expect(h.supervisor.status.phase).toBe('degraded')
  })

  it('commits a debounce scheduler swap and only degrades when closing the old scheduler fails', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    vi.mocked(h.scheduler.close).mockRejectedValueOnce(new Error('old scheduler close failed'))
    const updated = { ...baseConfig, debounceMs: 5 }

    await expect(h.supervisor.updateConfig(updated)).resolves.toBeUndefined()

    expect(h.supervisor.status).toMatchObject({
      phase: 'degraded',
      error: 'old scheduler close failed',
    })
    expect(h.getSchedulerOptionsAt(1).debounceMs).toBe(5)
  })

  it('releases the handoff freeze so a committed handoff can cleanly stop', async () => {
    const h = harness()
    await h.supervisor.start(launch)
    const { lead, follow } = handoffDuplex()
    const lock = {
      transferOwnership: vi.fn(async () => undefined),
      reacquire: vi.fn(async () => true),
    }
    const handoff = h.supervisor.handoff(lead, lock, { id: 'txn-cleanup' })
    const follower = createHandoffFollow({
      acceptSnapshot: vi.fn(async () => undefined),
      acquireOwnership: vi.fn(async () => undefined),
      releaseOwnership: vi.fn(async () => undefined),
      beginServing: vi.fn(async () => undefined),
      verifyStillOwner: vi.fn(async () => true),
    }, follow)
    const followRun = follower.start()

    await handoff.prepare()
    await handoff.freeze()
    await handoff.commit()
    await followRun

    // The old supervisor must still run full teardown after a successful commit.
    await h.supervisor.stop()
    expect(h.lifecycle.dispose).toHaveBeenCalled()
    expect(h.watcher.close).toHaveBeenCalled()
    expect(h.scheduler.close).toHaveBeenCalled()
    expect(h.runner.stopAll).toHaveBeenCalled()
  })
})

/** In-memory duplex handoff channel pair (mirrors tests/unit/handoff.test.ts). */
function handoffDuplex(): { lead: HandoffChannel; follow: HandoffChannel } {
  let leadListener: ((message: HandoffMessage) => Promise<void>) | undefined
  let followListener: ((message: HandoffMessage) => Promise<void>) | undefined
  const deliver = (
    listener: ((message: HandoffMessage) => Promise<void>) | undefined,
    message: HandoffMessage,
  ): Promise<void> => new Promise<void>(resolve => {
    setImmediate(() => {
      if (listener !== undefined) void Promise.resolve(listener(message)).then(() => resolve(), () => resolve())
      else resolve()
    })
  })
  const lead: HandoffChannel = {
    async send(message) { await deliver(followListener, message) },
    onMessage(listener) {
      leadListener = listener
      return () => { if (leadListener === listener) leadListener = undefined }
    },
  }
  const follow: HandoffChannel = {
    async send(message) { await deliver(leadListener, message) },
    onMessage(listener) {
      followListener = listener
      return () => { if (followListener === listener) followListener = undefined }
    },
  }
  return { lead, follow }
}
