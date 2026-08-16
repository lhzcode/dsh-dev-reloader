import { posix, resolve, sep, win32 } from 'node:path';
import { watch } from 'chokidar';
import picomatch from 'picomatch';
function toPosix(path) {
    return path.split(sep).join('/').replaceAll('\\', '/');
}
function pathStyle(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)/.test(path)
        ? 'windows'
        : 'posix';
}
function normalizeAbsolute(path) {
    if (pathStyle(path) === 'windows')
        return win32.resolve(path);
    return resolve(path);
}
function relativeWithin(root, candidate) {
    const style = pathStyle(root);
    if (pathStyle(candidate) !== style)
        return undefined;
    const pathApi = style === 'windows' ? win32 : posix;
    const normalizedRoot = style === 'windows' ? win32.resolve(root) : resolve(root);
    const normalizedCandidate = style === 'windows' ? win32.resolve(candidate) : resolve(candidate);
    const result = pathApi.relative(normalizedRoot, normalizedCandidate);
    if (result === '')
        return '';
    if (result === '..' || result.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(result)) {
        return undefined;
    }
    return result.split(pathApi.sep).join('/');
}
function isPathWithin(root, candidate) {
    return relativeWithin(root, candidate) !== undefined;
}
function equivalentPathKey(path) {
    const normalized = normalizeAbsolute(path);
    return pathStyle(normalized) === 'windows' ? normalized.toLowerCase() : normalized;
}
function watchRoots(projects) {
    const byEquivalentPath = new Map();
    for (const rawRoot of projects.flatMap(project => [project.root, project.workspaceRoot])) {
        const root = normalizeAbsolute(rawRoot);
        const key = equivalentPathKey(root);
        const current = byEquivalentPath.get(key);
        if (current === undefined || root < current)
            byEquivalentPath.set(key, root);
    }
    const unique = [...byEquivalentPath.values()].sort();
    return unique.filter(candidate => !unique.some(root => equivalentPathKey(root) !== equivalentPathKey(candidate)
        && isPathWithin(root, candidate)));
}
function isDefaultIgnored(path) {
    const segments = toPosix(path).split('/');
    if (segments.some(segment => segment === '.git'
        || segment === 'node_modules'
        || segment === '__snapshots__'
        || segment === 'logs')) {
        return true;
    }
    const basename = segments.at(-1) ?? '';
    return basename.startsWith('.#')
        || (basename.startsWith('#') && basename.endsWith('#'))
        || basename.endsWith('~')
        || /\.(?:sw[opx]|tmp|temp|snap|log)$/i.test(basename);
}
function createIgnoredPredicate(plan, roots) {
    const outputRoots = plan.projects
        .flatMap(project => project.outputRoots)
        .map(normalizeAbsolute);
    const matchRoots = [...new Set([
            ...roots,
            ...plan.projects.flatMap(project => [project.root, project.workspaceRoot]).map(normalizeAbsolute),
        ])];
    const matchers = plan.ignored.map(pattern => picomatch(pattern, { dot: true }));
    return rawPath => {
        const absolutePath = normalizeAbsolute(rawPath);
        if (isDefaultIgnored(absolutePath))
            return true;
        if (outputRoots.some(root => isPathWithin(root, absolutePath)))
            return true;
        const absolutePosix = toPosix(absolutePath);
        if (matchers.some(matches => matches(absolutePosix)))
            return true;
        return matchRoots.some(root => {
            const relativePath = relativeWithin(root, absolutePath);
            return relativePath !== undefined && matchers.some(matches => matches(relativePath));
        });
    };
}
function emitPlanEvent(active, rawEvent, onEvent) {
    const absolutePath = normalizeAbsolute(rawEvent.absolutePath);
    if (active.ignored(absolutePath))
        return;
    for (const project of active.plan.projects) {
        const projectPath = relativeWithin(project.root, absolutePath);
        if (projectPath !== undefined && projectPath !== '') {
            onEvent({
                kind: rawEvent.kind,
                project,
                origin: 'project',
                path: projectPath,
            });
            continue;
        }
        const workspacePath = relativeWithin(project.workspaceRoot, absolutePath);
        if (workspacePath !== undefined && workspacePath !== '') {
            onEvent({
                kind: rawEvent.kind,
                project,
                origin: 'workspace',
                path: workspacePath,
            });
        }
    }
}
function abortError() {
    const error = new Error('watch setup was aborted');
    error.name = 'AbortError';
    return error;
}
const chokidarBackend = {
    start(roots, ignored, onEvent, onError, signal) {
        if (roots.length === 0) {
            return Promise.resolve({ close: async () => undefined });
        }
        return new Promise((resolveSession, rejectSession) => {
            let settled = false;
            let closed = false;
            let closePromise;
            let watcher;
            const close = () => {
                if (closePromise === undefined) {
                    closed = true;
                    signal?.removeEventListener('abort', abort);
                    closePromise = watcher.close();
                }
                return closePromise;
            };
            const abort = () => {
                if (settled)
                    return;
                settled = true;
                void close().finally(() => rejectSession(abortError()));
            };
            try {
                watcher = watch([...roots], {
                    ignored,
                    ignoreInitial: true,
                    persistent: true,
                });
            }
            catch (error) {
                rejectSession(error);
                return;
            }
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort, { once: true });
            watcher.on('add', path => {
                if (!closed)
                    onEvent({ kind: 'add', absolutePath: path });
            });
            watcher.on('change', path => {
                if (!closed)
                    onEvent({ kind: 'change', absolutePath: path });
            });
            watcher.on('unlink', path => {
                if (!closed)
                    onEvent({ kind: 'unlink', absolutePath: path });
            });
            watcher.once('ready', () => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                resolveSession({ close });
            });
            watcher.on('error', error => {
                const normalized = error instanceof Error ? error : new Error(String(error));
                if (settled) {
                    if (!closed)
                        onError?.(normalized);
                    return;
                }
                settled = true;
                void close().finally(() => rejectSession(normalized));
            });
        });
    },
};
const DEFAULT_WATCH_SETUP_TIMEOUT_MS = 10_000;
function normalizeSetupTimeout(value) {
    if (value === undefined)
        return DEFAULT_WATCH_SETUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('setupTimeoutMs must be a positive safe integer');
    }
    return value;
}
function watchSetupTimeout(root, timeoutMs) {
    const error = new Error(`watch setup timed out after ${timeoutMs}ms: ${root}`);
    error.name = 'WatchSetupTimeoutError';
    return error;
}
/** Own live per-root Chokidar sessions and promote every viable successor atomically. */
export function createWatchPlanController(options) {
    const backend = options.backend ?? chokidarBackend;
    const setupTimeoutMs = normalizeSetupTimeout(options.setupTimeoutMs);
    let active;
    let closed = false;
    let promotions = Promise.resolve();
    let closePromise;
    const pendingSetups = new Set();
    const statusOf = (plan, promoted) => ({
        promoted,
        watchedRoots: plan === undefined
            ? []
            : [...plan.sessions.keys()]
                .filter(root => !plan.degradedRoots.has(root))
                .sort(),
        degradedRoots: plan === undefined
            ? []
            : [...plan.degradedRoots.values()].sort((left, right) => left.root.localeCompare(right.root)),
    });
    const notifyError = (error) => {
        try {
            options.onError?.(error);
        }
        catch {
            // Observer errors must not destabilize watcher lifecycle cleanup.
        }
    };
    const deliverEvent = (plan, event) => {
        try {
            emitPlanEvent(plan, event, options.onEvent);
        }
        catch (error) {
            notifyError(error instanceof Error ? error : new Error(String(error)));
        }
    };
    const reportDegraded = (candidate, degraded) => {
        if (candidate.discarded || candidate.degradedRoots.has(degraded.root))
            return;
        candidate.degradedRoots.set(degraded.root, degraded);
        try {
            options.onDegradedRoot?.(degraded);
        }
        catch (error) {
            notifyError(error instanceof Error ? error : new Error(String(error)));
        }
    };
    const closeSession = (session) => {
        try {
            return Promise.resolve(session.close());
        }
        catch (error) {
            return Promise.reject(error);
        }
    };
    const closeRootSession = (plan, root) => {
        const session = plan.sessions.get(root);
        if (session === undefined)
            return;
        plan.sessions.delete(root);
        const closing = closeSession(session);
        plan.closingSessions.add(closing);
        void closing.then(() => plan.closingSessions.delete(closing), error => {
            plan.closingSessions.delete(closing);
            notifyError(error instanceof Error ? error : new Error(String(error)));
        });
    };
    const closeSessions = async (plan) => {
        plan.discarded = true;
        const sessions = [...plan.sessions.values()];
        plan.sessions.clear();
        const results = await Promise.allSettled([
            ...sessions.map(closeSession),
            ...plan.closingSessions,
        ]);
        plan.closingSessions.clear();
        const failures = results
            .filter((result) => result.status === 'rejected')
            .map(result => result.reason);
        if (failures.length > 0) {
            const summary = failures
                .map(error => error instanceof Error ? error.message : String(error))
                .join('; ');
            throw new AggregateError(failures, `failed to close watch sessions: ${summary}`);
        }
    };
    const settleSetup = (root, started, controller) => new Promise(resolveSetup => {
        let settled = false;
        let timer;
        const settle = (result) => {
            if (settled) {
                if ('session' in result)
                    void closeSession(result.session).catch(notifyError);
                return;
            }
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            pendingSetups.delete(controller);
            resolveSetup(result);
        };
        const onAbort = () => settle({ root, error: abortError() });
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
            settle({ root, error: watchSetupTimeout(root, setupTimeoutMs) });
            controller.abort();
        }, setupTimeoutMs);
        timer.unref?.();
        void started.then(session => settle({ root, session }), error => settle({
            root,
            error: error instanceof Error ? error : new Error(String(error)),
        }));
    });
    const replace = (plan) => {
        if (closed)
            return Promise.reject(new Error('watch plan controller is closed'));
        const roots = watchRoots(plan.projects);
        const candidate = {
            plan: { projects: [...plan.projects], ignored: [...plan.ignored] },
            ignored: createIgnoredPredicate(plan, roots),
            pendingEvents: new Map(),
            sessions: new Map(),
            degradedRoots: new Map(),
            closingSessions: new Set(),
            discarded: false,
        };
        const setups = roots.map(root => {
            const setupController = new AbortController();
            pendingSetups.add(setupController);
            let started;
            try {
                started = backend.start([root], candidate.ignored, rawEvent => {
                    if (closed || candidate.discarded || candidate.degradedRoots.has(root))
                        return;
                    if (active === candidate)
                        deliverEvent(candidate, rawEvent);
                    else
                        candidate.pendingEvents.set(rawEvent.absolutePath, { root, event: rawEvent });
                }, error => {
                    if (closed || candidate.discarded)
                        return;
                    reportDegraded(candidate, { root, phase: 'runtime', error });
                    closeRootSession(candidate, root);
                    notifyError(error);
                }, setupController.signal);
            }
            catch (error) {
                started = Promise.reject(error);
            }
            return settleSetup(root, started, setupController);
        });
        const setupAll = Promise.all(setups);
        const operation = promotions.then(async () => {
            const results = await setupAll;
            for (const result of results) {
                if ('session' in result) {
                    if (candidate.degradedRoots.has(result.root)) {
                        await closeSession(result.session).catch(notifyError);
                    }
                    else {
                        candidate.sessions.set(result.root, result.session);
                    }
                }
                else {
                    reportDegraded(candidate, {
                        root: result.root,
                        phase: 'setup',
                        error: result.error,
                    });
                }
            }
            if (closed) {
                await closeSessions(candidate);
                const aborted = results.find(result => 'error' in result && result.error.name === 'AbortError');
                if (aborted !== undefined && 'error' in aborted)
                    throw aborted.error;
                return statusOf(candidate, false);
            }
            if (roots.length > 0 && candidate.sessions.size === 0) {
                candidate.discarded = true;
                return statusOf(candidate, false);
            }
            const previous = active;
            if (previous !== undefined) {
                active = undefined;
                try {
                    await closeSessions(previous);
                }
                catch (error) {
                    await closeSessions(candidate).catch(() => undefined);
                    throw error;
                }
            }
            if (closed) {
                await closeSessions(candidate);
                return statusOf(candidate, false);
            }
            if (roots.length > 0 && candidate.sessions.size === 0) {
                candidate.discarded = true;
                return statusOf(candidate, false);
            }
            active = candidate;
            for (const pending of candidate.pendingEvents.values()) {
                if (!candidate.degradedRoots.has(pending.root)) {
                    deliverEvent(candidate, pending.event);
                }
            }
            candidate.pendingEvents.clear();
            return statusOf(candidate, true);
        });
        promotions = operation.catch(() => undefined);
        return operation;
    };
    const inspect = () => statusOf(active, active !== undefined);
    const close = () => {
        if (closePromise !== undefined)
            return closePromise;
        closed = true;
        for (const controller of pendingSetups)
            controller.abort();
        closePromise = promotions.then(async () => {
            const previous = active;
            active = undefined;
            if (previous !== undefined)
                await closeSessions(previous);
        });
        return closePromise;
    };
    return { replace, inspect, close };
}
//# sourceMappingURL=watcher.js.map