import { describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js'
import type { SupervisorConfig } from '../../src/shared/config.js'
import type { IpcClient } from '../../src/supervisor/ipc.js'
import { createHostPlugin, type HostPluginDependencies } from '../../src/index.js'

const config: SupervisorConfig = {
  enabled: true,
  profile: 'web',
  sourceRoots: [],
  debounceMs: 250,
  healthTimeoutMs: 60_000,
  shutdownGraceMs: 10_000,
  bridgeGraceMs: 10_000,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  ignored: [],
  projectOverrides: [],
  logLevel: 'info',
}

function fakeClient(): IpcClient & {
  request: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    closed: false,
    request: vi.fn(async () => ({ requestId: 'req-1', ok: true })),
    emit: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

/** Fake cordis Context carrying the three required services plus effect/on/inject. */
function fakeContext() {
  const registeredRoutes: unknown[] = []
  const routeDisposers: (() => void)[] = []
  const webServer = {
    host: '127.0.0.1' as const,
    port: 12345,
    register: vi.fn((route: unknown) => {
      registeredRoutes.push(route)
      const disposer = vi.fn()
      routeDisposers.push(disposer)
      return disposer
    }),
  }
  const agents = { list: vi.fn(() => []), roots: vi.fn(() => []) }
  const jobs = {
    list: vi.fn(() => []),
    onJobsChanged: vi.fn((_listener: unknown) => () => {}),
  }
  const effectDisposers: ((() => void | Promise<void>) | undefined)[] = []
  let settingsInject: ((sctx: Record<string, unknown>) => void) | undefined

  const ctx = {
    webServer,
    agents,
    jobs,
    fiber: { state: 0 },
    effect: vi.fn((body: () => unknown) => {
      const disposer = body()
      if (disposer !== undefined) effectDisposers.push(disposer as () => void)
      return disposer
    }),
    on: vi.fn(() => () => {}),
    inject: vi.fn((deps: readonly string[], cb: (sctx: Record<string, unknown>) => void) => {
      if (deps.includes('settings')) settingsInject = cb
    }),
  }

  return {
    ctx,
    webServer,
    agents,
    jobs,
    effectDisposers,
    routeDisposers: routeDisposers as (() => void)[],
    registeredRoutes,
    settingsInject: (sctx: Record<string, unknown>) => settingsInject?.(sctx),
    hasSettingsInject: () => settingsInject !== undefined,
  }
}

/** Mutable fake settings scope so tests can simulate a committed config change. */
function fakeSettings(initial: SupervisorConfig) {
  let current = initial
  let watchCb: (() => void) | undefined

  const scope = {
    get: () => current,
    watch: vi.fn((cb: () => void) => {
      watchCb = cb
    }),
    change(next: SupervisorConfig): void {
      current = next
      watchCb?.()
    },
  }
  const register = vi.fn((_ns: unknown, _schema: unknown, options: { base: SupervisorConfig } & Record<string, unknown>) => {
    current = options.base as SupervisorConfig
    return scope
  })
  const describe = vi.fn(() => [{
    ns: 'dsh-dev-reloader',
    value: current,
    base: initial,
    user: {},
    revision: 0,
    applies: 'live',
  }])
  const mutate = vi.fn(async () => undefined)

  return { register, scope, describe, mutate, writable: true }
}

function deps(overrides: Partial<HostPluginDependencies> = {}): HostPluginDependencies {
  return {
    pid: 99,
    nodeExecutable: '/node',
    execArgv: [],
    argv: ['/dsh', 'web'],
    cwd: '/repo',
    env: {},
    randomBootId: () => 'boot-1',
    resolveRuntimePaths: vi.fn(async () => ({
      platform: 'darwin',
      dshHome: '/tmp/dsh',
      profile: 'web',
      stateDir: '/tmp/dsh/plugins/dsh-dev-reloader/web',
      endpoint: '/tmp/dsh/plugins/dsh-dev-reloader/web/supervisor.sock',
      endpointDir: '/tmp/dsh/plugins/dsh-dev-reloader/web',
      endpointDirKind: 'state' as const,
      tokenFile: '/tmp/dsh/plugins/dsh-dev-reloader/web/supervisor.token',
      lockFile: '/tmp/dsh/plugins/dsh-dev-reloader/web/supervisor.lock',
      guardFile: '/tmp/dsh/plugins/dsh-dev-reloader/web/supervisor.lock.guard',
      logFile: '/tmp/dsh/plugins/dsh-dev-reloader/web/supervisor.log',
    })),
    loadOrCreateToken: vi.fn(async () => 'a'.repeat(64)),
    ...overrides,
  }
}

describe('host plugin', () => {
  it('declares the expected Cordis name, inject list, and config schema', () => {
    const plugin = createHostPlugin(deps())
    expect(plugin.name).toBe('dsh-dev-reloader')
    expect(plugin.inject).toEqual(['webServer', 'agents', 'jobs'])
    expect(plugin.Config).toBeDefined()
  })

  it('registers one route set under the web server during apply', async () => {
    const f = fakeContext()
    const plugin = createHostPlugin(deps({ connectClient: async () => fakeClient() }))

    await plugin.apply(f.ctx, config)

    expect(f.webServer.register).toHaveBeenCalledTimes(3)
    const paths = f.registeredRoutes.map(r => (r as { path?: string }).path)
    expect(paths).toEqual([
      '/plugins/dsh-dev-reloader/status',
      '/plugins/dsh-dev-reloader/health',
      '/plugins/dsh-dev-reloader/command',
    ])
  })

  it('captures a HostLaunchSpec from process facts and the web server, and creates one supervisor connection', async () => {
    const f = fakeContext()
    const connectClient = vi.fn(async () => fakeClient())
    const plugin = createHostPlugin(deps({ connectClient: connectClient as never }))

    await plugin.apply(f.ctx, config)

    expect(connectClient).toHaveBeenCalledTimes(1)
    const [options] = connectClient.mock.calls[0] as [unknown]
    const opts = options as {
      endpoint: string
      hello: {
        hostPid: number
        bootId: string
        launch: { pid: number; profile: string; nodeExecutable: string; env: object }
      }
    }
    expect(opts.endpoint).toContain('supervisor.sock')
    expect(opts.hello.hostPid).toBe(99)
    expect(opts.hello.bootId).toBe('boot-1')
    expect(opts.hello.launch.pid).toBe(99)
    expect(opts.hello.launch.profile).toBe('web')
    expect(opts.hello.launch.nodeExecutable).toBe('/node')
    // Environment travels only in the in-memory launch spec of the IPC hello.
    expect(typeof opts.hello.launch.env).toBe('object')
  })

  it('spawns a detached supervisor when none is connectable, then connects', async () => {
    const f = fakeContext()
    const connectClient = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(fakeClient())
    const spawnChild = vi.fn(() => ({ pid: 12345, process: { unref: vi.fn() } }))
    const plugin = createHostPlugin(deps({
      connectClient: connectClient as never,
      spawnChild: spawnChild as never,
      connectRetryMs: 1,
      cliPath: '/pkg/lib/supervisor/cli.js',
    }))

    await plugin.apply(f.ctx, config)

    expect(spawnChild).toHaveBeenCalledTimes(1)
    expect(connectClient).toHaveBeenCalledTimes(2)
  })

  it('registers one settings namespace whose changes forward as update-config requests', async () => {
    const f = fakeContext()
    const client = fakeClient()
    const settings = fakeSettings(config)
    Object.assign(f.ctx, { settings })
    const plugin = createHostPlugin(deps({ connectClient: async () => client }))

    await plugin.apply(f.ctx, config)

    expect(f.hasSettingsInject()).toBe(true)
    f.settingsInject(f.ctx as never)
    expect(settings.register).toHaveBeenCalledTimes(1)
    const [ns] = settings.register.mock.calls[0] as [unknown]
    expect(ns).toBe('dsh-dev-reloader')
    expect(settings.describe).not.toHaveBeenCalled()
    expect(f.registeredRoutes.map(r => (r as { path?: string }).path)).toContain(
      '/plugins/dsh-dev-reloader/settings',
    )

    // The initial onChange pushes the current resolved config to the supervisor.
    expect(client.request).toHaveBeenCalled()
    const firstCall = client.request.mock.calls[0]?.[0] as { type: string; requestId: string; config?: SupervisorConfig }
    expect(firstCall.type).toBe('update-config')
    expect(firstCall.config?.enabled).toBe(true)
    expect(firstCall.requestId).toBeTruthy()
    expect(client.request.mock.calls.slice(0, 2).map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    )).toEqual(['update-config', 'get-status'])

    // A committed settings change (dynamic source) triggers another update-config.
    client.request.mockClear()
    settings.scope.change({ ...config, logLevel: 'debug' })
    await vi.waitFor(() => expect(client.request).toHaveBeenCalled())
    const changed = client.request.mock.calls.map((c: unknown[]) => c[0] as { type: string; config?: SupervisorConfig })[0]!
    expect(changed.type).toBe('update-config')
    expect(changed.config?.logLevel).toBe('debug')
  })

  it('sends a stop and closes the connection when the config is explicitly disabled', async () => {
    const f = fakeContext()
    const client = fakeClient()
    const settings = fakeSettings(config)
    Object.assign(f.ctx, { settings })
    const plugin = createHostPlugin(deps({ connectClient: async () => client }))

    await plugin.apply(f.ctx, config)
    f.settingsInject(f.ctx as never)

    client.request.mockClear()
    settings.scope.change({ ...config, enabled: false })

    await vi.waitFor(() => {
      const types = client.request.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)
      expect(types).toContain('stop')
    })
    await vi.waitFor(() => expect(client.close).toHaveBeenCalled())
  })

  it('disposal closes the supervisor connection without deleting the supervisor lock', async () => {
    const f = fakeContext()
    const client = fakeClient()
    const deleteLock = vi.fn(async () => undefined)
    const plugin = createHostPlugin(deps({
      connectClient: async () => client,
      deleteSupervisorLock: deleteLock,
    }))

    await plugin.apply(f.ctx, config)

    // Cordis fiber disposal runs every registered effect disposer.
    for (const disposer of f.effectDisposers) await disposer?.()

    expect(client.close).toHaveBeenCalledTimes(1)
    // Disposal cleanup must not delete the supervisor lock file.
    expect(deleteLock).not.toHaveBeenCalled()
  })
})

