import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import type { HostLaunchSpec } from '../../src/shared/protocol.js'
import { createHostLifecycle } from '../../src/supervisor/lifecycle.js'
import { spawnFakeHost } from '../helpers/process-harness.js'

function launch(
  pid = 41,
  bootId = 'old',
  webUrl = 'http://127.0.0.1:0',
): HostLaunchSpec {
  return {
    pid,
    bootId,
    nodeExecutable: '/node',
    execArgv: ['--trace-warnings'],
    argv: ['/dsh', 'web', '--profile', 'work'],
    cwd: '/workspace',
    env: { PATH: '/bin', SECRET: 'memory-only' },
    profile: 'work',
    webUrl,
  }
}

function child(pid: number): ChildProcess {
  const value = new EventEmitter() as ChildProcess
  Object.assign(value, { pid, exitCode: null, signalCode: null })
  return value
}

describe('host lifecycle', () => {
  it('adopts the existing non-child PID without spawning', async () => {
    const spawn = vi.fn()
    const lifecycle = createHostLifecycle({ spawn, isPidAlive: () => true })

    const host = await lifecycle.adopt(launch())

    expect(host).toMatchObject({ pid: 41, bootId: 'old', source: 'adopted' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('owns planned restart ordering, exact launch reuse, escalation, and health', async () => {
    const events: string[] = []
    let alive = true
    const replacement = child(73)
    const spawn = vi.fn((_executable, _args, _options) => {
      events.push('spawn')
      return replacement
    })
    const lifecycle = createHostLifecycle({
      shutdownGraceMs: 4,
      notifyRestartPlanned: async () => { events.push('notify') },
      signalPid: async (_pid, signal) => {
        events.push(signal)
        if (signal === 'SIGKILL') alive = false
      },
      isPidAlive: () => alive,
      waitForPortRelease: async () => { events.push('port') },
      spawn,
      waitForHealth: async request => {
        events.push('health')
        return {
          healthy: true,
          httpReady: true,
          bridgeReady: true,
          expectedBootId: request.expectedBootId,
          observedBootId: request.expectedBootId,
        }
      },
    })
    const adopted = await lifecycle.adopt(launch())

    const result = await lifecycle.restart({ host: adopted, expectedBootId: 'new' })

    expect(events).toEqual(['notify', 'SIGTERM', 'SIGKILL', 'port', 'spawn', 'health'])
    expect(spawn).toHaveBeenCalledWith('/node', [
      '--trace-warnings', '/dsh', 'web', '--profile', 'work',
    ], expect.objectContaining({
      shell: false,
      cwd: '/workspace',
      env: {
        PATH: '/bin',
        SECRET: 'memory-only',
        DSH_DEV_BOOT_ID: 'new',
      },
    }))
    expect(result.host).toMatchObject({ pid: 73, bootId: 'new', source: 'spawned' })
    expect(result.health.healthy).toBe(true)
  })

  it('preserves explicit launch environment while injecting the replacement boot ID', async () => {
    let alive = true
    const spawn = vi.fn(() => child(73))
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? alive : true,
      signalPid: async () => { alive = false },
      waitForPortRelease: async () => undefined,
      spawn,
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const host = await lifecycle.adopt({
      ...launch(),
      env: { PATH: '/custom/bin', EXPLICIT_SETTING: 'keep-me' },
    })

    await lifecycle.restart({ host, expectedBootId: 'replacement-boot' })

    expect(spawn).toHaveBeenCalledWith('/node', expect.any(Array), expect.objectContaining({
      env: {
        PATH: '/custom/bin',
        EXPLICIT_SETTING: 'keep-me',
        DSH_DEV_BOOT_ID: 'replacement-boot',
      },
    }))
  })

  it('does not escalate when the old host exits during graceful shutdown', async () => {
    let alive = true
    const signalPid = vi.fn(async (_pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') alive = false
    })
    const lifecycle = createHostLifecycle({
      signalPid,
      isPidAlive: pid => pid === 41 ? alive : true,
      waitForPortRelease: async () => undefined,
      spawn: () => child(73),
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const host = await lifecycle.adopt(launch())

    await lifecycle.restart({ host, expectedBootId: 'new' })

    expect(signalPid).toHaveBeenCalledTimes(1)
    expect(signalPid).toHaveBeenCalledWith(41, 'SIGTERM')
  })

  it('rejects conflicting concurrent restarts instead of aliasing their results', async () => {
    let alive = true
    let releasePort!: () => void
    const port = new Promise<void>(resolve => { releasePort = resolve })
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? alive : true,
      signalPid: async () => { alive = false },
      waitForPortRelease: () => port,
      spawn: () => child(73),
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const host = await lifecycle.adopt(launch())
    const first = lifecycle.restart({ host, expectedBootId: 'new' })
    await vi.waitFor(() => expect(alive).toBe(false))

    await expect(lifecycle.restart({ host, expectedBootId: 'other' }))
      .rejects.toThrow('restart already in progress')
    releasePort()
    await expect(first).resolves.toMatchObject({ host: { bootId: 'new' } })
  })

  it('serializes crash observation behind a planned restart and never double-spawns', async () => {
    let alive = true
    let releasePort!: () => void
    const port = new Promise<void>(resolve => { releasePort = resolve })
    const spawn = vi.fn(() => child(73))
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? alive : true,
      signalPid: async () => { alive = false },
      waitForPortRelease: () => port,
      spawn,
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const host = await lifecycle.adopt(launch())
    const restarting = lifecycle.restart({ host, expectedBootId: 'new' })
    await vi.waitFor(() => expect(alive).toBe(false))
    const crashed = lifecycle.observeUnexpectedExit(host)
    releasePort()

    await restarting
    await expect(crashed).resolves.toBe('restarted')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('ignores stale exit callbacks even when the current generation is no longer live', async () => {
    let adoptedAlive = true
    let replacementAlive = true
    const spawn = vi.fn(() => child(73))
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? adoptedAlive : replacementAlive,
      signalPid: async () => { adoptedAlive = false },
      waitForPortRelease: async () => undefined,
      spawn,
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const old = await lifecycle.adopt(launch())
    await lifecycle.restart({ host: old, expectedBootId: 'new' })
    replacementAlive = false

    await expect(lifecycle.observeUnexpectedExit(old)).resolves.toBe('restarted')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('does not create a second replacement while an unhealthy child is live', async () => {
    const replacement = child(73)
    const spawn = vi.fn(() => replacement)
    let oldAlive = true
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? oldAlive : true,
      waitForPortRelease: async () => undefined,
      spawn,
      waitForHealth: async request => ({
        healthy: false,
        httpReady: true,
        bridgeReady: false,
        expectedBootId: request.expectedBootId,
      }),
    })
    const adopted = await lifecycle.adopt(launch())
    oldAlive = false

    await expect(lifecycle.restart({ host: adopted, expectedBootId: 'new' }))
      .rejects.toThrow('replacement host is unhealthy')
    await expect(lifecycle.restart({ host: adopted, expectedBootId: 'newer' }))
      .rejects.toThrow('replacement host is still running')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('allows a second sequential restart of the current spawned host', async () => {
    let adoptedAlive = true
    let replacementAlive = true
    const lifecycle = createHostLifecycle({
      isPidAlive: pid => pid === 41 ? adoptedAlive : replacementAlive,
      signalPid: async pid => {
        if (pid === 41) adoptedAlive = false
        else replacementAlive = false
      },
      waitForPortRelease: async () => undefined,
      spawn: () => child(73),
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
    })
    const adopted = await lifecycle.adopt(launch())

    const first = await lifecycle.restart({ host: adopted, expectedBootId: 'new' })
    expect(first.host).toMatchObject({ pid: 73, bootId: 'new', source: 'spawned' })

    // A second sequential restart of the current (spawned) host must be
    // allowed: the previous restart completed and it is the legitimate host.
    const second = await lifecycle.restart({ host: first.host, expectedBootId: 'newer' })
    expect(second.host).toMatchObject({ pid: 73, bootId: 'newer', source: 'spawned' })
  })

  it('waits for crash port release and requires a real bridge observation', async () => {
    const events: string[] = []
    let alive = true
    let capturedObserve: (() => string | undefined | Promise<string | undefined>) | undefined
    const lifecycle = createHostLifecycle({
      crashBackoffBaseMs: 0,
      isPidAlive: () => alive,
      delay: async () => undefined,
      waitForPortRelease: async () => { events.push('port') },
      spawn: (_executable, _args, spawnOptions) => {
        events.push('spawn')
        expect(spawnOptions.env).toMatchObject({
          PATH: '/bin',
          SECRET: 'memory-only',
          DSH_DEV_BOOT_ID: 'crash-new',
        })
        return child(73)
      },
      waitForHealth: async request => {
        capturedObserve = request.observeBridgeBootId
        events.push('health')
        return {
          healthy: false,
          httpReady: true,
          bridgeReady: false,
          expectedBootId: request.expectedBootId,
        }
      },
      createBootId: () => 'crash-new',
    })
    const host = await lifecycle.adopt(launch())
    alive = false

    await expect(lifecycle.observeUnexpectedExit(host)).rejects.toThrow('exited before becoming healthy')
    expect(events).toEqual(['port', 'spawn', 'health'])
    expect(capturedObserve).toBeTypeOf('function')
    expect(capturedObserve?.()).toBeUndefined()
  })

  it('recovers successive current-generation crashes with exponential backoff then opens the circuit', async () => {
    let now = 1_000
    const delays: number[] = []
    const alivePids = new Set([41])
    const spawn = vi.fn(() => {
      const next = 70 + spawn.mock.calls.length
      alivePids.add(next)
      return child(next)
    })
    const lifecycle = createHostLifecycle({
      crashWindowMs: 1_000,
      maxCrashRestarts: 2,
      crashBackoffBaseMs: 10,
      now: () => now,
      delay: async ms => { delays.push(ms) },
      isPidAlive: pid => alivePids.has(pid),
      waitForPortRelease: async () => undefined,
      spawn,
      waitForHealth: async request => ({
        healthy: true,
        httpReady: true,
        bridgeReady: true,
        expectedBootId: request.expectedBootId,
        observedBootId: request.expectedBootId,
      }),
      observeBridgeBootId: () => `boot-${spawn.mock.calls.length}`,
      createBootId: () => `boot-${spawn.mock.calls.length + 1}`,
    })
    let current = await lifecycle.adopt(launch())
    alivePids.delete(current.pid)

    expect(await lifecycle.observeUnexpectedExit(current)).toBe('restarted')
    current = await lifecycle.adopt(launch(71, 'boot-1'))
    alivePids.delete(current.pid)
    now += 10
    expect(await lifecycle.observeUnexpectedExit(current)).toBe('restarted')
    current = await lifecycle.adopt(launch(72, 'boot-2'))
    alivePids.delete(current.pid)
    now += 10
    expect(await lifecycle.observeUnexpectedExit(current)).toBe('circuit-open')
    expect(delays).toEqual([10, 20])
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('treats announced disposal plus exit as a normal stop, but reconnect cancels HMR grace', async () => {
    let alive = true
    const delayResolvers: Array<() => void> = []
    const lifecycle = createHostLifecycle({
      bridgeGraceMs: 5,
      isPidAlive: () => alive,
      delay: () => new Promise<void>(resolve => delayResolvers.push(resolve)),
      spawn: vi.fn(() => child(90)),
    })
    const host = await lifecycle.adopt(launch())

    const hmr = lifecycle.observeHostDisposing(host)
    lifecycle.observeBridgeConnected(host)
    delayResolvers.shift()?.()
    expect(await hmr).toBe('reconnected')

    alive = false
    expect(await lifecycle.observeHostDisposing(host)).toBe('stopped')
  })

  it('reports bridge timeout when an announced host remains live without reconnecting', async () => {
    const lifecycle = createHostLifecycle({
      bridgeGraceMs: 0,
      isPidAlive: () => true,
      delay: async () => undefined,
    })
    const host = await lifecycle.adopt(launch())

    await expect(lifecycle.observeHostDisposing(host)).resolves.toBe('bridge-timeout')
  })

  it('observes an announced real fake-host exit without leaking the child', async () => {
    const fake = spawnFakeHost()
    try {
      const ready = await fake.ready
      const lifecycle = createHostLifecycle({ bridgeGraceMs: 100 })
      const host = await lifecycle.adopt(launch(
        ready.pid,
        ready.bootId,
        `http://127.0.0.1:${ready.port}`,
      ))
      const disposing = lifecycle.observeHostDisposing(host)
      fake.child.kill('SIGTERM')
      expect(await disposing).toBe('stopped')
      await lifecycle.dispose()
    } finally {
      await fake.stop()
    }
  })

  it('dispose aborts an in-flight planned restart health check', async () => {
    let alive = true
    const lifecycle = createHostLifecycle({
      isPidAlive: () => alive,
      signalPid: async () => { alive = false },
      waitForPortRelease: async () => undefined,
      spawn: () => child(88),
      waitForHealth: request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    })
    const host = await lifecycle.adopt(launch())
    const restarting = lifecycle.restart({ host, expectedBootId: 'new' })
    await vi.waitFor(() => expect(alive).toBe(false))
    const disposing = lifecycle.dispose()
    await expect(restarting).rejects.toMatchObject({ name: 'AbortError' })
    await disposing
  })

  it('dispose is idempotent, aborts recovery, and never kills the adopted host', async () => {
    const signalPid = vi.fn()
    const lifecycle = createHostLifecycle({ signalPid, isPidAlive: () => true })
    await lifecycle.adopt(launch())
    await lifecycle.dispose()
    await lifecycle.dispose()
    expect(signalPid).not.toHaveBeenCalled()
    await expect(lifecycle.adopt(launch())).rejects.toThrow('disposed')
  })
})
