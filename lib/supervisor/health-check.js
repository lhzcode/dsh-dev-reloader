import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const DEFAULT_POLL_INTERVAL_MS = 100;
export async function waitForHostHealth(request) {
    requireDuration(request.timeoutMs, 'timeoutMs');
    const interval = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    requireDuration(interval, 'pollIntervalMs');
    throwIfAborted(request.signal);
    const deadline = Date.now() + request.timeoutMs;
    let httpReady = false;
    let observedBootId;
    const probe = request.request ?? probeHttp;
    while (true) {
        throwIfAborted(request.signal);
        const remaining = Math.max(0, deadline - Date.now());
        if (remaining === 0) {
            const bridgeReady = observedBootId === request.expectedBootId;
            return observation(false, httpReady, bridgeReady, request.expectedBootId, observedBootId);
        }
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        request.signal?.addEventListener('abort', forwardAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(), remaining);
        timeout.unref?.();
        let currentHttpReady = false;
        let currentObservedBootId;
        try {
            const results = await Promise.all([
                boundedHttpProbe(() => probe(request.webUrl, controller.signal), remaining, request.signal),
                boundedBridgeObservation(request.observeBridgeBootId, remaining, request.signal),
            ]);
            currentHttpReady = results[0];
            currentObservedBootId = results[1];
            httpReady = currentHttpReady;
            observedBootId = currentObservedBootId;
        }
        finally {
            clearTimeout(timeout);
            request.signal?.removeEventListener('abort', forwardAbort);
        }
        const currentBridgeReady = currentObservedBootId === request.expectedBootId;
        const bridgeReady = observedBootId === request.expectedBootId;
        if (currentHttpReady && currentBridgeReady) {
            return observation(true, httpReady, bridgeReady, request.expectedBootId, observedBootId);
        }
        if (Date.now() >= deadline) {
            return observation(false, httpReady, bridgeReady, request.expectedBootId, observedBootId);
        }
        await delay(Math.min(interval, Math.max(0, deadline - Date.now())), request.signal);
    }
}
function observation(healthy, httpReady, bridgeReady, expectedBootId, observedBootId) {
    return observedBootId === undefined
        ? { healthy, httpReady, bridgeReady, expectedBootId }
        : { healthy, httpReady, bridgeReady, expectedBootId, observedBootId };
}
function probeHttp(value, signal) {
    const url = new URL(value);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const outgoing = request(url, {
            method: 'GET',
            headers: { 'cache-control': 'no-cache' },
            signal,
        }, response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode !== undefined
                && response.statusCode >= 200
                && response.statusCode < 300));
        });
        outgoing.once('error', reject);
        outgoing.end();
    });
}
function boundedHttpProbe(probe, timeoutMs, signal) {
    return boundedObservation(probe, false, timeoutMs, signal);
}
function boundedBridgeObservation(observe, timeoutMs, signal) {
    return boundedObservation(observe, undefined, timeoutMs, signal);
}
function boundedObservation(observe, fallback, timeoutMs, signal) {
    if (signal?.aborted)
        return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(fallback), timeoutMs);
        timer.unref?.();
        const abort = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(abortError());
        };
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            resolve(value);
        };
        signal?.addEventListener('abort', abort, { once: true });
        void Promise.resolve()
            .then(observe)
            .then(finish, () => finish(fallback));
    });
}
function delay(ms, signal) {
    if (signal?.aborted)
        return Promise.reject(abortError());
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
function requireDuration(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
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
//# sourceMappingURL=health-check.js.map