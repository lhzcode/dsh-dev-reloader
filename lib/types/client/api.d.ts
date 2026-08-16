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
import { type PublicSupervisorStatus } from '../shared/protocol.js';
/** Same-origin route paths served by the host bridge (keep in sync with routes.ts). */
export declare const STATUS_PATH = "/plugins/dsh-dev-reloader/status";
export declare const HEALTH_PATH = "/plugins/dsh-dev-reloader/health";
export declare const COMMAND_PATH = "/plugins/dsh-dev-reloader/command";
/** Upper bound for a command request body (matches the host route guard). */
export declare const MAX_COMMAND_BODY_BYTES: number;
/** Reject bodies that would exceed the bounded-body contract. */
export declare class BodyTooLargeError extends Error {
    constructor(byteLength: number);
}
/** Health surface payload. */
export interface HealthResponse {
    readonly ok: boolean;
    readonly bootId: string;
}
/** A command's settled result (the host route returns `{ ok, error? }`). */
export interface CommandResult {
    readonly ok: boolean;
    readonly error?: string;
}
/** Error raised for any transport or non-2xx HTTP failure of a bridge call. */
export declare class ApiError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string, cause?: unknown);
    /** Short human-readable message for the settings card. */
    displayMessage(): string;
}
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface DevReloaderApi {
    /** Fetch the latest supervisor status. */
    getStatus(): Promise<PublicSupervisorStatus>;
    /** Fetch the health surface. */
    getHealth(): Promise<HealthResponse>;
    /** Issue a supervisor command and return its settled result. */
    command(type: 'get-status' | 'update-config' | 'rebuild' | 'pause' | 'stop', options?: {
        config?: unknown;
    }): Promise<CommandResult>;
    command(type: 'restart', options: {
        force: boolean;
    }): Promise<CommandResult>;
}
/**
 * Build the typed bridge API. `fetchImpl` defaults to the global `fetch`;
 * `base` defaults to the same-origin root (`''`), so routes resolve relative to
 * the current page.
 */
export declare function createDevReloaderApi(fetchImpl?: FetchLike, base?: string): DevReloaderApi;
//# sourceMappingURL=api.d.ts.map