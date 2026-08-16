import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SUPERVISOR_CONFIG } from '../shared/config.js';
import { requireSafeProfileName } from '../shared/profile.js';
import { PROTOCOL_VERSION, } from '../shared/protocol.js';
import { discoverProjects } from './discovery.js';
import { connectForHandoff, createHandoffFollow, listenForHandoff, resolveHandoffEndpoint, } from './handoff.js';
import { listenForBridges, } from './ipc.js';
import { acquireSupervisorLock } from './lock.js';
import { createHostLifecycle } from './lifecycle.js';
import { removeStaleSupervisorSocket, resolveRuntimePaths, writePrivateFileAtomic, } from './paths.js';
import { createCommandRunner } from './runner.js';
import { createChangeScheduler } from './scheduler.js';
import { createSupervisor, } from './supervisor.js';
import { createTaskGate } from './task-gate.js';
import { createWatchPlanController } from './watcher.js';
const MAX_TOKEN_FILE_BYTES = 256;
export function parseCliArguments(argv) {
    let mode;
    let profile;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--serve' || argument === '--handoff') {
            const nextMode = argument === '--serve' ? 'serve' : 'handoff';
            if (mode !== undefined)
                throw new Error('exactly one supervisor mode is required');
            mode = nextMode;
            continue;
        }
        if (argument === '--profile') {
            if (profile !== undefined)
                throw new Error('profile may be specified only once');
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new Error('profile requires a value');
            }
            profile = requireSafeProfileName(value);
            index += 1;
            continue;
        }
        throw new Error(`unknown supervisor argument: ${argument}`);
    }
    if (mode === undefined)
        throw new Error('exactly one supervisor mode is required');
    if (profile === undefined)
        throw new Error('profile is required');
    return { mode, profile };
}
function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
async function readSupervisorToken(paths) {
    let handle;
    try {
        const flags = paths.platform === 'win32'
            ? constants.O_RDONLY
            : constants.O_RDONLY | constants.O_NOFOLLOW;
        handle = await open(paths.tokenFile, flags);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_TOKEN_FILE_BYTES) {
            throw new Error('supervisor token file is not a bounded regular file');
        }
        if (paths.platform !== 'win32') {
            const uid = currentUid();
            if (uid !== undefined && metadata.uid !== uid) {
                throw new Error('supervisor token file is not owned by the current user');
            }
            if ((metadata.mode & 0o777) !== 0o600) {
                throw new Error('supervisor token file mode is not 0600');
            }
        }
        const token = (await handle.readFile({ encoding: 'utf8' })).trim();
        if (!/^[a-f0-9]{64}$/.test(token)) {
            throw new Error('supervisor token file is invalid');
        }
        return token;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        if (error.code === 'ELOOP') {
            throw new Error('supervisor token file must not be a symlink', { cause: error });
        }
        throw error;
    }
    finally {
        await handle?.close();
    }
}
/** Load the private instance credential, creating only the existing 0600 token contract. */
export async function loadOrCreateSupervisorToken(paths) {
    const existing = await readSupervisorToken(paths);
    if (existing !== undefined)
        return existing;
    const token = randomBytes(32).toString('hex');
    await writePrivateFileAtomic(paths.tokenFile, `${token}\n`, paths.platform);
    return await readSupervisorToken(paths) ?? token;
}
function defaultInstallSignalHandlers(handler) {
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
    };
}
function probePidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
function defaultWatchHostExit(pid, handler) {
    let closed = false;
    const timer = setInterval(() => {
        if (closed)
            return;
        try {
            process.kill(pid, 0);
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                return;
            closed = true;
            clearInterval(timer);
            handler();
        }
    }, 250);
    timer.unref();
    return () => {
        closed = true;
        clearInterval(timer);
    };
}
export function createDefaultSupervisor(context) {
    // A handoff-ready standby supplies its snapshot config so takeover reproduces
    // the old supervisor's exact behavior; a normal serve uses the defaults.
    const config = context.config ?? { ...DEFAULT_SUPERVISOR_CONFIG, profile: context.paths.profile };
    const runner = createCommandRunner({ secrets: [context.token] });
    const gate = createTaskGate();
    const createLifecycle = (nextConfig, seedLaunch) => {
        let trustedAdoptionPid = seedLaunch?.pid;
        return createHostLifecycle({
            shutdownGraceMs: nextConfig.shutdownGraceMs,
            bridgeGraceMs: nextConfig.bridgeGraceMs,
            healthTimeoutMs: nextConfig.healthTimeoutMs,
            crashWindowMs: nextConfig.crashWindowMs,
            maxCrashRestarts: nextConfig.maxCrashRestarts,
            isPidAlive: pid => {
                if (pid === trustedAdoptionPid) {
                    trustedAdoptionPid = undefined;
                    return true;
                }
                return probePidAlive(pid);
            },
            observeBridgeBootId: context.observeBridgeBootId,
            notifyRestartPlanned: (_oldBootId, expectedBootId) => context.publishEvent({
                protocolVersion: PROTOCOL_VERSION,
                type: 'restart-planned',
                bootId: expectedBootId,
            }),
        });
    };
    const lifecycle = createLifecycle(config);
    return createSupervisor({
        config,
        discover: (nextConfig, launch) => discoverProjects({
            dshHome: context.paths.dshHome,
            profile: nextConfig.profile,
            sourceRoots: nextConfig.sourceRoots,
            env: launch.env,
            argv: launch.argv,
            cwd: launch.cwd,
        }),
        createWatcher: createWatchPlanController,
        createScheduler: createChangeScheduler,
        runner,
        gate,
        lifecycle,
        createLifecycle,
        createBootId: randomUUID,
        publishStatus: context.publishStatus,
    });
}
function defaultRuntime() {
    const runtime = {
        resolvePaths: profile => resolveRuntimePaths({ profile }),
        acquireLock: paths => acquireSupervisorLock(paths),
        loadToken: loadOrCreateSupervisorToken,
        createSupervisor: createDefaultSupervisor,
        listen: listenForBridges,
        installSignalHandlers: defaultInstallSignalHandlers,
        watchHostExit: defaultWatchHostExit,
        listenHandoff: options => listenForHandoff(options),
        connectHandoff: options => connectForHandoff(options),
        spawnStandby: options => spawnStandbyProcess(options),
        handoff: args => runSupervisorHandoff(args, runtime),
    };
    return runtime;
}
const TRANSACTION_ID_ENV = 'DSH_HANDOFF_TRANSACTION_ID';
/** The standby supervisor process is a sibling of this one in `--handoff` mode. */
function spawnStandbyProcess(options) {
    const child = spawn(process.execPath, [supervisorCliEntry(), '--handoff', '--profile', options.profile], {
        env: { ...process.env, [TRANSACTION_ID_ENV]: options.transactionId },
        stdio: 'inherit',
        detached: false,
    });
    if (child.pid === undefined) {
        throw new Error('failed to spawn handoff standby supervisor');
    }
    return { pid: child.pid };
}
let cliEntry;
function supervisorCliEntry() {
    if (cliEntry === undefined) {
        // The built artifact is expected at lib/supervisor/cli.js (package `main`).
        cliEntry = resolveSupervisorCliEntry();
    }
    return cliEntry;
}
function resolveSupervisorCliEntry() {
    // Running from source (tsx/ts-node) yields cli.ts; the built artifact cli.js.
    return fileURLToPath(import.meta.url);
}
function sameLaunchIdentity(left, right) {
    return left.nodeExecutable === right.nodeExecutable
        && left.cwd === right.cwd
        && left.profile === right.profile
        && left.webUrl === right.webUrl
        && left.execArgv.length === right.execArgv.length
        && left.execArgv.every((value, index) => value === right.execArgv[index])
        && left.argv.length === right.argv.length
        && left.argv.every((value, index) => value === right.argv[index]);
}
export async function serveSupervisor(arguments_, runtime, seed) {
    const paths = await runtime.resolvePaths(arguments_.profile);
    let lease = seed?.lease;
    let supervisor;
    let server;
    let removeSignalHandlers;
    let removeHostExitWatcher;
    let bridgeBootId;
    let activeLaunch = seed?.launch;
    let helloTail = Promise.resolve();
    let resolveShutdown;
    const shutdown = new Promise(resolvePromise => { resolveShutdown = resolvePromise; });
    // Install signal handlers early so a SIGINT/SIGTERM during startup is
    // captured, resolves shutdown, and cleanup runs once the await below lands.
    removeSignalHandlers = runtime.installSignalHandlers(resolveShutdown);
    try {
        if (lease === undefined)
            lease = await runtime.acquireLock(paths);
        await removeStaleSupervisorSocket(paths);
        const token = await runtime.loadToken(paths);
        const publishEvent = async (event) => {
            await server?.broadcast(event);
        };
        supervisor = runtime.createSupervisor({
            ...(seed?.config === undefined ? {} : { config: seed.config }),
            paths,
            token,
            observeBridgeBootId: () => bridgeBootId,
            publishEvent,
            publishStatus: status => publishEvent({
                protocolVersion: PROTOCOL_VERSION,
                type: 'status',
                status,
            }),
        });
        const validateHost = hello => {
            let accepted = false;
            const admission = helloTail.then(async () => {
                if (hello.launch.profile !== arguments_.profile)
                    return;
                const previous = activeLaunch;
                if (previous !== undefined) {
                    if (!sameLaunchIdentity(previous, hello.launch))
                        return;
                    if (previous.pid !== hello.hostPid
                        && supervisor.status.phase !== 'restarting'
                        && supervisor.status.phase !== 'recovering'
                        && supervisor.status.phase !== 'failed')
                        return;
                }
                const priorBridgeBootId = bridgeBootId;
                bridgeBootId = hello.bootId;
                // Switch peer admission to the new generation before its handshake
                // completes so stale-generation events are dropped immediately, then
                // reset the activity gate synchronously (never on the mutation tail).
                activeLaunch = hello.launch;
                supervisor.prepareBridge(hello.launch);
                try {
                    if (previous === undefined) {
                        await supervisor.start(hello.launch);
                    }
                    else {
                        // The first supervisor start must complete before auth (the tail is
                        // idle then). A reconnect during a long-running mutation (e.g. a
                        // restart holding the serialized tail for the whole health window)
                        // must NOT block the bridge handshake: the client's auth timeout is
                        // shorter than that window, so awaiting `bridgeConnected` here would
                        // strand the replacement bridge. Adopt in the background instead;
                        // the adopt work is quick and runs once the tail is free, and
                        // bridgeBootId is already published for the health check.
                        void supervisor.bridgeConnected(hello.launch).catch(error => {
                            // A failed adoption is surfaced by the next hello; never throw
                            // from the background path.
                            bridgeBootId = priorBridgeBootId;
                            void error;
                        });
                    }
                }
                catch (error) {
                    bridgeBootId = priorBridgeBootId;
                    throw error;
                }
                removeHostExitWatcher?.();
                removeHostExitWatcher = runtime.watchHostExit(hello.hostPid, () => {
                    void supervisor.observeUnexpectedExit(hello.hostPid).catch(() => undefined);
                });
                accepted = true;
            });
            helloTail = admission.then(() => undefined, () => undefined);
            return admission.then(() => accepted);
        };
        const bridgeOptions = {
            endpoint: paths.endpoint,
            token,
            validateHost,
            onEvent: async (event, peer) => {
                const current = activeLaunch;
                if (current === undefined
                    || peer.hello.hostPid !== current.pid
                    || peer.hello.bootId !== current.bootId)
                    return;
                await supervisor.handleBridgeEvent(event);
                if (event.type === 'host-disposing' && supervisor.status.phase === 'paused') {
                    resolveShutdown();
                }
            },
            onCommand: async (command, peer) => {
                const current = activeLaunch;
                if (current === undefined
                    || peer.hello.hostPid !== current.pid
                    || peer.hello.bootId !== current.bootId) {
                    return { ok: false, error: 'stale bridge generation' };
                }
                switch (command.type) {
                    case 'get-status':
                        await publishEvent({
                            protocolVersion: PROTOCOL_VERSION,
                            type: 'status',
                            status: supervisor.status,
                        });
                        return { ok: true };
                    case 'update-config':
                        if (command.config.enabled)
                            await supervisor.updateConfig(command.config);
                        else
                            await supervisor.pause();
                        return { ok: true };
                    case 'rebuild':
                        await supervisor.rebuild();
                        return { ok: true };
                    case 'restart':
                        await supervisor.requestRestart({ force: command.force, reason: 'IPC restart command' });
                        return { ok: true };
                    case 'pause':
                        await supervisor.pause();
                        return { ok: true };
                    case 'stop':
                        await supervisor.stop();
                        setTimeout(resolveShutdown, 0);
                        return { ok: true };
                    case 'handoff':
                        void runLeadHandoff({
                            runtime,
                            profile: arguments_.profile,
                            paths,
                            token,
                            supervisor: supervisor,
                            getLease: () => lease,
                            setLease: next => { lease = next; },
                            beforeCommit: async () => {
                                const activeServer = server;
                                server = undefined;
                                await activeServer?.close();
                            },
                            restoreAfterAbort: async () => {
                                server = await runtime.listen(bridgeOptions);
                            },
                            onCommitted: resolveShutdown,
                        }).catch(error => {
                            publishEvent({
                                protocolVersion: PROTOCOL_VERSION,
                                type: 'command-result',
                                requestId: command.requestId,
                                ok: false,
                                error: error instanceof Error ? error.message : String(error),
                            }).catch(() => undefined);
                        });
                        return { ok: true };
                }
            },
        };
        server = await runtime.listen(bridgeOptions);
        if (seed !== undefined) {
            // The standby never watches before commit; once committed, it starts
            // serving immediately from the in-memory handoff snapshot.
            await supervisor.start(seed.launch);
            removeHostExitWatcher = runtime.watchHostExit(seed.launch.pid, () => {
                void supervisor.observeUnexpectedExit(seed.launch.pid).catch(() => undefined);
            });
        }
        await shutdown;
    }
    finally {
        const failures = [];
        try {
            removeHostExitWatcher?.();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            await supervisor?.close();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            await server?.close();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            await lease?.release();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            removeSignalHandlers?.();
        }
        catch (error) {
            failures.push(error);
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'supervisor CLI cleanup failed');
        }
    }
}
async function runSupervisorHandoff(arguments_, runtime) {
    const paths = await runtime.resolvePaths(arguments_.profile);
    const token = await runtime.loadToken(paths);
    // A lead may pin this standby to its own one-use transaction so both sides
    // rendezvous on the same endpoint; otherwise derive a fresh transaction id.
    const transactionId = process.env[TRANSACTION_ID_ENV] ?? randomBytes(16).toString('hex');
    const handoffEndpoint = resolveHandoffEndpoint(paths, transactionId);
    const handle = await runtime.listenHandoff({ endpoint: handoffEndpoint, token, transactionId });
    let committedLaunch;
    let committedConfig;
    let standbyLease;
    const follow = createHandoffFollow({
        acceptSnapshot: async (snapshot) => {
            if (snapshot.transactionId !== transactionId) {
                throw new Error('handoff transaction id does not match this standby');
            }
            committedLaunch = snapshot.launch;
            committedConfig = snapshot.config;
        },
        acquireOwnership: async () => {
            // Atomic takeover: the old released its lease at freeze, so this acquire is
            // the sole transition of endpoint ownership. Ambiguity is caught by the lock.
            standbyLease = await runtime.acquireLock(paths);
        },
        releaseOwnership: async () => {
            // On any abort/backoff after acquisition, release the lease so the lock is
            // never left poisoned for a later supervisor to recover cleanly.
            if (standbyLease === undefined)
                return;
            await standbyLease.release().catch(() => undefined);
            standbyLease = undefined;
        },
        verifyStillOwner: async () => standbyLease !== undefined,
        beginServing: async () => {
            if (committedLaunch === undefined || committedConfig === undefined) {
                throw new Error('cannot serve without a committed handoff snapshot');
            }
            await serveSupervisor({ mode: 'serve', profile: arguments_.profile }, runtime, {
                ...(standbyLease === undefined ? {} : { lease: standbyLease }),
                launch: committedLaunch,
                config: committedConfig,
            });
        },
    }, handle.channel);
    try {
        await follow.start();
    }
    finally {
        await handle.close();
    }
}
/**
 * Lead side of self-handoff, wired to the serve loop's `handoff` IPC command.
 * Captures the running snapshot, spawns a standby, authenticates, drives the
 * prepare→freeze→commit protocol, then exits the old process once committed.
 * Any earlier step aborts and resumes the old supervisor (or fails closed if the
 * released lease cannot be re-acquired).
 */
