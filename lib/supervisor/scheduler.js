import { classifyChange, mergeActions, } from './classifier.js';
import { redactSensitiveText } from './runner.js';
function eventKey(event) {
    return `${event.project.id}\u0000${event.origin ?? 'project'}\u0000${event.path}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function createChangeScheduler(options) {
    const pending = new Map();
    const idleWaiters = [];
    let debounceTimer;
    let activeCycle;
    let activeAbortController;
    let lastResult = { kind: 'success' };
    let closed = false;
    let closePromise;
    function isIdle() {
        return debounceTimer === undefined && activeCycle === undefined && pending.size === 0;
    }
    function resolveIdleWaiters() {
        if (!isIdle())
            return;
        for (const resolve of idleWaiters.splice(0))
            resolve(lastResult);
    }
    async function executeCycle(events, signal) {
        try {
            const plan = mergeActions(events.flatMap(event => classifyChange(event)));
            if (plan.actions.length === 0) {
                lastResult = { kind: 'success' };
                return;
            }
            const result = await options.runBuilds(plan, signal);
            lastResult = result.kind === 'build-failed'
                ? { kind: 'build-failed', error: redactSensitiveText(result.error) }
                : result;
            if (lastResult.kind === 'success' && !closed)
                await options.onReady(plan);
        }
        catch (error) {
            lastResult = {
                kind: 'build-failed',
                error: redactSensitiveText(errorMessage(error)),
            };
        }
    }
    function startCycle() {
        if (closed || activeCycle !== undefined || pending.size === 0) {
            resolveIdleWaiters();
            return;
        }
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
        const events = [...pending.values()];
        pending.clear();
        const abortController = new AbortController();
        activeAbortController = abortController;
        const cycle = executeCycle(events, abortController.signal);
        activeCycle = cycle;
        const settleCycle = (unexpectedError) => {
            if (unexpectedError !== undefined) {
                lastResult = {
                    kind: 'build-failed',
                    error: redactSensitiveText(errorMessage(unexpectedError)),
                };
            }
            if (activeCycle === cycle) {
                activeCycle = undefined;
                activeAbortController = undefined;
            }
            if (closed) {
                pending.clear();
                resolveIdleWaiters();
                return;
            }
            // Events received during the active cycle form one immediate dirty follow-up.
            if (pending.size > 0)
                startCycle();
            else
                resolveIdleWaiters();
        };
        void cycle.then(() => settleCycle(), error => settleCycle(error));
    }
    function enqueue(event) {
        if (closed)
            return;
        pending.set(eventKey(event), event);
        if (activeCycle !== undefined)
            return;
        if (debounceTimer !== undefined)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            startCycle();
        }, options.debounceMs);
    }
    function waitForIdle() {
        if (isIdle())
            return Promise.resolve(lastResult);
        return new Promise(resolve => idleWaiters.push(resolve));
    }
    function close() {
        if (closePromise !== undefined)
            return closePromise;
        closed = true;
        activeAbortController?.abort();
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
        pending.clear();
        resolveIdleWaiters();
        closePromise = (async () => {
            if (activeCycle !== undefined)
                await activeCycle;
            resolveIdleWaiters();
        })();
        return closePromise;
    }
    return { enqueue, waitForIdle, close };
}
//# sourceMappingURL=scheduler.js.map