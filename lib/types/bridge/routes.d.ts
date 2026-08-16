import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { type PublicSupervisorStatus, type SupervisorCommand } from '../shared/protocol.js';
import type { IpcCommandResult } from '../supervisor/ipc.js';
/** Route URL prefix shared by the host status/health/command surfaces. */
export declare const BRIDGE_PREFIX = "/plugins/dsh-dev-reloader";
export declare const MAX_COMMAND_BODY_BYTES: number;
/** Authorization metadata extracted from an incoming command request. */
export interface CommandRequestMeta {
    readonly remoteAddress: string | undefined;
    /** True when a proxy/forwarded header was present; loopback trust must not extend. */
    readonly forwarded: boolean;
    readonly origin: string | undefined;
    readonly host: string | undefined;
    readonly contentType: string | undefined;
}
export type CommandRequestAuth = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly status: number;
    readonly error: string;
};
/**
 * Authorize an administrative command request: it must arrive directly from a
 * loopback peer, never through a proxy, never from another origin, and carry a
 * JSON content type.
 */
export declare function authorizeCommandRequest(meta: CommandRequestMeta): CommandRequestAuth;
export type BodyReadResult = {
    readonly kind: 'ok';
    readonly text: string;
} | {
    readonly kind: 'too-large';
};
/** Read a request body up to a byte bound, rejecting early on overflow. */
export declare function readRequestBody(source: AsyncIterable<unknown> | Iterable<unknown>, maxBytes: number): Promise<BodyReadResult>;
export type ParsedCommand = {
    readonly ok: true;
    readonly command: SupervisorCommand;
} | {
    readonly ok: false;
    readonly status: number;
    readonly error: string;
};
/** Parse and validate a JSON command body against the known supervisor commands. */
export declare function parseCommandBody(body: string): ParsedCommand;
export interface BridgeRouteDependencies {
    readonly status: () => PublicSupervisorStatus | undefined;
    readonly bootId: () => string;
    readonly sendCommand: (command: SupervisorCommand) => Promise<IpcCommandResult>;
    readonly createRequestId?: () => string;
}
export interface BridgeRoutes {
    readonly status: WebRoute;
    readonly health: WebRoute;
    readonly command: WebRoute;
}
export declare function createBridgeRoutes(deps: BridgeRouteDependencies): BridgeRoutes;
//# sourceMappingURL=routes.d.ts.map