export async function runLeadHandoff(options) {
    const { runtime, profile, paths, token, supervisor, getLease, setLease, beforeCommit, restoreAfterAbort, onCommitted, } = options;
    const lockHooks = {
        transferOwnership: async () => {
            const lease = getLease();
            if (lease !== undefined) {
                await lease.release();
                setLease(undefined);
            }
        },
        reacquire: async () => {
            if (getLease() !== undefined)
                return true;
            const deadline = Date.now() + 15_000;
            for (;;) {
                try {
                    setLease(await runtime.acquireLock(paths));
                    return true;
                }
                catch {
                    if (Date.now() >= deadline)
                        return false;
                    // The standby releases asynchronously after consuming the abort. Retry
                    // within the protocol deadline instead of turning that normal ordering
                    // into a spurious fail-closed outcome.
                    await new Promise(settle => setTimeout(settle, 50));
                }
            }
        },
    };
    const transactionId = randomBytes(16).toString('hex');
    const handoffEndpoint = resolveHandoffEndpoint(paths, transactionId);
    runtime.spawnStandby({ profile, transactionId });
    // The standby binds its endpoint after spawning; retry connecting until it is
    // reachable so the lead never races the child's listen.
    let handle;
    const deadline = Date.now() + 15_000;
    for (;;) {
        try {
            handle = await runtime.connectHandoff({ endpoint: handoffEndpoint, token, transactionId });
            break;
        }
        catch (error) {
            if (Date.now() > deadline)
                throw error;
            await new Promise(settle => setTimeout(settle, 100));
        }
    }
    let handoff;
    let endpointRetired = false;
    let shouldShutdown = false;
    const failures = [];
    try {
        handoff = supervisor.handoff(handle.channel, lockHooks, { id: transactionId, generation: 1 });
        await handoff.prepare();
        await handoff.freeze();
        if (handoff.phase === 'frozen') {
            endpointRetired = true;
            await beforeCommit();
            await handoff.commit();
        }
    }
    catch (error) {
        failures.push(error);
        if (handoff?.phase === 'frozen') {
            try {
                await handoff.abort();
            }
            catch (abortError) {
                failures.push(abortError);
                shouldShutdown = true;
            }
            if (endpointRetired) {
                if (getLease() === undefined) {
                    shouldShutdown = true;
                }
                else if (!shouldShutdown) {
                    try {
                        await restoreAfterAbort();
                    }
                    catch (restoreError) {
                        failures.push(restoreError);
                        shouldShutdown = true;
                    }
                }
            }
        }
        else if (handoff?.phase === 'committed') {
            // Commit delivery is ambiguous: never restore the old endpoint and risk
            // two owners. Fail closed while the standby either serves or exits.
            shouldShutdown = true;
        }
    }
    try {
        await handle.close();
    }
    catch (error) {
        failures.push(error);
        if (handoff?.phase === 'committed')
            shouldShutdown = true;
    }
    if (handoff?.phase === 'committed')
        shouldShutdown = true;
    if (shouldShutdown)
        onCommitted();
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1) {
        throw new AggregateError(failures, 'supervisor handoff failed and recovery was incomplete');
    }
}
export function createSupervisorCliAdapters(runtime = defaultRuntime()) {
    return {
        serve: arguments_ => serveSupervisor(arguments_, runtime),
        handoff: arguments_ => runtime.handoff(arguments_),
    };
}
export async function runSupervisorCli(argv, adapters = createSupervisorCliAdapters()) {
    const arguments_ = parseCliArguments(argv);
    if (arguments_.mode === 'serve') {
        await adapters.serve(arguments_);
        return;
    }
    await adapters.handoff(arguments_);
}
const directEntry = process.argv[1] === undefined
    ? false
    : import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directEntry) {
    void runSupervisorCli(process.argv.slice(2)).catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`dsh-dev-reloader supervisor failed: ${detail}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map