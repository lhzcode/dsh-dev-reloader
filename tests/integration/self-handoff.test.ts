import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION, type HostLaunchSpec } from '../../src/shared/protocol.js'
import type { SupervisorConfig } from '../../src/shared/config.js'
import type { ProjectDescriptor } from '../../src/supervisor/discovery.js'
import type { HostLifecycle } from '../../src/supervisor/lifecycle.js'
import type { CommandRunner } from '../../src/supervisor/runner.js'
import type { ChangeScheduler } from '../../src/supervisor/scheduler.js'
import type { TaskGate } from '../../src/supervisor/task-gate.js'
import type { WatchPlanController } from '../../src/supervisor/watcher.js'
import { createSupervisor } from '../../src/supervisor/supervisor.js'
import { resolveRuntimePaths, type RuntimePaths } from '../../src/supervisor/paths.js'
import { acquireSupervisorLock } from '../../src/supervisor/lock.js'
import { createSupervisorCliAdapters, runLeadHandoff, serveSupervisor } from '../../src/supervisor/cli.js'
import type { SupervisorCliRuntime } from '../../src/supervisor/cli.js'
import {
  connectForHandoff,
  createHandoffFollow,
  listenForHandoff,
  resolveHandoffEndpoint,
} from '../../src/supervisor/handoff.js'
import { spawnFakeHost, type FakeHostProcess } from '../helpers/process-harness.js'

const config: SupervisorConfig = {
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

function lifecycleStub(seed: HostLaunchSpec): HostLifecycle {
  return {
    adopt: vi.fn(async adopted => ({
      pid: adopted.pid,
      bootId: adopted.bootId,
      launch: adopted,
      source: 'adopted' as const,
    })),
    restart: vi.fn(async () => ({
      host: {
        pid: seed.pid,
        bootId: seed.bootId,
        launch: seed,
        source: 'spawned' as const,
      },
      health: { healthy: true as const, httpReady: true, bridgeReady: true, expectedBootId: seed.bootId, observedBootId: seed.bootId },
    })),
    observeUnexpectedExit: vi.fn(async () => 'restarted'),
    observeHostDisposing: vi.fn(async () => 'reconnected'),
    observeBridgeConnected: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }
}

function supervisorHarness(seed: HostLaunchSpec) {
  const watcher: WatchPlanController = {
    replace: vi.fn(async watchPlan => ({
      promoted: true,
      watchedRoots: watchPlan.projects.map(item => item.root),
      degradedRoots: [],
    })),
    inspect: vi.fn(() => ({ promoted: true, watchedRoots: [project.root], degradedRoots: [] })),
    close: vi.fn(async () => undefined),
  }
  const scheduler: ChangeScheduler = {
    enqueue: vi.fn(),
    waitForIdle: vi.fn(async () => ({ kind: 'success' as const })),
    close: vi.fn(async () => undefined),
  }
  const runner: CommandRunner = {
    run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })),
    ensurePersistent: vi.fn(async (key, command) => ({
      key,
      command,
      pid: 88,
      done: new Promise(() => undefined),
      stop: async () => undefined,
    })),
    stopAll: vi.fn(async () => undefined),
    persistentCount: 0,
  }
  const gate: TaskGate & { bridgeReplaced(): void } = {
    inspect: vi.fn(() => ({ open: true as const })),
    updateActivity: vi.fn(() => true),
    bridgeDisconnected: vi.fn(),
    bridgeReplaced: vi.fn(),
    beginLocalTask: vi.fn(() => vi.fn()),
    waitUntilOpen: vi.fn(async () => undefined),
  }
  const lifecycle = lifecycleStub(seed)
  const supervisor = createSupervisor({
    config,
    discover: vi.fn(async () => ({ projects: [project], warnings: [] as const })),
    createWatcher: () => watcher,
    createScheduler: () => scheduler,
    runner,
    gate,
    lifecycle,
    createBootId: () => 'next-boot',
    publishStatus: vi.fn(),
  })
  return { supervisor, watcher, scheduler, runner, gate, lifecycle }
}

const fakeHosts: FakeHostProcess[] = []
const roots: string[] = []
const endpoints: string[] = []
const socketServers: Server[] = []

