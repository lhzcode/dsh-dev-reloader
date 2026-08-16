/**
 * Typed fetch helpers for the same-origin bridge surfaces.
 *
 * The browser card talks only to the host bridge's loopback routes
 * (`/plugins/dsh-dev-reloader/{status,health,command}`). This module owns all
 * `fetch` usage for the card, keeps request bodies within the supervisor's
 * bounded-body contract, and maps transport/HTTP failures into a single
 * {@link ApiError} so the card can render them uniformly. `fetch` is injectable
 * for tests.
 */
import { PROTOCOL_VERSION } from '../shared/protocol.js';
/** Same-origin route paths served by the host bridge (keep in sync with routes.ts). */
export const STATUS_PATH = '/plugins/dsh-dev-reloader/status';
export const HEALTH_PATH = '/plugins/dsh-dev-reloader/health';
export const COMMAND_PATH = '/plugins/dsh-dev-reloader/command';
/** Upper bound for a command request body (matches the host route guard). */
export const MAX_COMMAND_BODY_BYTES = 64 * 1024;
/** Reject bodies that would exceed the bounded-body contract. */
export class BodyTooLargeError extends Error {
    constructor(byteLength) {
        super(`command body is ${byteLength} bytes, exceeding the ${MAX_COMMAND_BODY_BYTES} byte bound`);
        this.name = 'BodyTooLargeError';
    }
}
/** Error raised for any transport or non-2xx HTTP failure of a bridge call. */
export class ApiError extends Error {
    status;
    body;
    constructor(status, body, cause) {
        super(`bridge request failed with status ${status}: ${body}`, { cause });
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
    /** Short human-readable message for the settings card. */
    displayMessage() {
        return `HTTP ${this.status}: ${this.body}`;
    }
}
/** One sequential request-id source for commands issued by this page. */
function createRequestId() {
    return `dsh-card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
async function readError(res) {
    const text = await res.text().catch(() => '');
    if (text !== '')
        return text;
    return `HTTP ${res.status}`;
}
async function request(fetchImpl, base, path, init) {
    try {
        const response = await fetchImpl(`${base}${path}`, init);
        if (!response.ok) {
            const body = await readError(response);
            throw new ApiError(response.status, body);
        }
        return response;
    }
    catch (error) {
        if (error instanceof ApiError)
            throw error;
        throw new ApiError(0, error instanceof Error ? error.message : String(error), error);
    }
}
/**
 * Build the typed bridge API. `fetchImpl` defaults to the global `fetch`;
 * `base` defaults to the same-origin root (`''`), so routes resolve relative to
 * the current page.
 */
export function createDevReloaderApi(fetchImpl = fetch, base = '') {
    return {
        async getStatus() {
            const response = await request(fetchImpl, base, STATUS_PATH, {
                method: 'GET',
                cache: 'no-store',
            });
            return (await response.json());
        },
        async getHealth() {
            const response = await request(fetchImpl, base, HEALTH_PATH, {
                method: 'GET',
                cache: 'no-store',
            });
            return (await response.json());
        },
        async command(type, options) {
            const payload = {
                protocolVersion: PROTOCOL_VERSION,
                type,
                requestId: createRequestId(),
            };
            if (options?.force !== undefined)
                payload.force = options.force;
            if (options?.config !== undefined)
                payload.config = options.config;
            const text = JSON.stringify(payload);
            const byteLength = new TextEncoder().encode(text).byteLength;
            if (byteLength > MAX_COMMAND_BODY_BYTES) {
                throw new BodyTooLargeError(byteLength);
            }
            const response = await request(fetchImpl, base, COMMAND_PATH, {
                method: 'POST',
                cache: 'no-store',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: text,
            });
            return (await response.json());
        },
    };
}
//# sourceMappingURL=api.js.map