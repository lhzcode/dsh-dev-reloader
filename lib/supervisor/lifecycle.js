import { spawn as nodeSpawn, } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { waitForHostHealth, } from './health-check.js';
export const BOOT_ID_ENV = 'DSH_DEV_BOOT_ID';
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_BRIDGE_GRACE_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASH_RESTARTS = 3;
const DEFAULT_CRASH_BACKOFF_BASE_MS = 250;
export function createHostLifecycle(options = {}) {
    const shutdownGraceMs = duration(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 'shutdownGraceMs');
    const bridgeGraceMs = duration(options.bridgeGraceMs, DEFAULT_BRIDGE_GRACE_MS, 'bridgeGraceMs');
    const healthTimeoutMs = duration(options.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 'healthTimeoutMs');
    const crashWindowMs = duration(options.crashWindowMs, DEFAULT_CRASH_WINDOW_MS, 'crashWindowMs');
    const maxCrashRestarts = duration(options.maxCrashRestarts, DEFAULT_MAX_CRASH_RESTARTS, 'maxCrashRestarts');
    const backoffBase = duration(options.crashBackoffBaseMs, DEFAULT_CRASH_BACKOFF_BASE_MS, 'crashBackoffBaseMs');
    const spawn = options.spawn ?? nodeSpawn;
    const signalPid = options.signalPid ?? defaultSignalPid;
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    const waitForPortRelease = options.waitForPortRelease ?? defaultWaitForPortRelease;
    const healthCheck = options.waitForHealth ?? waitForHostHealth;
    const now = options.now ?? Date.now;
    const sleep = options.delay ?? delay;
    const createBootId = options.createBootId ?? randomUUID;
    const controller = new AbortController();
    const crashTimes = [];
    const bridgeGenerations = new Map();
    let current;
    let disposed = false;
    let mutationTail = Promise.resolve();
    let restartOperation;
    function assertActive() {
        if (disposed)
            throw new Error('host lifecycle is disposed');
    }
    function serialize(operation) {
        const result = mutationTail.then(operation, operation);
        mutationTail = result.then(() => undefined, () => undefined);
        return result;
    }
    function adopt(launch) {
        return serialize(async () => {
            assertActive();
            if (!isPidAlive(launch.pid)) {
                throw new Error(`cannot adopt missing host PID ${launch.pid}`);
            }
            const host = {
                pid: launch.pid,
                bootId: launch.bootId,
                launch: cloneLaunch(launch),
                source: 'adopted',
            };
            current = host;
            return host;
        });
    }
    async function restartOnce(request) {
        assertActive();
        const operationSignal = combineSignals(request.signal, controller.signal);
        throwIfAborted(operationSignal);
        if (current !== request.host) {
            if (current?.source === 'spawned' && isPidAlive(current.pid)) {
                // A crash-recovery replacement is still live; do not double-restart.
                throw new Error('replacement host is still running');
            }
            throw new Error('restart request targets a stale host generation');
        }
        if (current !== undefined && current.pid !== request.host.pid && isPidAlive(current.pid)) {
            throw new Error('replacement host is still running');
        }
        await options.notifyRestartPlanned?.(request.host.bootId, request.expectedBootId);
        throwIfAborted(operationSignal);
        if (isPidAlive(request.host.pid)) {
            await signalPid(request.host.pid, 'SIGTERM');
            const exited = await waitForPidExit(request.host.pid, shutdownGraceMs, isPidAlive, sleep, operationSignal);
            if (!exited) {
                await signalPid(request.host.pid, 'SIGKILL');
                const killed = await waitForPidExit(request.host.pid, shutdownGraceMs, isPidAlive, sleep, operationSignal);
                if (!killed)
                    throw new Error(`host PID ${request.host.pid} survived SIGKILL`);
            }
        }
        await waitForPortRelease(request.host.launch.webUrl, shutdownGraceMs, operationSignal);
        const replacement = spawnHost(request.host.launch, request.expectedBootId, spawn);
        current = replacement;
        const health = await healthCheck({
            webUrl: request.host.launch.webUrl,
            expectedBootId: request.expectedBootId,
            timeoutMs: healthTimeoutMs,
            observeBridgeBootId: options.observeBridgeBootId ?? (() => undefined),
            signal: operationSignal,
        });
        if (!health.healthy)
            throw new Error('replacement host is unhealthy');
        return { host: replacement, health };
    }
    return {
        adopt,
        restart(request) {
            if (restartOperation !== undefined) {
                if (restartOperation.host === request.host
                    && restartOperation.expectedBootId === request.expectedBootId)
                    return restartOperation.promise;
                return Promise.reject(new Error('restart already in progress with a conflicting request'));
            }
            const operation = serialize(() => restartOnce(request));
            const wrapped = operation.finally(() => {
                if (restartOperation?.promise === wrapped)
                    restartOperation = undefined;
            });
            restartOperation = {
                host: request.host,
                expectedBootId: request.expectedBootId,
                promise: wrapped,
            };
            return wrapped;
        },
        observeUnexpectedExit(host, signal) {
            return serialize(async () => {
                assertActive();
                const operationSignal = combineSignals(signal, controller.signal);
                throwIfAborted(operationSignal);
                if (current !== host)
                    return 'restarted';
                if (isPidAlive(host.pid))
                    throw new Error(`host PID ${host.pid} is still running`);
                const at = now();
                while (crashTimes.length > 0 && at - crashTimes[0] > crashWindowMs)
                    crashTimes.shift();
                if (crashTimes.length >= maxCrashRestarts)
                    return 'circuit-open';
                crashTimes.push(at);
                const backoff = Math.min(30_000, backoffBase * (2 ** (crashTimes.length - 1)));
                await sleep(backoff, operationSignal);
                throwIfAborted(operationSignal);
                if (current !== host)
                    return 'restarted';
                await waitForPortRelease(host.launch.webUrl, shutdownGraceMs, operationSignal);
                throwIfAborted(operationSignal);
                if (current !== host)
                    return 'restarted';
                const expectedBootId = createBootId();
                const replacement = spawnHost(host.launch, expectedBootId, spawn);
                current = replacement;
                const health = await healthCheck({
                    webUrl: host.launch.webUrl,
                    expectedBootId,
                    timeoutMs: healthTimeoutMs,
                    observeBridgeBootId: options.observeBridgeBootId ?? (() => undefined),
                    signal: operationSignal,
                });
                if (!health.healthy && isPidAlive(replacement.pid)) {
                    throw new Error('replacement host is unhealthy');
                }
                if (!health.healthy)
                    throw new Error('replacement host exited before becoming healthy');
                return 'restarted';
            });
        },
        async observeHostDisposing(host, signal) {
            assertActive();
            const operationSignal = combineSignals(signal, controller.signal);
            if (!isPidAlive(host.pid))
                return 'stopped';
            const generation = (bridgeGenerations.get(host.pid) ?? 0) + 1;
            bridgeGenerations.set(host.pid, generation);
            await sleep(bridgeGraceMs, operationSignal);
            throwIfAborted(operationSignal);
            if (!isPidAlive(host.pid))
                return 'stopped';
            return bridgeGenerations.get(host.pid) !== generation ? 'reconnected' : 'bridge-timeout';
        },
        observeBridgeConnected(host) {
            if (disposed)
                return;
            bridgeGenerations.set(host.pid, (bridgeGenerations.get(host.pid) ?? 0) + 1);
        },
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            controller.abort();
            await mutationTail;
            bridgeGenerations.clear();
            current = undefined;
        },
    };
}
function spawnHost(launch, bootId, spawn) {
    const child = spawn(launch.nodeExecutable, [...launch.execArgv, ...launch.argv], {
        shell: false,
        cwd: launch.cwd,
        env: { ...launch.env, [BOOT_ID_ENV]: bootId },
        ...(process.platform === 'win32' ? {} : { detached: true }),
    });
    if (child.pid === undefined)
        throw new Error('replacement host did not receive a PID');
    return {
        pid: child.pid,
        bootId,
        launch: { ...cloneLaunch(launch), pid: child.pid, bootId },
        source: 'spawned',
        child,
    };
}
function cloneLaunch(launch) {
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
    };
}
async function waitForPidExit(pid, timeoutMs, isPidAlive, sleep, signal) {
    const deadline = Date.now() + timeoutMs;
    while (isPidAlive(pid)) {
        throwIfAborted(signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return false;
        await sleep(Math.min(25, remaining), signal);
    }
    return true;
}
function defaultSignalPid(pid, signal) {
    try {
        process.kill(pid, signal);
    }
    catch (error) {
        if (!isMissingProcessError(error))
            throw error;
    }
}
function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !isMissingProcessError(error);
    }
}
async function defaultWaitForPortRelease(webUrl, timeoutMs, signal) {
    const url = new URL(webUrl);
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    const deadline = Date.now() + timeoutMs;
    while (await portAcceptsConnections(url.hostname, port, signal)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw new Error(`host port ${port} did not close`);
        await delay(Math.min(25, remaining), signal);
    }
}
function portAcceptsConnections(host, port, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const abort = () => {
            socket.destroy();
            reject(abortError());
        };
        const finish = (open) => {
            signal?.removeEventListener('abort', abort);
            socket.destroy();
            resolve(open);
        };
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}
function delay(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        function finish() {
            signal?.removeEventListener('abort', abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(abortError());
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}
function duration(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return resolved;
}
function combineSignals(first, second) {
    return first === undefined ? second : AbortSignal.any([first, second]);
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
function isMissingProcessError(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'ESRCH';
}
//# sourceMappingURL=lifecycle.js.map