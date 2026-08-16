import { randomUUID } from 'node:crypto'

import type { SupervisorConfig } from '../shared/config.js'
import {
  PROTOCOL_VERSION,
  type BridgeEvent,
  type HostLaunchSpec,
  type PublicSupervisorStatus,
  type SupervisorPhase,
} from '../shared/protocol.js'
import {
  createSupervisorState,
  toPublicStatus,
  transitionSupervisorState,
  type SupervisorState,
  type SupervisorStateEvent,
} from '../shared/state.js'
import {
  createHandoffLead,
  type HandoffChannel,
  type HandoffLeadHooks,
  type HandoffSnapshot,
  type SupervisorHandoff,
} from './handoff.js'
import type { ChangeAction, ChangePlan } from './classifier.js'
import type { DiscoveryResult } from './discovery.js'
import type { AdoptedHost, HostLifecycle } from './lifecycle.js'
import type { CommandRunner } from './runner.js'
import type {
  BuildCycleResult,
  ChangeScheduler,
  ChangeSchedulerOptions,
} from './scheduler.js'
import type { TaskGate } from './task-gate.js'
import type {
  CreateWatchPlanControllerOptions,
  WatchPlanController,
} from './watcher.js'

export interface CreateSupervisorOptions {
  readonly config: SupervisorConfig
  readonly discover: (
    config: SupervisorConfig,
    launch: HostLaunchSpec,
  ) => Promise<DiscoveryResult>
  readonly createWatcher: (options: CreateWatchPlanControllerOptions) => WatchPlanController
  readonly createScheduler: (options: ChangeSchedulerOptions) => ChangeScheduler
  readonly runner: CommandRunner
  readonly gate: TaskGate
  readonly lifecycle: HostLifecycle
  readonly createLifecycle?: (config: SupervisorConfig, launch: HostLaunchSpec) => HostLifecycle
  readonly createBootId: () => string
  readonly publishStatus?: (status: PublicSupervisorStatus) => void | Promise<void>
  readonly now?: () => number
}

export interface RestartCommand {
  readonly force: boolean
  readonly reason: string
}

/** Lock-side hooks the CLI supplies so the supervisor can hand off its lock. */
export interface HandoffLockHooks {
  /** Atomically release the old supervisor's lock lease so a new owner can acquire it. */
  readonly transferOwnership: () => void | Promise<void>
  /**
   * Re-acquire the endpoint lease after a handoff aborts past the transfer point.
   * Returns `false` when the standby still holds the lease (so the old supervisor
   * fails closed rather than resuming service without ownership).
   */
  readonly reacquire: () => Promise<boolean>
}

