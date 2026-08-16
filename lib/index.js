import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { PROTOCOL_VERSION } from './shared/protocol.js';
import { resolveRuntimePaths, } from './supervisor/paths.js';
import { loadOrCreateSupervisorToken } from './supervisor/cli.js';
import { connectToSupervisor, } from './supervisor/ipc.js';
import { BOOT_ID_ENV } from './supervisor/lifecycle.js';
import { createActivityObserver } from './bridge/activity.js';
import { createBridgeClient } from './bridge/client.js';
import { createBridgeRoutes } from './bridge/routes.js';
import { installSettingsBridgeSection } from './bridge/settings.js';
import { resolveSupervisorCli, spawnSupervisor, } from './bridge/spawn.js';
export const name = 'dsh-dev-reloader';
export const inject = ['webServer', 'agents', 'jobs'];
const ns = settingsNamespace('dsh-dev-reloader');
const projectOverride = () => z.object({
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
});
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
});
async function delay(ms) {
    await new Promise(resolvePromise => {
        const timer = setTimeout(resolvePromise, ms);
        timer.unref?.();
    });
}
function webServerUrl(host, port) {
    return `http://${host}:${port}`;
}
function boundedMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`;
}
function buildLaunch(deps, config, bootId, webUrl) {
    const env = deps.env ?? process.env;
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
    };
}
export function createHostPlugin(pluginDeps = {}) {
    return {
        name: 'dsh-dev-reloader',
        inject,
        Config,
        async apply(ctx, config) {
            const env = pluginDeps.env ?? process.env;
            const bootId = env[BOOT_ID_ENV] ?? (pluginDeps.randomBootId ?? randomUUID)();
            const webUrl = pluginDeps.webUrl
                ?? webServerUrl(ctx.webServer.host, ctx.webServer.port);
            const launch = buildLaunch(pluginDeps, config, bootId, webUrl);
            let requestCounter = 0;
            const createRequestId = () => (pluginDeps.createRequestId
                ? pluginDeps.createRequestId()
                : `dsh-bridge-${++requestCounter}`);
            const statusRef = {
                current: undefined,
            };
            const connectWithRetry = async (options) => {
                const connect = pluginDeps.connectClient ?? connectToSupervisor;
                try {
                    return await connect(options);
                }
                catch (error) {
                    const spawn = pluginDeps.spawnChild ?? spawnSupervisor;
                    spawn({
                        cliPath: pluginDeps.cliPath ?? resolveSupervisorCli(),
                        profile: config.profile,
                        env: launch.env,
                    });
                    const retries = pluginDeps.connectRetries ?? 10;
                    const retryMs = pluginDeps.connectRetryMs ?? 250;
                    let lastError = error;
                    for (let attempt = 0; attempt < retries; attempt += 1) {
                        await delay(retryMs);
                        try {
                            return await connect(options);
                        }
                        catch (retryError) {
                            lastError = retryError;
                        }
                    }
                    throw lastError;
                }
            };
            const paths = await (pluginDeps.resolveRuntimePaths ?? resolveRuntimePaths)({
                env,
                profile: config.profile,
            });
            const token = await (pluginDeps.loadOrCreateToken ?? loadOrCreateSupervisorToken)(paths);
            const bridge = createBridgeClient({
                connect: connectWithRetry,
                endpoint: paths.endpoint,
                token,
                hello: {
                    hostPid: launch.pid,
                    bootId,
                    launch,
                },
                onStatus: (status) => {
                    statusRef.current = status;
                },
            });
            const safeRequest = async (command) => {
                if (!bridge.connected) {
                    return { ok: false, requestId: '', error: 'supervisor is not connected' };
                }
                const requestId = createRequestId();
                const full = {
                    protocolVersion: PROTOCOL_VERSION,
                    ...command,
                    requestId,
                };
                try {
                    return await bridge.request(full);
                }
                catch (error) {
                    return { ok: false, requestId, error: boundedMessage(error) };
                }
            };
            const sourceRef = {
                current: () => config,
            };
            // Guards the connect-or-spawn path against concurrent triggers: while one
            // connection attempt is in flight every other caller shares that promise,
            // and a fresh connect applies the current config exactly once.
            let connectingBridge;
            async function ensureConnectedAndApply() {
                if (bridge.connected) {
                    const current = sourceRef.current();
                    if (current.enabled) {
                        await safeRequest({ type: 'update-config', config: current });
                    }
                    return;
                }
                if (connectingBridge !== undefined) {
                    // A connect is already in flight; it pushes the config on success.
                    await connectingBridge;
                    return;
                }
                connectingBridge = (async () => {
                    await bridge.start();
                    const current = sourceRef.current();
                    if (current.enabled) {
                        await safeRequest({ type: 'update-config', config: current });
                    }
                    // The supervisor may publish its first transition while the IPC hello is
                    // still being authenticated, before this peer is eligible for broadcasts.
                    // Ask once after connection so the Host route never stays on its fallback.
                    await safeRequest({ type: 'get-status' });
                })().finally(() => {
                    connectingBridge = undefined;
                });
                await connectingBridge;
            }
            async function onConfigChanged(next) {
                if (!next.enabled) {
                    await safeRequest({ type: 'stop' });
                    await bridge.close();
                    return;
                }
                try {
                    await ensureConnectedAndApply();
                }
                catch {
                    // A failed connect during a settings change must not reject the
                    // settings watcher; bound it the same way safeRequest does.
                }
            }
            installSettingsBridgeSection(ctx, ns, Config, config, (route) => ctx.webServer.register(route), {
                setSource(current) {
                    sourceRef.current = current;
                },
                onChange() {
                    void onConfigChanged(sourceRef.current());
                },
            });
            const routes = createBridgeRoutes({
                status: () => statusRef.current,
                bootId: () => bootId,
                sendCommand: (command) => bridge.request(command),
            });
            const activityOptions = {
                roots: () => ctx.agents.roots(),
                listAll: () => ctx.agents.list(),
                listJobs: (agent) => ctx.jobs.list(agent),
                subscribeAgentStatus: (handler) => ctx.on('agent/status', () => handler()),
                subscribeJobsChanged: (handler) => ctx.jobs.onJobsChanged(() => handler()),
                subscribeReload: (handler) => ctx.on('hmr/reload', handler),
                publish: (snapshot) => {
                    void bridge.emit({
                        protocolVersion: PROTOCOL_VERSION,
                        type: 'activity',
                        snapshot,
                    }).catch(() => undefined);
                },
                publishReload: (entries) => {
                    void bridge.emit({
                        protocolVersion: PROTOCOL_VERSION,
                        type: 'hmr-reload',
                        entries,
                    }).catch(() => undefined);
                },
                ...(pluginDeps.now === undefined ? {} : { now: pluginDeps.now }),
            };
            const activity = createActivityObserver(activityOptions);
            // Register the route set for the lifetime of this fiber.
            ctx.effect(() => {
                const routeDisposers = [
                    ctx.webServer.register(routes.status),
                    ctx.webServer.register(routes.health),
                    ctx.webServer.register(routes.command),
                ];
                return () => {
                    for (const disposer of routeDisposers)
                        disposer();
                };
            });
            // Observe agent activity for the lifetime of this fiber.
            ctx.effect(() => activity.start());
            // Explicitly stop the supervisor connection (with a planned-disposal
            // notice) when this fiber unloads. The supervisor lock is owned by the
            // supervisor process; the host bridge never deletes it.
            ctx.effect(() => () => {
                void bridge.emit({
                    protocolVersion: PROTOCOL_VERSION,
                    type: 'host-disposing',
                    hostPid: launch.pid,
                }).catch(() => undefined);
                void bridge.close();
            });
            // Connect-or-spawn (guard entry) and apply the current config to the
            // freshly connected supervisor so nothing queued before connect is dropped.
            await ensureConnectedAndApply();
        },
    };
}
/** The default Cordis host plugin instance. */
const plugin = createHostPlugin();
export default plugin;
//# sourceMappingURL=index.js.map