// A context that models the REAL Cordis mount ordering: the settings provider
// is already present when apply starts, so the settings bridge section fires its
// synchronous `onChange` DURING apply — before `bridge.start()` ever connects.
// It also captures the `ctx.on` handlers so tests can fire agent/status events.
function eventContext(settings: ReturnType<typeof fakeSettings>) {
  const registeredRoutes: unknown[] = []
  const routeDisposers: (() => void)[] = []
  const onHandlers: Record<string, () => void> = {}
  const webServer = {
    host: '127.0.0.1' as const,
    port: 12345,
    register: vi.fn((route: unknown) => {
      registeredRoutes.push(route)
      const disposer = vi.fn()
      routeDisposers.push(disposer)
      return disposer
    }),
  }
  const agents = { list: vi.fn(() => []), roots: vi.fn(() => []) }
  const jobsChangedHandlers: (() => void)[] = []
  const jobs = {
    list: vi.fn(() => []),
    onJobsChanged: vi.fn((listener: unknown) => {
      jobsChangedHandlers.push(listener as () => void)
      return () => {}
    }),
  }
  const effectDisposers: ((() => void | Promise<void>) | undefined)[] = []

  const ctx = {
    settings,
    webServer,
    agents,
    jobs,
    fiber: { state: 0 },
    effect: vi.fn((body: () => unknown) => {
      const disposer = body()
      if (disposer !== undefined) effectDisposers.push(disposer as () => void)
      return disposer
    }),
    on: vi.fn((event: string, handler: () => void) => {
      onHandlers[event] = handler
      return () => {}
    }),
    inject: vi.fn((deps: readonly string[], cb: (sctx: Record<string, unknown>) => void) => {
      if (deps.includes('settings')) cb(ctx as never)
    }),
  }

  return {
    ctx,
    webServer,
    registeredRoutes,
    effectDisposers: effectDisposers as (() => void)[],
    routeDisposers: routeDisposers as (() => void)[],
    fireAgentStatus: () => onHandlers['agent/status']?.(),
    fireJobsChanged: () => jobsChangedHandlers.forEach(handler => handler()),
  }
}