export interface DevReloaderSupervisor {
  readonly status: PublicSupervisorStatus
  start(launch: HostLaunchSpec): Promise<void>
  bridgeConnected(launch: HostLaunchSpec): Promise<void>
  /**
   * Synchronous bridge-generation admission: when the connecting bridge belongs
   * to a different host generation (pid or boot id), reset the activity gate so
   * the new generation's sequence baseline starts fresh. Must run before the
   * bridge handshake completes so the new bridge's first activity snapshot is
   * never rejected against a stale baseline, and never blocks on the mutation
   * tail (a long-running restart must not stall bridge authentication).
   */
  prepareBridge(launch: HostLaunchSpec): void
  observeUnexpectedExit(hostPid: number): Promise<void>
  handleBridgeEvent(event: BridgeEvent): Promise<void>
  requestRestart(command: RestartCommand): Promise<void>
  updateConfig(config: SupervisorConfig): Promise<void>
  rebuild(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  close(): Promise<void>
  /** Expose the handoff state-machine seams (prepare/commit/abort/freeze) over a channel. */
  handoff(
    channel: HandoffChannel,
    lock: HandoffLockHooks,
    transaction?: { readonly id: string; readonly generation: number },
  ): SupervisorHandoff
}

type SupervisorStateEventWithoutTime = SupervisorStateEvent extends infer Event
  ? Event extends { readonly at: number }
    ? Omit<Event, 'at'>
    : never
  : never

interface RestartTransaction {
  force: boolean
  readonly reason: string
  readonly gateController: AbortController
  readonly lifecycleController: AbortController
  promise: Promise<void>
}

interface HmrWaiter {
  readonly entries: Set<string>
  readonly resolve: () => void
  readonly promise: Promise<void>
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

interface AdapterSet {
  readonly watcher: WatchPlanController
  scheduler: ChangeScheduler
  closed: boolean
}

interface CycleRecord {
  readonly epoch: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildError(stderr: string, stdout: string, exitCode: number | null): string {
  const detail = stderr.trim() || stdout.trim()
  return detail || `command exited with code ${String(exitCode)}`
}

function actionProjects(plan: ChangePlan): string[] {
  return [...new Set(plan.actions.map(action => action.projectId))].sort()
}

function isCommandAction(
  action: ChangeAction,
): action is Extract<ChangeAction, { kind: 'dependency-install' | 'build' }> {
  return action.kind === 'dependency-install' || action.kind === 'build'
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function lifecyclePolicyChanged(current: SupervisorConfig, next: SupervisorConfig): boolean {
  return current.healthTimeoutMs !== next.healthTimeoutMs
    || current.shutdownGraceMs !== next.shutdownGraceMs
    || current.bridgeGraceMs !== next.bridgeGraceMs
    || current.crashWindowMs !== next.crashWindowMs
    || current.maxCrashRestarts !== next.maxCrashRestarts
}

/** Coordinate already-separated discovery, watch, build, gate, and host-lifecycle adapters. */
export function createSupervisor(options: CreateSupervisorOptions): DevReloaderSupervisor {
  const now = options.now ?? Date.now
  let config = options.config
  let state: SupervisorState = createSupervisorState(now())
  let adapters: AdapterSet | undefined
  let discovery: DiscoveryResult | undefined
  let lifecycle = options.lifecycle
  let host: AdoptedHost | undefined
  let launch: HostLaunchSpec | undefined
  let startPromise: Promise<void> | undefined
  let pausePromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let rebuildPromise: Promise<void> | undefined
  let stopped = false
  let pauseRequested = false
  let lifecycleDisposed = false
  let handoffFrozen = false
  let handoffCounter = 0
  let restartTransaction: RestartTransaction | undefined
  let recoveryController: AbortController | undefined
  let hmrWaiter: HmrWaiter | undefined
  let mutationTail: Promise<void> = Promise.resolve()
  let operationEpoch = 0
  const readyCycles: CycleRecord[] = []
  let deferredDegrade: string | undefined
  let lastUnexpectedExitPid: number | undefined

  const publish = (): void => {
    void Promise.resolve(options.publishStatus?.(toPublicStatus(state))).catch(() => undefined)
  }

  const transition = (event: SupervisorStateEventWithoutTime): void => {
    state = transitionSupervisorState(state, { ...event, at: now() } as SupervisorStateEvent)
    publish()
  }

  const fail = (error: unknown): void => {
    state = transitionSupervisorState(state, { type: 'fail', at: now(), error: message(error) })
    publish()
  }

  const degrade = (error: unknown): void => {
    if (
      stopped
      || pauseRequested
      || state.phase === 'failed'
      || state.phase === 'paused'
    ) return
    if (state.phase === 'restarting' || state.phase === 'recovering') {
      deferredDegrade = message(error)
      return
    }
    transition({ type: 'degrade', error: message(error) })
  }

  const drainDeferredDegrade = (): void => {
    const deferred = deferredDegrade
    deferredDegrade = undefined
    if (deferred === undefined) return
    if (stopped || pauseRequested || state.phase === 'failed' || state.phase === 'paused') return
    transition({ type: 'degrade', error: deferred })
  }

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    if (handoffFrozen) return Promise.resolve(undefined as T)
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const runBuildsInternal = async (
    plan: ChangePlan,
    signal: AbortSignal,
  ): Promise<BuildCycleResult> => {
    if (stopped || pauseRequested) {
      return { kind: 'build-failed', error: 'supervisor is not active' }
    }
    const cycle = { epoch: operationEpoch }
    transition({ type: 'build-started', projects: actionProjects(plan) })

    for (const action of plan.actions) {
      if (!isCommandAction(action)) continue
      const finishTask = options.gate.beginLocalTask(`${action.kind}:${action.projectId}`)
      try {
        const result = await options.runner.run(action.command, signal)
        if (result.exitCode !== 0) {
          const error = buildError(result.stderr, result.stdout, result.exitCode)
          transition({ type: 'build-failed', error })
          return { kind: 'build-failed', error }
        }
      } catch (error) {
        if (isAbortError(error)) throw error
        const detail = message(error)
        transition({ type: 'build-failed', error: detail })
        return { kind: 'build-failed', error: detail }
      } finally {
        finishTask()
      }
    }
    readyCycles.push(cycle)
    return { kind: 'success' }
  }

  const settleHmr = (): void => {
    const waiter = hmrWaiter
    if (waiter === undefined || waiter.settled) return
    waiter.settled = true
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    hmrWaiter = undefined
    if (!stopped && !pauseRequested && state.phase === 'hmr-wait') {
      transition({ type: 'hmr-complete' })
    }
    waiter.resolve()
  }

  const cancelHmr = (): void => {
    const waiter = hmrWaiter
    if (waiter === undefined || waiter.settled) return
    waiter.settled = true
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    hmrWaiter = undefined
    waiter.resolve()
  }

  const setupServerHmr = (plan: ChangePlan): Promise<void> => {
    const entries = new Set(
      plan.actions
        .filter((action): action is Extract<ChangeAction, { kind: 'server-hmr' }> =>
          action.kind === 'server-hmr')
        .map(action => action.path),
    )
    if (entries.size === 0) {
      transition({ type: 'build-succeeded' })
      return Promise.resolve()
    }

    transition({ type: 'hmr-wait' })
    let resolve!: () => void
    const promise = new Promise<void>(value => { resolve = value })
    const waiter: HmrWaiter = {
      entries,
      resolve,
      promise,
      timer: undefined,
      settled: false,
    }
    hmrWaiter = waiter
    waiter.timer = setTimeout(() => {
      if (waiter.settled || hmrWaiter !== waiter) return
      waiter.settled = true
      hmrWaiter = undefined
      void requestRestart({ force: false, reason: 'server HMR acknowledgement timed out' })
        .then(resolve, error => {
          degrade(error)
          resolve()
        })
    }, config.bridgeGraceMs)
    waiter.timer.unref?.()
    return promise
  }

  const takeCurrentCycle = (): boolean => readyCycles.shift()?.epoch === operationEpoch

  const onReady = async (plan: ChangePlan): Promise<void> => {
    if (plan.impact === 'full-restart') {
      const current = await serialize(async () =>
        !stopped && !pauseRequested && takeCurrentCycle())
      if (current) {
        await requestRestart({ force: false, reason: 'source change requires host restart' })
      }
      return
    }

    if (plan.impact === 'server-hmr') {
      let wait: Promise<void> | undefined
      await serialize(async () => {
        if (!stopped && !pauseRequested && takeCurrentCycle()) {
          wait = setupServerHmr(plan)
        }
      })
      await wait
      return
    }

    await serialize(async () => {
      if (stopped || pauseRequested || !takeCurrentCycle()) return
      if (plan.impact === 'client-hmr') {
        try {
          for (const action of plan.actions) {
            if (action.kind === 'client-watch') {
              await options.runner.ensurePersistent(
                `client-watch:${action.projectId}`,
                action.command,
              )
            }
          }
          transition({ type: 'build-succeeded' })
        } catch (error) {
          degrade(error)
        }
        return
      }
      transition({ type: 'build-succeeded' })
    })
  }

  const createAdapterSet = async (): Promise<AdapterSet> => {
    let set!: AdapterSet
    const scheduler = options.createScheduler({
      debounceMs: config.debounceMs,
      runBuilds: (plan, signal) => serialize(() => runBuildsInternal(plan, signal)),
      onReady,
    })
    try {
      const watcher = options.createWatcher({
        onEvent: event => set.scheduler.enqueue(event),
        onError: degrade,
        onDegradedRoot: degraded => degrade(degraded.error),
      })
      set = { watcher, scheduler, closed: false }
      return set
    } catch (error) {
      try {
        await scheduler.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'adapter construction and cleanup failed')
      }
      throw error
    }
  }

  const closeAdapterSet = async (set: AdapterSet | undefined): Promise<void> => {
    readyCycles.length = 0
    if (set === undefined || set.closed) return
    set.closed = true
    cancelHmr()
    const results = await Promise.allSettled([
      set.watcher.close(),
      set.scheduler.close(),
      options.runner.stopAll(),
    ])
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length > 0) {
      throw new AggregateError(failures.map(result => result.reason), 'failed to close supervisor adapters')
    }
  }

