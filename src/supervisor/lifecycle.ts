import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

import type { HostLaunchSpec } from '../shared/protocol.js'
import {
  waitForHostHealth,
  type HealthCheckRequest,
  type HealthObservation,
} from './health-check.js'

export interface AdoptedHost {
  readonly pid: number
  readonly bootId: string
  readonly launch: HostLaunchSpec
  readonly source: 'adopted' | 'spawned'
  readonly child?: ChildProcess
}

export interface RestartRequest {
  readonly host: AdoptedHost
  readonly expectedBootId: string
  readonly signal?: AbortSignal
}

export interface RestartResult {
  readonly host: AdoptedHost
  readonly health: HealthObservation
}

export interface HostLifecycle {
  adopt(launch: HostLaunchSpec): Promise<AdoptedHost>
  restart(request: RestartRequest): Promise<RestartResult>
  observeUnexpectedExit(host: AdoptedHost, signal?: AbortSignal): Promise<'restarted' | 'circuit-open'>
  observeHostDisposing(host: AdoptedHost, signal?: AbortSignal): Promise<'stopped' | 'reconnected' | 'bridge-timeout'>
  observeBridgeConnected(host: AdoptedHost): void
  dispose(): Promise<void>
}

export type HostSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface HostLifecycleOptions {
  readonly shutdownGraceMs?: number
  readonly bridgeGraceMs?: number
  readonly healthTimeoutMs?: number
  readonly crashWindowMs?: number
  readonly maxCrashRestarts?: number
  readonly crashBackoffBaseMs?: number
  readonly spawn?: HostSpawn
  readonly signalPid?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>
  readonly isPidAlive?: (pid: number) => boolean
  readonly waitForPortRelease?: (webUrl: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>
  readonly waitForHealth?: (request: HealthCheckRequest) => Promise<HealthObservation>
  readonly observeBridgeBootId?: () => string | undefined | Promise<string | undefined>
  readonly notifyRestartPlanned?: (oldBootId: string, expectedBootId: string) => void | Promise<void>
  readonly now?: () => number
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly createBootId?: () => string
}

export const BOOT_ID_ENV = 'DSH_DEV_BOOT_ID'

const DEFAULT_SHUTDOWN_GRACE_MS = 10_000
const DEFAULT_BRIDGE_GRACE_MS = 10_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_CRASH_WINDOW_MS = 60_000
const DEFAULT_MAX_CRASH_RESTARTS = 3
const DEFAULT_CRASH_BACKOFF_BASE_MS = 250

export function createHostLifecycle(options: HostLifecycleOptions = {}): HostLifecycle {
  const shutdownGraceMs = duration(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 'shutdownGraceMs')
  const bridgeGraceMs = duration(options.bridgeGraceMs, DEFAULT_BRIDGE_GRACE_MS, 'bridgeGraceMs')
  const healthTimeoutMs = duration(options.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 'healthTimeoutMs')
  const crashWindowMs = duration(options.crashWindowMs, DEFAULT_CRASH_WINDOW_MS, 'crashWindowMs')
  const maxCrashRestarts = duration(options.maxCrashRestarts, DEFAULT_MAX_CRASH_RESTARTS, 'maxCrashRestarts')
  const backoffBase = duration(options.crashBackoffBaseMs, DEFAULT_CRASH_BACKOFF_BASE_MS, 'crashBackoffBaseMs')
  const spawn = options.spawn ?? nodeSpawn
  const signalPid = options.signalPid ?? defaultSignalPid
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const waitForPortRelease = options.waitForPortRelease ?? defaultWaitForPortRelease
  const healthCheck = options.waitForHealth ?? waitForHostHealth
  const now = options.now ?? Date.now
  const sleep = options.delay ?? delay
  const createBootId = options.createBootId ?? randomUUID
  const controller = new AbortController()
  const crashTimes: number[] = []
  const bridgeGenerations = new Map<number, number>()
  let current: AdoptedHost | undefined
  let disposed = false
  let mutationTail: Promise<void> = Promise.resolve()
  let restartOperation: {
    readonly host: AdoptedHost
    readonly expectedBootId: string
    readonly promise: Promise<RestartResult>
  } | undefined

  function assertActive(): void {
    if (disposed) throw new Error('host lifecycle is disposed')
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  function adopt(launch: HostLaunchSpec): Promise<AdoptedHost> {
    return serialize(async () => {
      assertActive()
      if (!isPidAlive(launch.pid)) {
        throw new Error(`cannot adopt missing host PID ${launch.pid}`)
      }
      const host: AdoptedHost = {
        pid: launch.pid,
        bootId: launch.bootId,
        launch: cloneLaunch(launch),
        source: 'adopted',
      }
      current = host
      return host
    })
  }

  async function restartOnce(request: RestartRequest): Promise<RestartResult> {
    assertActive()
    const operationSignal = combineSignals(request.signal, controller.signal)
    throwIfAborted(operationSignal)
    if (current !== request.host) {
      if (current?.source === 'spawned' && isPidAlive(current.pid)) {
        // A crash-recovery replacement is still live; do not double-restart.
        throw new Error('replacement host is still running')
      }
      throw new Error('restart request targets a stale host generation')
    }
    if (current !== undefined && current.pid !== request.host.pid && isPidAlive(current.pid)) {
      throw new Error('replacement host is still running')
    }

    await options.notifyRestartPlanned?.(request.host.bootId, request.expectedBootId)
    throwIfAborted(operationSignal)
    if (isPidAlive(request.host.pid)) {
      await signalPid(request.host.pid, 'SIGTERM')
      const exited = await waitForPidExit(
        request.host.pid,
        shutdownGraceMs,
        isPidAlive,
        sleep,
        operationSignal,
      )
      if (!exited) {
        await signalPid(request.host.pid, 'SIGKILL')
        const killed = await waitForPidExit(
          request.host.pid,
          shutdownGraceMs,
          isPidAlive,
          sleep,
          operationSignal,
        )
        if (!killed) throw new Error(`host PID ${request.host.pid} survived SIGKILL`)
      }
    }
    await waitForPortRelease(request.host.launch.webUrl, shutdownGraceMs, operationSignal)
    const replacement = spawnHost(request.host.launch, request.expectedBootId, spawn)
    current = replacement
    const health = await healthCheck({
      webUrl: request.host.launch.webUrl,
      expectedBootId: request.expectedBootId,
      timeoutMs: healthTimeoutMs,
      observeBridgeBootId: options.observeBridgeBootId ?? (() => undefined),
      signal: operationSignal,
    })
    if (!health.healthy) throw new Error('replacement host is unhealthy')
    return { host: replacement, health }
  }

  return {
    adopt,

    restart(request) {
      if (restartOperation !== undefined) {
        if (
          restartOperation.host === request.host
          && restartOperation.expectedBootId === request.expectedBootId
        ) return restartOperation.promise
        return Promise.reject(new Error('restart already in progress with a conflicting request'))
      }
      const operation = serialize(() => restartOnce(request))
      const wrapped = operation.finally(() => {
        if (restartOperation?.promise === wrapped) restartOperation = undefined
      })
      restartOperation = {
        host: request.host,
        expectedBootId: request.expectedBootId,
        promise: wrapped,
      }
      return wrapped
    },

    observeUnexpectedExit(host, signal) {
      return serialize(async () => {
        assertActive()
        const operationSignal = combineSignals(signal, controller.signal)
        throwIfAborted(operationSignal)
        if (current !== host) return 'restarted'
        if (isPidAlive(host.pid)) throw new Error(`host PID ${host.pid} is still running`)
        const at = now()
        while (crashTimes.length > 0 && at - crashTimes[0]! > crashWindowMs) crashTimes.shift()
        if (crashTimes.length >= maxCrashRestarts) return 'circuit-open'
        crashTimes.push(at)
        const backoff = Math.min(30_000, backoffBase * (2 ** (crashTimes.length - 1)))
        await sleep(backoff, operationSignal)
        throwIfAborted(operationSignal)
        if (current !== host) return 'restarted'
        await waitForPortRelease(host.launch.webUrl, shutdownGraceMs, operationSignal)
        throwIfAborted(operationSignal)
        if (current !== host) return 'restarted'
        const expectedBootId = createBootId()
        const replacement = spawnHost(host.launch, expectedBootId, spawn)
        current = replacement
        const health = await healthCheck({
          webUrl: host.launch.webUrl,
          expectedBootId,
          timeoutMs: healthTimeoutMs,
          observeBridgeBootId: options.observeBridgeBootId ?? (() => undefined),
          signal: operationSignal,
        })
        if (!health.healthy && isPidAlive(replacement.pid)) {
          throw new Error('replacement host is unhealthy')
        }
        if (!health.healthy) throw new Error('replacement host exited before becoming healthy')
        return 'restarted'
      })
    },

    async observeHostDisposing(host, signal) {
      assertActive()
      const operationSignal = combineSignals(signal, controller.signal)
      if (!isPidAlive(host.pid)) return 'stopped'
      const generation = (bridgeGenerations.get(host.pid) ?? 0) + 1
      bridgeGenerations.set(host.pid, generation)
      await sleep(bridgeGraceMs, operationSignal)
      throwIfAborted(operationSignal)
      if (!isPidAlive(host.pid)) return 'stopped'
      return bridgeGenerations.get(host.pid) !== generation ? 'reconnected' : 'bridge-timeout'
    },

    observeBridgeConnected(host) {
      if (disposed) return
      bridgeGenerations.set(host.pid, (bridgeGenerations.get(host.pid) ?? 0) + 1)
    },

    async dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      await mutationTail
      bridgeGenerations.clear()
      current = undefined
    },
  }
}

function spawnHost(launch: HostLaunchSpec, bootId: string, spawn: HostSpawn): AdoptedHost {
  const child = spawn(launch.nodeExecutable, [...launch.execArgv, ...launch.argv], {
    shell: false,
    cwd: launch.cwd,
    env: { ...launch.env, [BOOT_ID_ENV]: bootId },
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })
  if (child.pid === undefined) throw new Error('replacement host did not receive a PID')
  return {
    pid: child.pid,
    bootId,
    launch: { ...cloneLaunch(launch), pid: child.pid, bootId },
    source: 'spawned',
    child,
  }
}

function cloneLaunch(launch: HostLaunchSpec): HostLaunchSpec {
  return {
    pid: launch.pid,
    bootId: launch.bootId,
    nodeExecutable: launch.nodeExecutable,
    execArgv: [...launch.execArgv],
    argv: [...launch.argv],
    cwd: launch.cwd,
    env: { ...launch.env },
    profile: launch.profile,
    webUrl: launch.webUrl,
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  isPidAlive: (pid: number) => boolean,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(pid)) {
    throwIfAborted(signal)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(25, remaining), signal)
  }
  return true
}

function defaultSignalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (!isMissingProcessError(error)) throw error
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isMissingProcessError(error)
  }
}

async function defaultWaitForPortRelease(
  webUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(webUrl)
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  const deadline = Date.now() + timeoutMs
  while (await portAcceptsConnections(url.hostname, port, signal)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`host port ${port} did not close`)
    await delay(Math.min(25, remaining), signal)
  }
}

function portAcceptsConnections(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const abort = () => {
      socket.destroy()
      reject(abortError())
    }
    const finish = (open: boolean) => {
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(open)
    }
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    function finish(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return resolved
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second])
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ESRCH'
}