async function listenSocket(endpoint: string): Promise<Server> {
  const server = createServer(socket => socket.end())
  socketServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function closeSocket(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function assertSocketReachable(endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint)
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
  })
}

/** Drive a standby coordinator to completion so the lead's protocol waits resolve. */
function startStandbyFollower(
  handle: Awaited<ReturnType<typeof listenForHandoff>>,
  hooks: Partial<Parameters<typeof createHandoffFollow>[0]> = {},
): Promise<void> {
  return createHandoffFollow({
    acceptSnapshot: hooks.acceptSnapshot ?? (async () => undefined),
    acquireOwnership: hooks.acquireOwnership ?? (async () => undefined),
    releaseOwnership: hooks.releaseOwnership ?? (async () => undefined),
    verifyStillOwner: hooks.verifyStillOwner ?? (async () => true),
    beginServing: hooks.beginServing ?? (async () => undefined),
  }, handle.channel).start()
}

/** Connect to a handoff endpoint that is still being bound by the standby server. */
async function connectHandoffWithRetry(options: {
  endpoint: string
  token: string
  transactionId: string
}): Promise<Awaited<ReturnType<typeof connectForHandoff>>> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return await connectForHandoff(options)
    } catch (error) {
      if (Date.now() > deadline) throw error
      await delay(20)
    }
  }
}

async function temporaryPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-handoff-'))
  roots.push(root)
  return resolveRuntimePaths({ dshHome: root, profile: 'web' })
}