  const watchHostChild = (next: AdoptedHost): void => {
    next.child?.once('exit', () => {
      void supervisor.observeUnexpectedExit(next.pid).catch(degrade)
    })
  }

  const prepareLifecycleReplacement = async (
    nextConfig: SupervisorConfig,
    currentLaunch: HostLaunchSpec,
    unavailableMessage: string,
  ): Promise<{ lifecycle: HostLifecycle; host: AdoptedHost }> => {
    const createLifecycle = options.createLifecycle
    if (createLifecycle === undefined) throw new Error(unavailableMessage)
    let candidate: HostLifecycle | undefined
    try {
      candidate = createLifecycle(nextConfig, currentLaunch)
      return { lifecycle: candidate, host: await candidate.adopt(currentLaunch) }
    } catch (error) {
      if (candidate === undefined) throw error
      try {
        await candidate.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'lifecycle replacement and cleanup failed')
      }
      throw error
    }
  }

  const resetFailedLifecycle = async (): Promise<void> => {
    if (state.phase !== 'failed') return
    const currentLaunch = launch
    if (currentLaunch === undefined) throw new Error('cannot recover failed supervisor before adopting a host')
    const replacement = await prepareLifecycleReplacement(
      config,
      currentLaunch,
      'lifecycle replacement factory is required to recover from failed state',
    )
    const previous = lifecycle
    lifecycle = replacement.lifecycle
    host = replacement.host
    await previous.dispose()
    transition({ type: 'resume' })
    transition({ type: 'watch-ready' })
  }