describe('host plugin quality blockers', () => {
  it('does not let a post-disable activity publication reject the agent/status handler', async () => {
    const settings = fakeSettings(config)
    const client = fakeClient()
    const h = eventContext(settings)
    const connectClient = vi.fn(async () => client)
    const plugin = createHostPlugin(deps({ connectClient: connectClient as never }))

    await plugin.apply(h.ctx, config)
    // Config is enabled: connection is live and must have spawned a client.
    expect(connectClient).toHaveBeenCalledTimes(1)

    // Disable: sends stop then closes the bridge.
    settings.scope.change({ ...config, enabled: false })
    await vi.waitFor(() => expect(client.close).toHaveBeenCalled())

    // A late agent/status publication must be swallowed by the bridge's catch,
    // not reject the Cordis event handler (the handler must not throw).
    expect(() => h.fireAgentStatus()).not.toThrow()
  })

  it('applies the stored non-default config to the supervisor after the connection resolves', async () => {
    const stored: SupervisorConfig = {
      ...config,
      sourceRoots: ['/repo/a', '/repo/b'],
      debounceMs: 500,
      ignored: ['/node_modules', '/dist'],
      projectOverrides: [{
        root: '/repo/plugin',
        build: { cwd: '/repo/plugin', args: ['-w'], executable: 'npm' },
        devWeb: { cwd: '/repo/plugin', executable: 'nx', args: ['run', 'dev'] },
      }],
      logLevel: 'debug',
    }
    const settings = fakeSettings(stored)
    const client = fakeClient()
    const h = eventContext(settings)
    const plugin = createHostPlugin(deps({ connectClient: async () => client }))

    // settings inject mounts synchronously before connect (real ordering), so
    // the registration-time onChange fires against a still-disconnected bridge.
    await plugin.apply(h.ctx, stored)

    // After the connection resolves, the supervisor must have received the
    // stored config — including sourceRoots/debounceMs/ignored/projectOverrides.
    const requests = client.request.mock.calls.map(c => c[0] as {
      type: string
      config?: SupervisorConfig
    }).filter(c => c.type === 'update-config')
    expect(requests.length).toBeGreaterThan(0)

    const pushed = requests[requests.length - 1]!.config!
    expect(pushed.sourceRoots).toEqual(['/repo/a', '/repo/b'])
    expect(pushed.debounceMs).toBe(500)
    expect(pushed.ignored).toEqual(['/node_modules', '/dist'])
    expect(pushed.projectOverrides).toEqual(stored.projectOverrides)
  })

  it('re-establishes the supervisor connection when the config is re-enabled after being disabled', async () => {
    const settings = fakeSettings(config)
    const clientA = fakeClient()
    const clientB = fakeClient()
    const clients = [clientA, clientB]
    let index = 0
    const connectClient = vi.fn(() => {
      const client = clients[index]!
      index += 1
      return Promise.resolve(client)
    })
    const h = eventContext(settings)
    const plugin = createHostPlugin(deps({ connectClient: connectClient as never }))

    await plugin.apply(h.ctx, config)
    expect(connectClient).toHaveBeenCalledTimes(1)

    // Disable closes the bridge.
    settings.scope.change({ ...config, enabled: false })
    await vi.waitFor(() => expect(clientA.close).toHaveBeenCalled())

    // Re-enabling must re-run the connect-or-spawn path, establishing a fresh
    // connection instead of silently updating a closed bridge.
    settings.scope.change({ ...config, enabled: true, logLevel: 'warn' })
    await vi.waitFor(() => {
      expect(connectClient).toHaveBeenCalledTimes(2)
    })

    // Every fresh authenticated connection applies config before synchronizing status.
    await vi.waitFor(() => {
      const types = clientB.request.mock.calls.map(
        (c: unknown[]) => (c[0] as { type: string }).type,
      )
      expect(types.slice(0, 2)).toEqual(['update-config', 'get-status'])
    })
  })
})