afterEach(async () => {
  await Promise.all(socketServers.splice(0).map(server => closeSocket(server).catch(() => undefined)))
  await Promise.race([
    Promise.all(fakeHosts.splice(0).map(async host => { await host.stop().catch(() => undefined) })),
    delay(5_000),
  ])
  await Promise.all(endpoints.splice(0).map(endpoint => unlink(endpoint).catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

describe('supervisor self-handoff integration', () => {
  it('hands off to exactly one supervisor that owns the endpoint after commit', async () => {
    const paths = await temporaryPaths()

    // Spawn a real fake host on an OS-assigned port (reaped in teardown).
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }

    const oldHarness = supervisorHarness(launch)
    await oldHarness.supervisor.start(launch)
    expect(oldHarness.supervisor.status.phase).toBe('watching')
    const oldLease = await acquireSupervisorLock(paths)

    const transactionId = `txn-${ready.bootId}-${randomUUID()}`
    const handoffEndpoint = resolveHandoffEndpoint(paths, transactionId)
    endpoints.push(handoffEndpoint)

    const standbyHandlePromise = listenForHandoff({ endpoint: handoffEndpoint, token: 'a'.repeat(64), transactionId })

    let standbyLease: Awaited<ReturnType<typeof acquireSupervisorLock>> | undefined
    let standbyServeCount = 0
    const standbyHooks: Parameters<typeof createHandoffFollow>[0] = {
      acceptSnapshot: async snapshot => {
        if (snapshot.launch.env.DSH_DEV_BOOT_ID !== ready.bootId) {
          throw new Error('handoff snapshot launch environment mismatch')
        }
      },
      acquireOwnership: async () => {
        // The old released its lease at freeze; this acquire is the atomic takeover.
        standbyLease = await acquireSupervisorLock(paths)
      },
      verifyStillOwner: async () => standbyLease !== undefined,
      beginServing: async () => {
        standbyServeCount += 1
      },
    }

    const standbyRun = (async () => {
      const handle = await standbyHandlePromise
      const follower = createHandoffFollow(standbyHooks, handle.channel)
      await follower.start()
      await handle.close()
    })()

    const leadHandle = await connectForHandoff({ endpoint: handoffEndpoint, token: 'a'.repeat(64), transactionId })
    let oldLeaseReleased = false
    const lockHooks = {
      transferOwnership: async () => {
        await oldLease.release()
        oldLeaseReleased = true
      },
    }
    const handoff = oldHarness.supervisor.handoff(leadHandle.channel, lockHooks, { id: transactionId, generation: 1 })
    await handoff.prepare()
    await handoff.freeze()
    await handoff.commit()
    await leadHandle.close()
    await standbyRun

    expect(standbyServeCount).toBe(1)
    expect(oldLeaseReleased).toBe(true)
    expect(standbyLease).toBeDefined()
    // Exactly one owner afterwards: a fresh third acquire must fail as already running.
    await expect(acquireSupervisorLock(paths)).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })
    await standbyLease!.release()
  })

  it('leaves the old supervisor responsive when handoff preparation fails', async () => {
    const paths = await temporaryPaths()
    await acquireSupervisorLock(paths)
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }

    const oldHarness = supervisorHarness(launch)
    // Do NOT start: the old is not watching, so prepare must reject and resume.
    const transactionId = `txn-failed-prepare-${randomUUID()}`
    const handoffEndpoint = resolveHandoffEndpoint(paths, transactionId)
    endpoints.push(handoffEndpoint)

    const standbyHooks: Parameters<typeof createHandoffFollow>[0] = {
      acceptSnapshot: vi.fn(async () => undefined),
      acquireOwnership: vi.fn(async () => undefined),
      verifyStillOwner: vi.fn(async () => true),
      beginServing: vi.fn(async () => undefined),
    }
    const standbyHandlePromise = listenForHandoff({ endpoint: handoffEndpoint, token: 'a'.repeat(64), transactionId })
    const standbyRun = (async () => {
      const handle = await standbyHandlePromise
      const follower = createHandoffFollow(standbyHooks, handle.channel)
      const result = await Promise.race([
        follower.start(),
        delay(5_000).then(() => 'timeout' as const),
      ])
      await handle.close()
      return result
    })()

    const leadHandle = await connectForHandoff({ endpoint: handoffEndpoint, token: 'a'.repeat(64), transactionId })
    const handoff = oldHarness.supervisor.handoff(leadHandle.channel, {
      transferOwnership: vi.fn(async () => undefined),
      reacquire: vi.fn(async () => true),
    }, { id: transactionId, generation: 1 })

    await expect(handoff.prepare()).rejects.toThrow(/watching|healthy|not active/i)
    await leadHandle.close()
    await standbyRun

    // The old still works: starting it now (after the failed prepare) succeeds.
    await oldHarness.supervisor.start(launch)
    expect(oldHarness.supervisor.status.phase).toBe('watching')
  })

  it('re-acquires the released lease on abort-after-freeze and keeps serving', async () => {
    const paths = await temporaryPaths()
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }
    const oldHarness = supervisorHarness(launch)
    await oldHarness.supervisor.start(launch)
    expect(oldHarness.supervisor.status.phase).toBe('watching')
    const oldLease = await acquireSupervisorLock(paths)

    const transactionId = `txn-reacquire-${randomUUID()}`
    const endpoint = resolveHandoffEndpoint(paths, transactionId)
    endpoints.push(endpoint)
    const standbyHandlePromise = listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId })
    const leadHandle = await connectHandoffWithRetry({ endpoint, token: 'a'.repeat(64), transactionId })
    const standbyHandle = await standbyHandlePromise
    const followerRun = startStandbyFollower(standbyHandle)

    let reacquiredLease: Awaited<ReturnType<typeof acquireSupervisorLock>> | undefined
    const lockHooks = {
      transferOwnership: async () => {
        await oldLease.release()
      },
      reacquire: async () => {
        reacquiredLease = await acquireSupervisorLock(paths)
        return reacquiredLease !== undefined
      },
    }
    const handoff = oldHarness.supervisor.handoff(leadHandle.channel, lockHooks, { id: transactionId, generation: 1 })
    await handoff.prepare()
    await handoff.freeze()
    await handoff.abort()
    await leadHandle.close()
    await standbyHandle.close()
    await followerRun

    // resume() must have re-acquired the released lease, and the old supervisor
    // must keep serving with ownership intact (a third acquire still fails).
    expect(oldHarness.supervisor.status.phase).toBe('watching')
    await expect(acquireSupervisorLock(paths)).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })
    await reacquiredLease!.release()
  })

  it('fails closed on abort-after-freeze when the released lease cannot be re-acquired', async () => {
    const paths = await temporaryPaths()
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }
    const oldHarness = supervisorHarness(launch)
    await oldHarness.supervisor.start(launch)
    const oldLease = await acquireSupervisorLock(paths)

    const transactionId = `txn-failclosed-${randomUUID()}`
    const endpoint = resolveHandoffEndpoint(paths, transactionId)
    endpoints.push(endpoint)
    const standbyHandlePromise = listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId })
    const leadHandle = await connectHandoffWithRetry({ endpoint, token: 'a'.repeat(64), transactionId })
    const standbyHandle = await standbyHandlePromise
    const followerRun = startStandbyFollower(standbyHandle)

    const lockHooks = {
      transferOwnership: async () => {
        await oldLease.release()
      },
      // The standby still holds the released lease; the old cannot re-acquire.
      reacquire: async () => false,
    }
    const handoff = oldHarness.supervisor.handoff(leadHandle.channel, lockHooks, { id: transactionId, generation: 1 })
    await handoff.prepare()
    await handoff.freeze()
    await handoff.abort()
    await leadHandle.close()
    await standbyHandle.close()
    await followerRun

    // The old must NOT resume serving without ownership: it fails closed.
    expect(oldHarness.supervisor.status.phase).toBe('failed')
    expect(oldHarness.supervisor.status.phase).not.toBe('watching')
  })

  it('does not dispose lifecycle or close adapters when host-disposing lands during a freeze', async () => {
    const paths = await temporaryPaths()
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }
    const oldHarness = supervisorHarness(launch)
    await oldHarness.supervisor.start(launch)
    const oldLease = await acquireSupervisorLock(paths)

    const transactionId = `txn-freeze-guard-${randomUUID()}`
    const endpoint = resolveHandoffEndpoint(paths, transactionId)
    endpoints.push(endpoint)
    const standbyHandlePromise = listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId })
    const leadHandle = await connectHandoffWithRetry({ endpoint, token: 'a'.repeat(64), transactionId })
    const standbyHandle = await standbyHandlePromise
    const followerRun = startStandbyFollower(standbyHandle, {
      verifyStillOwner: async () => false,
    })
    const lockHooks = {
      transferOwnership: async () => { await oldLease.release() },
      reacquire: async () => false,
    }
    const handoff = oldHarness.supervisor.handoff(leadHandle.channel, lockHooks, { id: transactionId, generation: 1 })
    await handoff.prepare()

    const lifecycleDisposed = vi.fn(oldHarness.lifecycle.dispose)
    oldHarness.lifecycle.dispose = lifecycleDisposed

    // Freeze, then a host-disposing arrives mid-handoff while frozen.
    const frozenPromise = handoff.freeze()
    await oldHarness.supervisor.handleBridgeEvent({ timestamp: 0, protocolVersion: PROTOCOL_VERSION, type: 'host-disposing', hostPid: launch.pid })
    await frozenPromise
    await leadHandle.close()
    await standbyHandle.close()
    await followerRun

    // Frozen mutations must not dispose lifecycle or close adapters, even when a
    // disconnecting host would otherwise request a stop.
    expect(lifecycleDisposed).not.toHaveBeenCalled()
    expect(oldHarness.supervisor.status.phase).toBe('failed')
  })

  it('runs the full lead protocol and exits the old after the standby commits', async () => {
    const paths = await temporaryPaths()
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }
    const oldHarness = supervisorHarness(launch)
    await oldHarness.supervisor.start(launch)
    expect(oldHarness.supervisor.status.phase).toBe('watching')
    const oldLease = await acquireSupervisorLock(paths)

    let committedDebounce: number | undefined
    let standbyLease: Awaited<ReturnType<typeof acquireSupervisorLock>> | undefined
    const nonDefaultConfig: SupervisorConfig = { ...config, debounceMs: 1234 }
    const handoffOrder: string[] = []
    const oldEndpointServer = await listenSocket(paths.endpoint)

    const fakeRuntime: Pick<SupervisorCliRuntime,
      'spawnStandby' | 'connectHandoff' | 'acquireLock'> = {
      spawnStandby: ({ transactionId }) => {
        // The seam runs the standby coordinator in-process on the lead's endpoint.
        const endpoint = resolveHandoffEndpoint(paths, transactionId)
        endpoints.push(endpoint)
        void (async () => {
          const handle = await listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId })
          await createHandoffFollow({
            acceptSnapshot: async snapshot => {
              committedDebounce = snapshot.config.debounceMs
            },
            acquireOwnership: async () => {
              standbyLease = await acquireSupervisorLock(paths)
            },
            releaseOwnership: async () => {
              if (standbyLease !== undefined) {
                await standbyLease.release().catch(() => undefined)
                standbyLease = undefined
              }
            },
            verifyStillOwner: async () => standbyLease !== undefined,
            beginServing: async () => {
              handoffOrder.push('standby-serving')
              expect(oldEndpointServer.listening).toBe(false)
              await listenSocket(paths.endpoint)
            },
          }, handle.channel).start()
          await handle.close()
        })()
        return { pid: 99_999 }
      },
      connectHandoff: options => connectHandoffWithRetry(options),
      acquireLock: pathsArg => acquireSupervisorLock(pathsArg),
    }

    let committedCallback = false
    await runLeadHandoff({
      runtime: fakeRuntime as unknown as SupervisorCliRuntime,
      profile: 'web',
      paths,
      token: 'a'.repeat(64),
      supervisor: oldHarness.supervisor,
      getLease: () => oldLease,
      setLease: () => undefined,
      beforeCommit: async () => {
        handoffOrder.push('lead-endpoint-closed')
        await closeSocket(oldEndpointServer)
      },
      restoreAfterAbort: async () => undefined,
      onCommitted: () => { committedCallback = true },
    })

    expect(committedCallback).toBe(true)
    expect(handoffOrder).toEqual(['lead-endpoint-closed', 'standby-serving'])
    await assertSocketReachable(paths.endpoint)
    // The old's carried config was accepted by the standby (not dropped to defaults).
    expect(committedDebounce).toBe(1)
    // Exactly one owner after the old releases: a fresh acquire must fail.
    await expect(acquireSupervisorLock(paths)).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })
    await standbyLease!.release()
    void nonDefaultConfig
  })

  it('routs a carried non-default snapshot config into the standby supervisor', async () => {
    const paths = await temporaryPaths()
    const host = spawnFakeHost()
    fakeHosts.push(host)
    const ready = await host.ready
    const launch: HostLaunchSpec = {
      pid: ready.pid,
      bootId: ready.bootId,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: { DSH_DEV_BOOT_ID: ready.bootId },
      profile: 'web',
      webUrl: `http://127.0.0.1:${ready.port}`,
    }
    const snapshotConfig: SupervisorConfig = { ...config, debounceMs: 4321, sourceRoots: ['/custom/src'] }
    const standbyLease = await acquireSupervisorLock(paths)
    let seenConfig: SupervisorConfig | undefined
    let resolveShutdown!: () => void

    const fakeRuntime: Pick<SupervisorCliRuntime,
      | 'resolvePaths' | 'acquireLock' | 'loadToken' | 'createSupervisor'
      | 'listen' | 'installSignalHandlers' | 'watchHostExit'> = {
      resolvePaths: async () => paths,
      acquireLock: async () => acquireSupervisorLock(paths),
      loadToken: async () => 'a'.repeat(64),
      createSupervisor: context => {
        seenConfig = context.config
        return supervisorHarness(launch).supervisor
      },
      listen: async () => ({
        endpoint: paths.endpoint,
        closed: false,
        connectionCount: 0,
        broadcast: async () => undefined,
        close: async () => undefined,
      }),
      installSignalHandlers: handler => {
        resolveShutdown = handler
        return () => undefined
      },
      watchHostExit: () => () => undefined,
    }

    // Simulate the standby serving from a committed handoff: serve with the seed.
    const servePromise = serveSupervisor(
      { mode: 'serve', profile: 'web' },
      fakeRuntime as unknown as SupervisorCliRuntime,
      { lease: standbyLease, launch, config: snapshotConfig },
    )
    // Wait until createSupervisor has run and the serve loop is parked on shutdown.
    await new Promise<void>(resolve => setImmediate(resolve))
    resolveShutdown()
    await servePromise

    // The carried snapshot config must reach the standby's created supervisor.
    expect(seenConfig?.debounceMs).toBe(4321)
    expect(seenConfig?.sourceRoots).toEqual(['/custom/src'])
  })
})