  const executeRestart = async (transaction: RestartTransaction): Promise<void> => {
    try {
      if (
        stopped
        || pauseRequested
        || transaction.lifecycleController.signal.aborted
        || (!transaction.force && transaction.gateController.signal.aborted)
      ) throw abortError()
      if (state.phase === 'failed') {
        if (!transaction.force) throw new Error('force restart is required to recover from failed state')
        await resetFailedLifecycle()
      }
      transition({ type: 'restart-pending', reason: transaction.reason })
      if (!transaction.force) {
        try {
          await options.gate.waitUntilOpen(transaction.gateController.signal)
        } catch (error) {
          if (!transaction.force || !isAbortError(error)) throw error
        }
      }
      if (stopped || pauseRequested || transaction.lifecycleController.signal.aborted) {
        throw abortError()
      }
      transition({ type: 'restart-ready' })
      const current = host
      if (current === undefined) throw new Error('cannot restart before adopting a host')
      const expectedBootId = options.createBootId()
      const result = await lifecycle.restart({
        host: current,
        expectedBootId,
        signal: transaction.lifecycleController.signal,
      })
      if (stopped || pauseRequested || transaction.lifecycleController.signal.aborted) throw abortError()
      host = result.host
      launch = result.host.launch
      watchHostChild(result.host)
      transition({ type: 'host-started', bootId: result.host.bootId })
      transition({ type: 'recovered' })
      drainDeferredDegrade()
    } catch (error) {
      if (!stopped && !pauseRequested && !isAbortError(error)) {
        const phase = state.phase as SupervisorPhase
        if (phase === 'restarting' || phase === 'recovering') {
          transition({ type: 'degrade', error: message(error) })
        } else {
          degrade(error)
        }
      }
      throw error
    } finally {
      if (restartTransaction === transaction) restartTransaction = undefined
    }
  }

