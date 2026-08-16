import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const compositionMocks = vi.hoisted(() => ({
  createHostLifecycle: vi.fn((options: unknown) => ({ options })),
  createSupervisor: vi.fn((options: unknown) => ({ options })),
}))

vi.mock('../../src/supervisor/lifecycle.js', () => ({
  createHostLifecycle: compositionMocks.createHostLifecycle,
}))
vi.mock('../../src/supervisor/supervisor.js', () => ({
  createSupervisor: compositionMocks.createSupervisor,
}))

import { PROTOCOL_VERSION, type BridgeHello } from '../../src/shared/protocol.js'
import type { IpcServer, ListenForBridgesOptions } from '../../src/supervisor/ipc.js'
import type { LockLease } from '../../src/supervisor/lock.js'
import { resolveRuntimePaths } from '../../src/supervisor/paths.js'
import type { DevReloaderSupervisor } from '../../src/supervisor/supervisor.js'
import * as cliModule from '../../src/supervisor/cli.js'
import {
  createSupervisorCliAdapters,
  loadOrCreateSupervisorToken,
  parseCliArguments,
  runSupervisorCli,
  type SupervisorCliRuntime,
} from '../../src/supervisor/cli.js'

describe('supervisor CLI', () => {
  it('parses only explicit serve and handoff modes without shell-like expansion', () => {
    expect(parseCliArguments(['--serve', '--profile', 'web'])).toEqual({ mode: 'serve', profile: 'web' })
    expect(parseCliArguments(['--handoff', '--profile', 'dev'])).toEqual({ mode: 'handoff', profile: 'dev' })
    expect(() => parseCliArguments(['--serve', '--profile', 'web; rm -rf /'])).toThrow(/profile/i)
    expect(() => parseCliArguments(['--serve', '--profile'])).toThrow(/profile/i)
    expect(() => parseCliArguments(['--serve', '--handoff', '--profile', 'web'])).toThrow(/mode/i)
    expect(() => parseCliArguments(['--serve', '--profile', 'web', '--wat'])).toThrow(/unknown/i)
  })

  it('supplies a lifecycle replacement factory using current policy and bridge observers', async () => {
    const createDefaultSupervisor = Reflect.get(cliModule, 'createDefaultSupervisor') as
      | ((context: {
          paths: Awaited<ReturnType<typeof resolveRuntimePaths>>
          token: string
          publishStatus: () => void
          publishEvent: () => void
          observeBridgeBootId: () => string | undefined
        }) => unknown)
      | undefined
    expect(createDefaultSupervisor).toBeTypeOf('function')
    const observeBridgeBootId = vi.fn(() => 'bridge-boot')
    const publishEvent = vi.fn()
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-lifecycle-')),
      profile: 'web',
    })
    createDefaultSupervisor!({
      paths,
      token: 'a'.repeat(64),
      publishStatus: vi.fn(),
      publishEvent,
      observeBridgeBootId,
    })
    const supervisorOptions = compositionMocks.createSupervisor.mock.calls.at(-1)?.[0] as {
      createLifecycle?: (config: {
        healthTimeoutMs: number
        shutdownGraceMs: number
        bridgeGraceMs: number
        crashWindowMs: number
        maxCrashRestarts: number
      }, launch: { pid: number }) => unknown
    }
    expect(supervisorOptions.createLifecycle).toBeTypeOf('function')

    const seedLaunch = { pid: 2_147_483_647 }
    supervisorOptions.createLifecycle!({
      healthTimeoutMs: 11,
      shutdownGraceMs: 12,
      bridgeGraceMs: 13,
      crashWindowMs: 14,
      maxCrashRestarts: 15,
    }, seedLaunch)
    expect(compositionMocks.createHostLifecycle).toHaveBeenLastCalledWith({
      healthTimeoutMs: 11,
      shutdownGraceMs: 12,
      bridgeGraceMs: 13,
      crashWindowMs: 14,
      maxCrashRestarts: 15,
      isPidAlive: expect.any(Function),
      observeBridgeBootId,
      notifyRestartPlanned: expect.any(Function),
    })
    const lifecycleOptions = compositionMocks.createHostLifecycle.mock.calls.at(-1)?.[0] as {
      isPidAlive: (pid: number) => boolean
    }
    expect(lifecycleOptions.isPidAlive(seedLaunch.pid)).toBe(true)
    expect(lifecycleOptions.isPidAlive(seedLaunch.pid)).toBe(false)
  })

  it('dispatches validated modes to composition adapters', async () => {
    const serve = vi.fn(async () => undefined)
    const handoff = vi.fn(async () => undefined)
    await runSupervisorCli(['--serve', '--profile', 'web'], { serve, handoff })
    expect(serve).toHaveBeenCalledWith({ mode: 'serve', profile: 'web' })
    expect(handoff).not.toHaveBeenCalled()

    await runSupervisorCli(['--handoff', '--profile', 'dev'], { serve, handoff })
    expect(handoff).toHaveBeenCalledWith({ mode: 'handoff', profile: 'dev' })
  })

  it('does not invoke composition when validation fails', async () => {
    const serve = vi.fn(async () => undefined)
    await expect(runSupervisorCli(['$(echo pwned)'], { serve, handoff: vi.fn() })).rejects.toThrow(/unknown/i)
    expect(serve).not.toHaveBeenCalled()
  })

  it('creates and reuses a private bounded supervisor token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-cli-token-'))
    const paths = await resolveRuntimePaths({ dshHome: home, profile: 'web' })
    const first = await loadOrCreateSupervisorToken(paths)
    const second = await loadOrCreateSupervisorToken(paths)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
    expect((await readFile(paths.tokenFile, 'utf8')).trim()).toBe(first)
    if (process.platform !== 'win32') {
      expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600)
    }
  })

  it('composes authenticated serve startup, adopts hello, forwards commands, and cleans up on host stop', async () => {
    const calls: string[] = []
    let listenOptions!: ListenForBridgesOptions
    let signalHandler!: () => void
    let hostExitHandler!: () => void
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-compose-')),
      profile: 'web',
    })
    const lease: LockLease = {
      record: { pid: process.pid, startedAt: 1, instanceId: 'instance', endpoint: paths.endpoint },
      release: vi.fn(async () => { calls.push('lock-release') }),
    }
    const server: IpcServer = {
      endpoint: paths.endpoint,
      closed: false,
      connectionCount: 0,
      broadcast: vi.fn(async () => undefined),
      close: vi.fn(async () => { calls.push('ipc-close') }),
    }
    let publicStatus: DevReloaderSupervisor['status'] = { phase: 'starting', changedAt: 1 }
    const supervisor: DevReloaderSupervisor = {
      get status() { return publicStatus },
      start: vi.fn(async () => { calls.push('supervisor-start') }),
      bridgeConnected: vi.fn(async () => { calls.push('bridge-connected') }),
      prepareBridge: vi.fn(() => { calls.push('prepare-bridge') }),
      observeUnexpectedExit: vi.fn(async () => undefined),
      handleBridgeEvent: vi.fn(async event => {
        if (event.type === 'host-disposing') publicStatus = { phase: 'paused', changedAt: 2 }
      }),
      requestRestart: vi.fn(async () => undefined),
      updateConfig: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      close: vi.fn(async () => { calls.push('supervisor-close') }),
    }
    const runtime: SupervisorCliRuntime = {
      resolvePaths: vi.fn(async () => { calls.push('paths'); return paths }),
      acquireLock: vi.fn(async () => { calls.push('lock'); return lease }),
      loadToken: vi.fn(async () => { calls.push('token'); return 'a'.repeat(64) }),
      createSupervisor: vi.fn(() => { calls.push('create-supervisor'); return supervisor }),
      listen: vi.fn(async options => { calls.push('ipc'); listenOptions = options; return server }),
      installSignalHandlers: vi.fn(handler => {
        calls.push('signals')
        signalHandler = handler
        return () => { calls.push('signals-remove') }
      }),
      watchHostExit: vi.fn((_pid, handler) => {
        hostExitHandler = handler
        return () => undefined
      }),
      handoff: vi.fn(async () => undefined),
    }
    const service = runSupervisorCli(
      ['--serve', '--profile', 'web'],
      createSupervisorCliAdapters(runtime),
    )
    await vi.waitFor(() => expect(runtime.listen).toHaveBeenCalledOnce())
    expect(calls.slice(0, 6)).toEqual(['paths', 'signals', 'lock', 'token', 'create-supervisor', 'ipc'])

    const launch = {
      pid: 41,
      bootId: 'boot-a',
      nodeExecutable: '/node',
      execArgv: [] as string[],
      argv: ['/dsh', 'web'],
      cwd: '/repo',
      env: {},
      profile: 'web',
      webUrl: 'http://127.0.0.1:1',
    }
    const hello: BridgeHello = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'bridge-hello',
      hostPid: launch.pid,
      bootId: launch.bootId,
      launch,
      clientNonce: 'b'.repeat(64),
      clientProof: 'c'.repeat(64),
    }
    await expect(listenOptions.validateHost(hello)).resolves.toBe(true)
    await expect(listenOptions.validateHost(hello)).resolves.toBe(true)
    expect(supervisor.start).toHaveBeenCalledOnce()
    expect(supervisor.bridgeConnected).toHaveBeenCalledOnce()
    expect(runtime.watchHostExit).toHaveBeenCalledWith(launch.pid, expect.any(Function))
    hostExitHandler()
    await vi.waitFor(() => expect(supervisor.observeUnexpectedExit).toHaveBeenCalledWith(launch.pid))

    await listenOptions.onEvent({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }, {
      hello: { ...hello, hostPid: launch.pid + 1 },
      send: vi.fn(async () => undefined),
    })
    await listenOptions.onEvent({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }, {
      hello: { ...hello, bootId: 'stale-boot' },
      send: vi.fn(async () => undefined),
    })
    expect(supervisor.handleBridgeEvent).not.toHaveBeenCalled()

    await listenOptions.onEvent({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }, {
      hello,
      send: vi.fn(async () => undefined),
    })
    expect(supervisor.handleBridgeEvent).toHaveBeenCalledOnce()
    await listenOptions.onCommand?.({
      protocolVersion: PROTOCOL_VERSION,
      type: 'rebuild',
      requestId: 'r1',
    }, { hello, send: vi.fn(async () => undefined) })
    expect(supervisor.rebuild).toHaveBeenCalledOnce()

    await listenOptions.onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'host-disposing',
      hostPid: launch.pid,
    }, { hello, send: vi.fn(async () => undefined) })
    const stoppedBeforeSignal = await Promise.race([
      service.then(() => true),
      new Promise<false>(resolve => setImmediate(resolve, false)),
    ])
    if (!stoppedBeforeSignal) {
      signalHandler()
      await service
    }
    expect(stoppedBeforeSignal).toBe(true)
    expect(calls.slice(-4)).toEqual(['supervisor-close', 'ipc-close', 'lock-release', 'signals-remove'])
  })

  it('returns the stop command result before closing the IPC server', async () => {
    const calls: string[] = []
    let listenOptions!: ListenForBridgesOptions
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-stop-reply-')),
      profile: 'web',
    })
    const supervisor: DevReloaderSupervisor = {
      status: { phase: 'watching', changedAt: 1 },
      start: async () => undefined,
      bridgeConnected: async () => undefined,
      prepareBridge: () => undefined,
      observeUnexpectedExit: async () => undefined,
      handleBridgeEvent: async () => undefined,
      requestRestart: async () => undefined,
      updateConfig: async () => undefined,
      rebuild: async () => undefined,
      pause: async () => undefined,
      stop: async () => { calls.push('supervisor-stop') },
      close: async () => { calls.push('supervisor-close') },
    }
    const runtime: SupervisorCliRuntime = {
      resolvePaths: async () => paths,
      acquireLock: async () => ({
        record: { pid: process.pid, startedAt: 1, instanceId: 'i', endpoint: paths.endpoint },
        release: async () => { calls.push('lock-release') },
      }),
      loadToken: async () => 'a'.repeat(64),
      createSupervisor: () => supervisor,
      listen: async options => {
        listenOptions = options
        return {
          endpoint: paths.endpoint,
          closed: false,
          connectionCount: 1,
          broadcast: async () => undefined,
          close: async () => { calls.push('ipc-close') },
        }
      },
      installSignalHandlers: () => () => undefined,
      watchHostExit: () => () => undefined,
      handoff: async () => undefined,
    }
    const service = runSupervisorCli(
      ['--serve', '--profile', 'web'],
      createSupervisorCliAdapters(runtime),
    )
    await vi.waitFor(() => expect(listenOptions).toBeDefined())
    const hello = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'bridge-hello' as const,
      hostPid: 41,
      bootId: 'boot-a',
      launch: {
        pid: 41,
        bootId: 'boot-a',
        nodeExecutable: '/node',
        execArgv: [],
        argv: ['/dsh', 'web'],
        cwd: '/repo',
        env: {},
        profile: 'web',
        webUrl: 'http://127.0.0.1:1',
      },
      clientNonce: 'b'.repeat(64),
      clientProof: 'c'.repeat(64),
    }

    await listenOptions.validateHost(hello)
    const result = await listenOptions.onCommand!({
      protocolVersion: PROTOCOL_VERSION,
      type: 'stop',
      requestId: 'stop-1',
    }, { hello, send: async () => undefined }).then(value => {
      calls.push('command-result')
      return value
    })

    expect(result).toEqual({ ok: true })
    expect(calls).not.toContain('ipc-close')
    await service
    expect(calls.indexOf('command-result')).toBeLessThan(calls.indexOf('ipc-close'))
  })

  it('unwinds partial serve startup in exact reverse order and keeps handoff injected', async () => {
    const calls: string[] = []
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-unwind-')),
      profile: 'web',
    })
    const runtime: SupervisorCliRuntime = {
      resolvePaths: async () => paths,
      acquireLock: async () => ({
        record: { pid: process.pid, startedAt: 1, instanceId: 'i', endpoint: paths.endpoint },
        release: async () => { calls.push('lock-release') },
      }),
      loadToken: async () => 'a'.repeat(64),
      createSupervisor: () => {
        calls.push('supervisor-create')
        return {
          status: { phase: 'starting', changedAt: 1 },
          start: async () => undefined,
          bridgeConnected: async () => undefined,
          observeUnexpectedExit: async () => undefined,
          handleBridgeEvent: async () => undefined,
          requestRestart: async () => undefined,
          updateConfig: async () => undefined,
          rebuild: async () => undefined,
          pause: async () => undefined,
          stop: async () => undefined,
          close: async () => { calls.push('supervisor-close') },
        }
      },
      listen: async () => { throw new Error('bind failed') },
      installSignalHandlers: () => () => { calls.push('signals-remove') },
      watchHostExit: () => () => undefined,
      handoff: vi.fn(async () => { calls.push('handoff') }),
    }
    const adapters = createSupervisorCliAdapters(runtime)
    await expect(runSupervisorCli(['--serve', '--profile', 'web'], adapters)).rejects.toThrow('bind failed')
    expect(calls).toEqual(['supervisor-create', 'supervisor-close', 'lock-release', 'signals-remove'])

    await runSupervisorCli(['--handoff', '--profile', 'web'], adapters)
    expect(runtime.handoff).toHaveBeenCalledWith({ mode: 'handoff', profile: 'web' })
  })

  it('rejects commands from a stale bridge generation without executing them', async () => {
    const calls: string[] = []
    let listenOptions!: ListenForBridgesOptions
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-generation-')),
      profile: 'web',
    })
    const supervisor: DevReloaderSupervisor = {
      status: { phase: 'watching', changedAt: 1 },
      start: async () => undefined,
      bridgeConnected: async () => undefined,
      prepareBridge: () => undefined,
      observeUnexpectedExit: async () => undefined,
      handleBridgeEvent: async () => undefined,
      requestRestart: async () => { calls.push('restart') },
      updateConfig: async () => { calls.push('update-config') },
      rebuild: async () => undefined,
      pause: async () => undefined,
      stop: async () => { calls.push('stop') },
      close: async () => undefined,
    }
    const runtime: SupervisorCliRuntime = {
      resolvePaths: async () => paths,
      acquireLock: async () => ({
        record: { pid: process.pid, startedAt: 1, instanceId: 'i', endpoint: paths.endpoint },
        release: async () => undefined,
      }),
      loadToken: async () => 'a'.repeat(64),
      createSupervisor: () => supervisor,
      listen: async options => {
        listenOptions = options
        return {
          endpoint: paths.endpoint,
          closed: false,
          connectionCount: 1,
          broadcast: async () => undefined,
          close: async () => undefined,
        }
      },
      installSignalHandlers: () => () => undefined,
      watchHostExit: () => () => undefined,
      handoff: async () => undefined,
    }
    const service = runSupervisorCli(
      ['--serve', '--profile', 'web'],
      createSupervisorCliAdapters(runtime),
    )
    await vi.waitFor(() => expect(listenOptions).toBeDefined())

    const launch = {
      pid: 41,
      bootId: 'boot-a',
      nodeExecutable: '/node',
      execArgv: [] as string[],
      argv: ['/dsh', 'web'],
      cwd: '/repo',
      env: {},
      profile: 'web',
      webUrl: 'http://127.0.0.1:1',
    }
    const hello: BridgeHello = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'bridge-hello',
      hostPid: launch.pid,
      bootId: launch.bootId,
      launch,
      clientNonce: 'b'.repeat(64),
      clientProof: 'c'.repeat(64),
    }
    await listenOptions.validateHost(hello)
    const send = vi.fn(async () => undefined)

    const matching = await listenOptions.onCommand!({
      protocolVersion: PROTOCOL_VERSION,
      type: 'restart',
      requestId: 'match-1',
    }, { hello, send })
    expect(matching).toEqual({ ok: true })
    expect(calls).toContain('restart')
    calls.length = 0

    for (const [type, requestId] of [
      ['restart', 'stale-1'],
      ['update-config', 'stale-2'],
      ['stop', 'stale-3'],
    ] as const) {
      const stale = await listenOptions.onCommand!({
        protocolVersion: PROTOCOL_VERSION,
        type,
        requestId,
        ...(type === 'update-config' ? { config: { enabled: true } as never } : {}),
      } as Parameters<NonNullable<ListenForBridgesOptions['onCommand']>>[0], {
        hello: { ...hello, bootId: 'stale-boot' },
        send,
      })
      expect(stale).toEqual({ ok: false, error: 'stale bridge generation' })
    }
    expect(calls).toEqual([])

    await listenOptions.onCommand!({
      protocolVersion: PROTOCOL_VERSION,
      type: 'stop',
      requestId: 'stop-real',
    }, { hello, send })
    await service
    expect(calls).toContain('stop')
  })

  it('installs signal handlers before acquiring the supervisor lock', async () => {
    const calls: string[] = []
    let signalHandler!: () => void
    const paths = await resolveRuntimePaths({
      dshHome: await mkdtemp(join(tmpdir(), 'dsh-cli-signals-')),
      profile: 'web',
    })
    const supervisor: DevReloaderSupervisor = {
      status: { phase: 'starting', changedAt: 1 },
      start: async () => undefined,
      bridgeConnected: async () => undefined,
      prepareBridge: () => undefined,
      observeUnexpectedExit: async () => undefined,
      handleBridgeEvent: async () => undefined,
      requestRestart: async () => undefined,
      updateConfig: async () => undefined,
      rebuild: async () => undefined,
      pause: async () => undefined,
      stop: async () => undefined,
      close: async () => undefined,
    }
    const runtime: SupervisorCliRuntime = {
      resolvePaths: async () => { calls.push('paths'); return paths },
      acquireLock: async () => {
        calls.push('lock')
        return { record: { pid: process.pid, startedAt: 1, instanceId: 'i', endpoint: paths.endpoint }, release: async () => undefined }
      },
      loadToken: async () => { calls.push('token'); return 'a'.repeat(64) },
      createSupervisor: () => { calls.push('create'); return supervisor },
      listen: async () => {
        calls.push('ipc')
        return { endpoint: paths.endpoint, closed: false, connectionCount: 1, broadcast: async () => undefined, close: async () => undefined }
      },
      installSignalHandlers: handler => {
        calls.push('signals')
        signalHandler = handler
        return () => undefined
      },
      watchHostExit: () => () => undefined,
      handoff: async () => undefined,
    }
    const service = runSupervisorCli(
      ['--serve', '--profile', 'web'],
      createSupervisorCliAdapters(runtime),
    )
    await vi.waitFor(() => expect(calls).toContain('signals'))
    expect(calls.indexOf('signals')).toBeLessThan(calls.indexOf('lock'))

    signalHandler()
    await service
  })

  it('does not retire the old endpoint when the standby aborts during freeze', async () => {
    const beforeCommit = vi.fn(async () => undefined)
    const restoreAfterAbort = vi.fn(async () => undefined)
    const onCommitted = vi.fn()
    const commit = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const handoff = {
      phase: 'aborted' as const,
      prepare: vi.fn(async () => undefined),
      freeze: vi.fn(async () => undefined),
      commit,
      abort: vi.fn(async () => undefined),
    }
    const supervisor = {
      handoff: vi.fn(() => handoff),
    } as unknown as DevReloaderSupervisor
    const runtime = {
      spawnStandby: vi.fn(() => ({ pid: 123 })),
      connectHandoff: vi.fn(async () => ({ channel: {}, close })),
      acquireLock: vi.fn(),
    } as unknown as SupervisorCliRuntime

    await cliModule.runLeadHandoff({
      runtime,
      profile: 'web',
      paths: { platform: process.platform, profile: 'web', stateDir: tmpdir() } as never,
      token: 'a'.repeat(64),
      supervisor,
      getLease: () => undefined,
      setLease: () => undefined,
      beforeCommit,
      restoreAfterAbort,
      onCommitted,
    })

    expect(beforeCommit).not.toHaveBeenCalled()
    expect(restoreAfterAbort).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('restores the old endpoint when retirement fails before commit', async () => {
    let phase: 'idle' | 'prepared' | 'frozen' | 'aborted' = 'idle'
    const recoveredLease = { release: vi.fn(async () => undefined) } as unknown as LockLease
    let lease: LockLease | undefined
    const abort = vi.fn(async () => {
      phase = 'aborted'
      lease = recoveredLease
    })
    const restoreAfterAbort = vi.fn(async () => undefined)
    const onCommitted = vi.fn()
    const close = vi.fn(async () => undefined)
    const handoff = {
      get phase() { return phase },
      prepare: vi.fn(async () => { phase = 'prepared' }),
      freeze: vi.fn(async () => { phase = 'frozen' }),
      commit: vi.fn(async () => undefined),
      abort,
    }
    const supervisor = {
      handoff: vi.fn(() => handoff),
    } as unknown as DevReloaderSupervisor
    const runtime = {
      spawnStandby: vi.fn(() => ({ pid: 123 })),
      connectHandoff: vi.fn(async () => ({ channel: {}, close })),
      acquireLock: vi.fn(),
    } as unknown as SupervisorCliRuntime

    await expect(cliModule.runLeadHandoff({
      runtime,
      profile: 'web',
      paths: { platform: process.platform, profile: 'web', stateDir: tmpdir() } as never,
      token: 'a'.repeat(64),
      supervisor,
      getLease: () => lease,
      setLease: next => { lease = next },
      beforeCommit: async () => { throw new Error('endpoint close failed') },
      restoreAfterAbort,
      onCommitted,
    })).rejects.toThrow('endpoint close failed')

    expect(abort).toHaveBeenCalledOnce()
    expect(restoreAfterAbort).toHaveBeenCalledOnce()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})
