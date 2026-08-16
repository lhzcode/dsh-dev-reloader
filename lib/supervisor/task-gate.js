function abortError() {
    const error = new Error('Task gate wait aborted');
    error.name = 'AbortError';
    return error;
}
function readValidActivitySnapshot(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    try {
        const candidate = value;
        const sequence = candidate.sequence;
        const capturedAt = candidate.capturedAt;
        const runningAgents = candidate.runningAgents;
        const runningJobs = candidate.runningJobs;
        const stoppingJobs = candidate.stoppingJobs;
        const values = [
            sequence,
            capturedAt,
            runningAgents,
            runningJobs,
            stoppingJobs,
        ];
        if (!values.every(item => Number.isSafeInteger(item) && item >= 0)) {
            return undefined;
        }
        return {
            sequence: sequence,
            capturedAt: capturedAt,
            runningAgents: runningAgents,
            runningJobs: runningJobs,
            stoppingJobs: stoppingJobs,
        };
    }
    catch {
        return undefined;
    }
}
export function createTaskGate() {
    const localTasks = new Set();
    const waiters = new Set();
    let bridgeKnown = false;
    let latestSequence = -1;
    let snapshot;
    function inspect() {
        if (!bridgeKnown || snapshot === undefined) {
            return { open: false, reason: 'bridge-unknown' };
        }
        if (snapshot.runningAgents > 0) {
            return { open: false, reason: 'agents-running' };
        }
        if (snapshot.runningJobs > 0) {
            return { open: false, reason: 'jobs-running' };
        }
        if (snapshot.stoppingJobs > 0) {
            return { open: false, reason: 'jobs-stopping' };
        }
        if (localTasks.size > 0) {
            return { open: false, reason: 'local-tasks' };
        }
        return { open: true };
    }
    function removeWaiter(waiter) {
        if (!waiters.delete(waiter))
            return;
        if ('signal' in waiter) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
    }
    function resolveWaitersIfOpen() {
        if (!inspect().open)
            return;
        for (const waiter of [...waiters]) {
            removeWaiter(waiter);
            waiter.resolve();
        }
    }
    function updateActivity(next) {
        const validated = readValidActivitySnapshot(next);
        if (validated === undefined) {
            bridgeKnown = false;
            return false;
        }
        if (validated.sequence <= latestSequence)
            return false;
        latestSequence = validated.sequence;
        snapshot = validated;
        bridgeKnown = true;
        resolveWaitersIfOpen();
        return true;
    }
    function bridgeDisconnected() {
        bridgeKnown = false;
    }
    function bridgeReplaced() {
        latestSequence = -1;
        snapshot = undefined;
        bridgeKnown = false;
    }
    function beginLocalTask(_label) {
        const token = Symbol();
        localTasks.add(token);
        let finished = false;
        return () => {
            if (finished)
                return;
            finished = true;
            localTasks.delete(token);
            resolveWaitersIfOpen();
        };
    }
    function waitUntilOpen(signal) {
        if (signal?.aborted === true)
            return Promise.reject(abortError());
        if (inspect().open)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            if (signal === undefined) {
                waiters.add({ resolve });
                return;
            }
            let waiter;
            const onAbort = () => {
                removeWaiter(waiter);
                reject(abortError());
            };
            waiter = { resolve, signal, onAbort };
            waiters.add(waiter);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
    return {
        inspect,
        updateActivity,
        bridgeDisconnected,
        bridgeReplaced,
        beginLocalTask,
        waitUntilOpen,
    };
}
//# sourceMappingURL=task-gate.js.map