  function requestRestart(command: RestartCommand): Promise<void> {
    if (stopped) return Promise.reject(new Error('supervisor is stopped'))
    if (pauseRequested) return Promise.reject(new Error('supervisor is paused'))
    const existing = restartTransaction
    if (existing !== undefined) {
      if (command.force && !existing.force) {
        existing.force = true
        existing.gateController.abort()
      }
      return existing.promise
    }

    operationEpoch += 1
    const transaction: RestartTransaction = {
      force: command.force,
      reason: command.reason,
      gateController: new AbortController(),
      lifecycleController: new AbortController(),
      promise: Promise.resolve(),
    }
    restartTransaction = transaction
    transaction.promise = serialize(() => executeRestart(transaction))
    return transaction.promise
  }

  const closeLifecycle = async (): Promise<void> => {
    if (lifecycleDisposed) return
    lifecycleDisposed = true
    await lifecycle.dispose()
  }

  const stopInternal = async (): Promise<void> => {
    if (state.phase !== 'failed' && state.phase !== 'paused') transition({ type: 'pause' })
    const currentAdapters = adapters
    adapters = undefined
    await closeAdapterSet(currentAdapters)
    await closeLifecycle()
  }

  const startOnce = async (nextLaunch: HostLaunchSpec): Promise<void> => {
    if (stopped) throw new Error('supervisor is stopped')
    if (pauseRequested) throw new Error('supervisor is paused')
    if (state.phase === 'failed') transition({ type: 'resume' })
    let candidate: AdapterSet | undefined
    try {
      candidate = await createAdapterSet()
      const nextDiscovery = await options.discover(config, nextLaunch)
      const status = await candidate.watcher.replace({
        projects: nextDiscovery.projects,
        ignored: config.ignored,
      })
      if (!status.promoted) throw new Error('no watch roots could be promoted')
      const adopted = await lifecycle.adopt(nextLaunch)
      options.gate.bridgeReplaced()
      adapters = candidate
      discovery = nextDiscovery
      host = adopted
      launch = nextLaunch
      watchHostChild(adopted)
      transition({ type: 'watch-ready' })
    } catch (error) {
      try {
        await closeAdapterSet(candidate)
      } catch (cleanupError) {
        const aggregate = new AggregateError([error, cleanupError], 'startup and cleanup failed')
        fail(aggregate)
        throw aggregate
      }
      fail(error)
      throw error
    }
  }

