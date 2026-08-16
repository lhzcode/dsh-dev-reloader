import { randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  Context,
  Plugin,
} from '@deepseek-ai/cordis'

import type {
  ActivitySnapshot,
  HostLaunchSpec,
  PublicSupervisorStatus,
  SupervisorCommand,
} from './shared/protocol.js'
import { PROTOCOL_VERSION } from './shared/protocol.js'
import type { SupervisorConfig } from './shared/config.js'
import type { RuntimePathOptions, RuntimePaths } from './supervisor/paths.js'
import {
  resolveRuntimePaths,
} from './supervisor/paths.js'
import { loadOrCreateSupervisorToken } from './supervisor/cli.js'
import {
  connectToSupervisor,
  type ConnectToSupervisorOptions,
  type IpcClient,
} from './supervisor/ipc.js'
import { BOOT_ID_ENV } from './supervisor/lifecycle.js'
import { createActivityObserver } from './bridge/activity.js'
import { createBridgeClient } from './bridge/client.js'
import { createBridgeRoutes } from './bridge/routes.js'
import { installSettingsBridgeSection } from './bridge/settings.js'
import {
  resolveSupervisorCli,
  spawnSupervisor,
} from './bridge/spawn.js'

export const name = 'dsh-dev-reloader'
export const inject = ['webServer', 'agents', 'jobs']

const ns = settingsNamespace('dsh-dev-reloader')

const projectOverride = (): ReturnType<typeof z.object> => z.object({
  root: z.string().required(),
  build: z.object({
    executable: z.string().default('pnpm'),
    args: z.array(z.string()).default([]),
    cwd: z.string(),
  }),
  devWeb: z.object({
    executable: z.string().default('pnpm'),
    args: z.array(z.string()).default([]),
    cwd: z.string(),
  }),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  profile: z.string().default('web'),
  sourceRoots: z.array(z.string()).default([]),
  webUrl: z.string(),
  debounceMs: z.natural().default(250),
  healthTimeoutMs: z.natural().default(60_000),
  shutdownGraceMs: z.natural().default(10_000),
  bridgeGraceMs: z.natural().default(10_000),
  crashWindowMs: z.natural().default(60_000),
  maxCrashRestarts: z.natural().default(3),
  ignored: z.array(z.string()).default([]),
  projectOverrides: z.array(projectOverride()).default([]),
  logLevel: z.union(['debug', 'info', 'warn', 'error']).default('info'),
}) as unknown as z<SupervisorConfig>

export interface HostPluginDependencies {
  readonly pid?: number
  readonly nodeExecutable?: string
  readonly execArgv?: readonly string[]
  readonly argv?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly webUrl?: string
  readonly randomBootId?: () => string
  readonly now?: () => number
  readonly resolveRuntimePaths?: (options: RuntimePathOptions) => Promise<RuntimePaths>
  readonly loadOrCreateToken?: (paths: RuntimePaths) => Promise<string>
  readonly connectClient?: (options: ConnectToSupervisorOptions) => Promise<IpcClient>
  readonly spawnChild?: typeof spawnSupervisor
  readonly connectRetryMs?: number
  readonly connectRetries?: number
  readonly cliPath?: string
  readonly createRequestId?: () => string
  /** Test seam: disposal cleanup must never invoke this. */
  readonly deleteSupervisorLock?: (paths: RuntimePaths) => Promise<void>
}

export type HostPluginConfig = SupervisorConfig

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(resolvePromise, ms)
    timer.unref?.()
  })
}

function webServerUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`
}

function buildLaunch(
  deps: HostPluginDependencies,
  config: HostPluginConfig,
  bootId: string,
  webUrl: string,
): HostLaunchSpec {
  const env = deps.env ?? process.env
  return {
    pid: deps.pid ?? process.pid,
    bootId,
    nodeExecutable: deps.nodeExecutable ?? process.execPath,
    execArgv: deps.execArgv ?? process.execArgv,
    argv: deps.argv ?? process.argv.slice(1),
    cwd: deps.cwd ?? process.cwd(),
    env,
    profile: config.profile,
    webUrl,
  }
}

export function createHostPlugin(
  pluginDeps: HostPluginDependencies = {},
): Plugin {
  return {
    name: 'dsh-dev-reloader',
    inject,
    Config,
    async apply(ctx: Context, config: HostPluginConfig): Promise<void> {
      const env = pluginDeps.env ?? process.env
      const bootId = env[BOOT_ID_ENV] ?? (pluginDeps.randomBootId ?? randomUUID)()
      const webUrl = pluginDeps.webUrl
        ?? webServerUrl(ctx.webServer.host, ctx.webServer.port)
      const launch = buildLaunch(pluginDeps, config, bootId, webUrl)

      let requestCounter = 0
      const createRequestId = (): string => (
        pluginDeps.createRequestId
          ? pluginDeps.createRequestId()
          : `dsh-bridge-${++requestCounter}`
      )

      const statusRef: { current: PublicSupervisorStatus | undefined } = {
        current: undefined,
      }

      const connectWithRetry = async (options: ConnectToSupervisorOptions): Promise<IpcClient> => {
        const connect = pluginDeps.connectClient ?? connectToSupervisor
        try {
          return await connect(options)
        } catch (error) {
          const spawn = pluginDeps.spawnChild ?? spawnSupervisor
          spawn({
            cliPath: pluginDeps.cliPath ?? resolveSupervisorCli(),
            profile: config.profile,
            env: launch.env,
          })
          const retries = pluginDeps.connectRetries ?? 10
          const retryMs = pluginDeps.connectRetryMs ?? 250
          let lastError = error
          for (let attempt = 0; attempt < retries; attempt += 1) {
            await delay(retryMs)
            try {
              return await connect(options)
            } catch (retryError) {
              lastError = retryError
            }
          }
          throw lastError
        }
      }

      const paths = await (pluginDeps.resolveRuntimePaths ?? resolveRuntimePaths)({
        env,
        profile: config.profile,
      })
      const token = await (pluginDeps.loadOrCreateToken ?? loadOrCreateSupervisorToken)(
        paths,
      )

      const bridge = createBridgeClient({
        connect: connectWithRetry,
        endpoint: paths.endpoint,
        token,
        hello: {
          hostPid: launch.pid,
          bootId,
          launch,
        },
        onStatus: (status: PublicSupervisorStatus) => {
          statusRef.current = status
        },
      })

      const safeRequest = async (
        command: Omit<SupervisorCommand, 'requestId'>,
      ): Promise<{ ok: boolean; requestId: string; error?: string }> => {
        if (!bridge.connected) {
          return { ok: false, requestId: '', error: 'supervisor is not connected' }
        }
        const requestId = createRequestId()
        const full: SupervisorCommand = {
          protocolVersion: PROTOCOL_VERSION,
          ...command,
          requestId,
        } as SupervisorCommand
        try {
          return await bridge.request(full)
        } catch (error) {
          return { ok: false, requestId, error: boundedMessage(error) }
        }
      }

      const sourceRef: { current: () => HostPluginConfig } = {
        current: () => config,
      }
      // Guards the connect-or-spawn path against concurrent triggers: while one
      // connection attempt is in flight every other caller shares that promise,
      // and a fresh connect applies the current config exactly once.
      let connectingBridge: Promise<void> | undefined

      async function ensureConnectedAndApply(): Promise<void> {
        if (bridge.connected) {
          const current = sourceRef.current()
          if (current.enabled) {
            await safeRequest({ type: 'update-config', config: current })
          }
          return
        }
        if (connectingBridge !== undefined) {
          // A connect is already in flight; it pushes the config on success.
          await connectingBridge
          return
        }
        connectingBridge = (async () => {
          await bridge.start()
          const current = sourceRef.current()
          if (current.enabled) {
            await safeRequest({ type: 'update-config', config: current })
          }
          // The supervisor may publish its first transition while the IPC hello is
          // still being authenticated, before this peer is eligible for broadcasts.
          // Ask once after connection so the Host route never stays on its fallback.
          await safeRequest({ type: 'get-status' })
        })().finally(() => {
          connectingBridge = undefined
        })
        await connectingBridge
      }

      async function onConfigChanged(next: HostPluginConfig): Promise<void> {
        if (!next.enabled) {
          await safeRequest({ type: 'stop' })
          await bridge.close()
          return
        }
        try {
          await ensureConnectedAndApply()
        } catch {
          // A failed connect during a settings change must not reject the
          // settings watcher; bound it the same way safeRequest does.
        }
      }

      installSettingsBridgeSection(
        ctx,
        ns,
        Config,
        config as never,
        (route) => ctx.webServer.register(route),
        {
          setSource(current) {
            sourceRef.current = current as unknown as () => HostPluginConfig
          },
          onChange() {
            void onConfigChanged(sourceRef.current())
          },
        },
      )

      const routes = createBridgeRoutes({
        status: () => statusRef.current,
        bootId: () => bootId,
        sendCommand: (command) => bridge.request(command),
      })

      const activityOptions = {
        roots: () => ctx.agents.roots(),
        listAll: () => ctx.agents.list(),
        listJobs: (agent?: Agent) => ctx.jobs.list(agent),
        subscribeAgentStatus: (handler: () => void) => ctx.on('agent/status', () => handler()),
        subscribeJobsChanged: (handler: () => void) => ctx.jobs.onJobsChanged(() => handler()),
        subscribeReload: (handler: (reloads: ReadonlyMap<unknown, { filename: string }>) => void) => ctx.on('hmr/reload', handler),
        publish: (snapshot: ActivitySnapshot) => {
          void bridge.emit({
            protocolVersion: PROTOCOL_VERSION,
            type: 'activity',
            snapshot,
          }).catch(() => undefined)
        },
        publishReload: (entries: readonly string[]) => {
          void bridge.emit({
            protocolVersion: PROTOCOL_VERSION,
            type: 'hmr-reload',
            entries,
          }).catch(() => undefined)
        },
        ...(pluginDeps.now === undefined ? {} : { now: pluginDeps.now }),
      }

      const activity = createActivityObserver(activityOptions)

      // Register the route set for the lifetime of this fiber.
      ctx.effect(() => {
        const routeDisposers: (() => void)[] = [
          ctx.webServer.register(routes.status),
          ctx.webServer.register(routes.health),
          ctx.webServer.register(routes.command),
        ]
        return () => {
          for (const disposer of routeDisposers) disposer()
        }
      })

      // Observe agent activity for the lifetime of this fiber.
      ctx.effect(() => activity.start())

      // Explicitly stop the supervisor connection (with a planned-disposal
      // notice) when this fiber unloads. The supervisor lock is owned by the
      // supervisor process; the host bridge never deletes it.
      ctx.effect(() => () => {
        void bridge.emit({
          protocolVersion: PROTOCOL_VERSION,
          type: 'host-disposing',
          hostPid: launch.pid,
        }).catch(() => undefined)
        void bridge.close()
      })

      // Connect-or-spawn (guard entry) and apply the current config to the
      // freshly connected supervisor so nothing queued before connect is dropped.
      await ensureConnectedAndApply()
    },
  }
}

/** The default Cordis host plugin instance. */
const plugin: Plugin<HostPluginConfig> = createHostPlugin()
export default plugin
export type { Context }
