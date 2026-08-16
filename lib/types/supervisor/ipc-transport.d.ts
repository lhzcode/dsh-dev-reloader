import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import { type WireEnvelope } from '../shared/protocol.js';
export type IpcErrorCode = 'IPC_AUTHENTICATION_FAILED' | 'IPC_DISCONNECTED' | 'IPC_DUPLICATE_REQUEST' | 'IPC_FRAME_TOO_LARGE' | 'IPC_PROTOCOL_ERROR';
export declare class IpcError extends Error {
    readonly code: IpcErrorCode;
    constructor(code: IpcErrorCode, message: string, options?: ErrorOptions);
}
export declare const MAX_QUEUED_FRAMES = 16;
export declare function protocolError(message: string, cause?: unknown): IpcError;
export declare function disconnected(message?: string, cause?: unknown): IpcError;
export declare class ByteLineDecoder {
    private readonly parts;
    private byteLength;
    push(chunk: Buffer): Buffer[];
    private append;
    private takeLine;
}
export declare function decodeEnvelope(frame: Buffer): WireEnvelope;
export declare function writeFrame(socket: Socket, value: WireEnvelope): Promise<void>;
export declare function waitForSocketClose(socket: Socket): Promise<void>;
export declare function closeSocket(socket: Socket): Promise<void>;
/**
 * Do not widen Windows named-pipe access. Node still relies on the current
 * user's default DACL; this module does not claim or emulate custom ACL support.
 */
export declare function privateListenOptions(endpoint: string, platform?: NodeJS.Platform): string | {
    path: string;
    readableAll: false;
    writableAll: false;
};
export declare function verifyUnixEndpoint(endpoint: string): Promise<void>;
export interface InboundQueueState {
    frames: Buffer[];
    bytes: number;
    processing: boolean;
    failed: boolean;
}
export declare function createInboundQueue(): InboundQueueState;
export declare function failInboundQueue(state: InboundQueueState): void;
export declare function enqueueInboundFrames(socket: Socket, state: InboundQueueState, decoder: ByteLineDecoder, chunk: Buffer, maxFrames: number, consume: (frame: Buffer) => Promise<void>, fail: (error: unknown) => void): void;
//# sourceMappingURL=ipc-transport.d.ts.map