  const supervisor: DevReloaderSupervisor = {
    get status() {
      return toPublicStatus(state)
    },

    start(nextLaunch) {
      if (stopped) return Promise.reject(new Error('supervisor is stopped'))
      if (pauseRequested) return Promise.reject(new Error('supervisor is paused'))
      if (startPromise !== undefined) return startPromise
      if (adapters !== undefined && host !== undefined) return Promise.resolve()
      const operation = serialize(() => startOnce(nextLaunch))
      startPromise = operation.finally(() => {
        if (startPromise === wrapped) startPromise = undefined
      })
      const wrapped = startPromise
      return wrapped
    },

    prepareBridge(nextLaunch) {
      // Synchronous generation admission: reset the activity gate only when the
      // connecting bridge represents a different host generation. Runs during
      // the handshake (before auth-ok), never on the mutation tail, so a busy
      // supervisor (e.g. mid-restart) cannot stall bridge authentication.
      const current = host
      if (current !== undefined && (current.pid !== nextLaunch.pid || current.bootId !== nextLaunch.bootId)) {
        options.gate.bridgeReplaced()
      }
    },

    async bridgeConnected(nextLaunch) {
      // A frozen supervisor must not mutate lifecycle state mid-handoff, so the
      // quick observe call is also deferable until the freeze lifts.
      if (handoffFrozen) return
      const current = host
      if (current !== undefined && current.pid === nextLaunch.pid) {
        lifecycle.observeBridgeConnected(current)
      }
      await serialize(async () => {
        if (stopped || pauseRequested) return
        if (host === undefined) {
          await startOnce(nextLaunch)
          return
        }
        if (host.pid !== nextLaunch.pid || host.bootId !== nextLaunch.bootId) {
          host = await lifecycle.adopt(nextLaunch)
          launch = nextLaunch
        }
        lifecycle.observeBridgeConnected(host)
        if (state.phase === 'restarting') {
          transition({ type: 'host-started', bootId: nextLaunch.bootId })
          transition({ type: 'recovered' })
          drainDeferredDegrade()
        }
      })
    },

    observeUnexpectedExit(hostPid) {
      return serialize(async () => {
        if (stopped || pauseRequested) return
        const current = host
        if (current === undefined || current.pid !== hostPid) return
        if (lastUnexpectedExitPid === hostPid) return
        lastUnexpectedExitPid = hostPid
        if (restartTransaction !== undefined || state.phase === 'restarting' || state.phase === 'recovering') return
        operationEpoch += 1
        transition({ type: 'restart-pending', reason: 'host exited unexpectedly' })
        transition({ type: 'restart-ready' })
        const controller = new AbortController()
        recoveryController = controller
        try {
          const result = await lifecycle.observeUnexpectedExit(current, controller.signal)
          if (result === 'circuit-open') {
            fail(new Error('host crash restart circuit opened'))
          }
        } catch (error) {
          if (pauseRequested && isAbortError(error)) return
          const phase = state.phase as SupervisorPhase
          if (phase === 'restarting' || phase === 'recovering') {
            transition({ type: 'degrade', error: message(error) })
          } else {
            degrade(error)
          }
          throw error
        } finally {
          if (recoveryController === controller) recoveryController = undefined
        }
      })
    },

    async handleBridgeEvent(event) {
      if (stopped) return
      if (event.type === 'activity') {
        options.gate.updateActivity(event.snapshot)
        return
      }
      if (event.type === 'host-disposing') {
        const current = host
        if (current === undefined || current.pid !== event.hostPid) return
        // A frozen supervisor is mid-handoff: it must not dispose lifecycle or
        // close adapters. Defer the stop decision until the freeze lifts.
        if (handoffFrozen) return
        options.gate.bridgeDisconnected()
        if (restartTransaction !== undefined) return
        const result = await lifecycle.observeHostDisposing(current)
        let shouldStop = false
        await serialize(async () => {
          if (stopped || pauseRequested || restartTransaction !== undefined) return
          if (host !== current) return
          if (result === 'stopped' || result === 'bridge-timeout') shouldStop = true
        })
        if (shouldStop) {
          stopped = true
          pauseRequested = true
          await stopInternal()
        }
        return
      }
      if (event.type === 'hmr-reload') {
        await serialize(async () => {
          const waiter = hmrWaiter
          if (waiter === undefined || waiter.settled) return
          for (const entry of event.entries) waiter.entries.delete(entry)
          if (waiter.entries.size === 0) settleHmr()
        })
      }
    },

    requestRestart,

    updateConfig(nextConfig) {
      if (stopped) return Promise.reject(new Error('supervisor is stopped'))
      if (nextConfig.profile !== config.profile) {
        return Promise.reject(new Error('supervisor profile is fixed for the CLI runtime'))
      }
      const replaceLifecycle = lifecyclePolicyChanged(config, nextConfig)
      if (replaceLifecycle && options.createLifecycle === undefined) {
        return Promise.reject(new Error('lifecycle replacement factory is required for lifecycle policy updates'))
      }
      if (pauseRequested) {
        return serialize(async () => {
          const currentLaunch = launch
          if (currentLaunch === undefined) throw new Error('supervisor has not started')
          const previousConfig = config
          const previousLifecycle = lifecycle
          const previousHost = host
          const replacement = replaceLifecycle
            ? await prepareLifecycleReplacement(
                nextConfig,
                currentLaunch,
                'lifecycle replacement factory is required for lifecycle policy updates',
              )
            : undefined
          try {
            config = nextConfig
            if (replacement !== undefined) {
              lifecycle = replacement.lifecycle
              host = replacement.host
            }
            pauseRequested = false
            pausePromise = undefined
            transition({ type: 'resume' })
            await startOnce(currentLaunch)
          } catch (error) {
            config = previousConfig
            lifecycle = previousLifecycle
            host = previousHost
            pauseRequested = true
            if (replacement !== undefined) await replacement.lifecycle.dispose()
            throw error
          }
          if (replacement !== undefined) {
            try {
              await previousLifecycle.dispose()
            } catch (cleanupError) {
              degrade(cleanupError)
            }
          }
        })
      }
      operationEpoch += 1
      let schedulerToClose: ChangeScheduler | undefined
      const update = serialize(async () => {
        let replacement: { lifecycle: HostLifecycle; host: AdoptedHost } | undefined
        let replacementScheduler: ChangeScheduler | undefined
        let currentAdapters!: AdapterSet
        let nextDiscovery!: DiscoveryResult
        try {
          const currentLaunch = launch
          const activeAdapters = adapters
          if (currentLaunch === undefined || activeAdapters === undefined) {
            throw new Error('supervisor has not started')
          }
          currentAdapters = activeAdapters
          if (replaceLifecycle) {
            replacement = await prepareLifecycleReplacement(
              nextConfig,
              currentLaunch,
              'lifecycle replacement factory is required for lifecycle policy updates',
            )
          }
          nextDiscovery = await options.discover(nextConfig, currentLaunch)
          if (nextConfig.debounceMs !== config.debounceMs) {
            replacementScheduler = options.createScheduler({
              debounceMs: nextConfig.debounceMs,
              runBuilds: (plan, signal) => serialize(() => runBuildsInternal(plan, signal)),
              onReady,
            })
          }
          const status = await currentAdapters.watcher.replace({
            projects: nextDiscovery.projects,
            ignored: nextConfig.ignored,
          })
          if (!status.promoted) {
            throw new Error('updated watch plan could not be promoted')
          }
        } catch (error) {
          const cleanupErrors: unknown[] = []
          if (replacementScheduler !== undefined) {
            try {
              await replacementScheduler.close()
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          }
          if (replacement !== undefined) {
            try {
              await replacement.lifecycle.dispose()
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          }
          const failure = cleanupErrors.length === 0
            ? error
            : new AggregateError([error, ...cleanupErrors], 'config replacement and cleanup failed')
          degrade(failure)
          throw failure
        }

        const previousLifecycle = lifecycle
        if (replacement !== undefined) {
          lifecycle = replacement.lifecycle
          host = replacement.host
        }
        if (replacementScheduler !== undefined) {
          schedulerToClose = currentAdapters.scheduler
          readyCycles.length = 0
          currentAdapters.scheduler = replacementScheduler
        }
        config = nextConfig
        discovery = nextDiscovery
        if (state.phase === 'degraded') transition({ type: 'watch-ready' })
        if (replacement !== undefined) {
          try {
            await previousLifecycle.dispose()
          } catch (cleanupError) {
            degrade(cleanupError)
          }
        }
      })
      return update.then(async () => {
        if (schedulerToClose === undefined) return
        try {
          await schedulerToClose.close()
        } catch (cleanupError) {
          degrade(cleanupError)
        }
      })
    },

    rebuild() {
      if (stopped) return Promise.reject(new Error('supervisor is stopped'))
      if (pauseRequested) return Promise.reject(new Error('supervisor is paused'))
      if (rebuildPromise !== undefined) return rebuildPromise
      if (restartTransaction !== undefined) return Promise.reject(new Error('restart already in progress'))
      operationEpoch += 1
      const recoveringFailedState = state.phase === 'failed'
      const transaction: RestartTransaction = {
        force: recoveringFailedState,
        reason: 'manual rebuild completed',
        gateController: new AbortController(),
        lifecycleController: new AbortController(),
        promise: Promise.resolve(),
      }
      restartTransaction = transaction
      const operation = serialize(async () => {
        if (transaction.lifecycleController.signal.aborted) throw abortError()
        await resetFailedLifecycle()
        const projects = discovery?.projects
        if (projects === undefined) throw new Error('supervisor has not started')
        const actions: ChangeAction[] = projects.flatMap(item => item.build === undefined ? [] : [{
          kind: 'build' as const,
          impact: 'full-restart' as const,
          projectId: item.id,
          command: item.build,
        }])
        const rebuildPlan: ChangePlan = { impact: 'full-restart', actions }
        const result = await runBuildsInternal(rebuildPlan, transaction.lifecycleController.signal)
        if (result.kind === 'build-failed') throw new Error(result.error)
        readyCycles.shift()
        await executeRestart(transaction)
      })
      const wrapped = operation.finally(() => {
        if (restartTransaction === transaction) restartTransaction = undefined
        if (rebuildPromise === wrapped) rebuildPromise = undefined
      })
      transaction.promise = wrapped
      rebuildPromise = wrapped
      return wrapped
    },

    pause() {
      if (stopped) return stopPromise ?? Promise.resolve()
      if (pausePromise !== undefined) return pausePromise
      pauseRequested = true
      operationEpoch += 1
      restartTransaction?.gateController.abort()
      restartTransaction?.lifecycleController.abort()
      recoveryController?.abort()
      const operation = serialize(async () => {
        if (state.phase !== 'failed' && state.phase !== 'paused') transition({ type: 'pause' })
        const current = adapters
        adapters = undefined
        await closeAdapterSet(current)
      })
      pausePromise = operation
      return operation
    },

    stop() {
      if (stopPromise !== undefined) return stopPromise
      stopped = true
      pauseRequested = true
      // The process is exiting: a handoff freeze (or a fail-closed abort) must
      // not prevent full teardown, otherwise watchers/scheduler/lifecycle and
      // persistent children are never cleaned up.
      handoffFrozen = false
      operationEpoch += 1
      restartTransaction?.gateController.abort()
      restartTransaction?.lifecycleController.abort()
      recoveryController?.abort()
      stopPromise = serialize(stopInternal)
      return stopPromise
    },

    close() {
      return this.stop()
    },

    handoff(channel, lock, transaction) {
      handoffCounter += 1
      const transactionId = transaction?.id ?? randomUUID()
      const generation = handoffCounter
      // True once the old lease was transferred (released) at freeze. If the
      // handoff later aborts, the lease must be re-acquired before the old
      // supervisor may resume serving without ownership.
      let leaseReleased = false
      const hooks: HandoffLeadHooks = {
        readyToPrepare: async () => (
          !stopped
          && !pauseRequested
          && state.phase === 'watching'
          && !handoffFrozen
        ),
        createSnapshot: async () => {
          if (stopped || pauseRequested || state.phase !== 'watching') {
            throw new Error('supervisor is not watching and cannot produce a handoff snapshot')
          }
          if (launch === undefined) {
            throw new Error('supervisor snapshot is unreadable: no active launch')
          }
          return {
            protocolVersion: PROTOCOL_VERSION,
            transactionId,
            generation,
            launch,
            config,
          }
        },
        freezeMutations: async () => {
          // Freeze the old supervisor by stopping new serialized mutations; the
          // adapters and lifecycle are left intact so an abort can resume fully.
          handoffFrozen = true
        },
        transferOwnership: async () => {
          await lock.transferOwnership()
          leaseReleased = true
        },
        resume: async () => {
          if (!leaseReleased) {
            // The lease was never transferred; unfreeze and keep serving.
            handoffFrozen = false
            return
          }
          leaseReleased = false
          const reacquired = await Promise.resolve(lock.reacquire()).catch(() => false)
          if (reacquired) {
            handoffFrozen = false
            return
          }
          // The standby still holds the lease: fail closed rather than resume
          // serving without ownership. Never dispose lifecycle during a freeze.
          fail(new Error('supervisor lost endpoint ownership and could not re-acquire the lock lease'))
        },
      }
      return createHandoffLead(hooks, channel).handoff
    },
  }

  return supervisor
}
