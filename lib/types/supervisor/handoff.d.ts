import type { SupervisorConfig } from '../shared/config.js';
import { PROTOCOL_VERSION, type HostLaunchSpec } from '../shared/protocol.js';
import { type RuntimePaths } from './paths.js';
/**
 * An immutable, in-memory description of the launch environment a new
 * supervisor must reproduce after taking over. Never written to disk or argv;
 * it travels only over the one-use authenticated handoff channel.
 */
export interface HandoffSnapshot {
    readonly protocolVersion: typeof PROTOCOL_VERSION;
    readonly transactionId: string;
    readonly generation: number;
    readonly launch: HostLaunchSpec;
    readonly config: SupervisorConfig;
}
export type HandoffPhase = 'idle' | 'prepared' | 'frozen' | 'committed' | 'aborted';
export type HandoffMessage = ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-snapshot';
    readonly snapshot: HandoffSnapshot;
}) | ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-prepared';
}) | ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-freeze';
}) | ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-commit';
}) | ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-committed';
}) | ({
    readonly protocolVersion: typeof PROTOCOL_VERSION;
} & {
    readonly type: 'handoff-abort';
    readonly reason?: string;
});
export interface HandoffChannel {
    send(message: HandoffMessage): Promise<void>;
    onMessage(listener: (message: HandoffMessage) => void | Promise<void>): () => void;
    /** Optional terminal notification so pending message waits can reject on close. */
    onClose?(listener: () => void): () => void;
}
/** Old (lead) side hooks driving the prepare/commit/abort state machine. */
export interface HandoffLeadHooks {
    /** True only while the old supervisor is watching and healthy enough to hand off. */
    readyToPrepare(): boolean | Promise<boolean>;
    /** Capture the in-memory launch environment; throws when it cannot be read. */
    createSnapshot(): HandoffSnapshot | Promise<HandoffSnapshot>;
    /** Freeze the old supervisor so it stops accepting new mutations. */
    freezeMutations(): void | Promise<void>;
    /** Atomically release the old supervisor's lock lease so a new owner can acquire it. */
    transferOwnership(): void | Promise<void>;
    /** Resume the old supervisor fully (adapters and lifecycle intact) after an abort. */
    resume(): void | Promise<void>;
}
/** State-machine seams a running supervisor exposes for self-handoff. */
export interface SupervisorHandoff {
    readonly phase: HandoffPhase;
    prepare(): Promise<HandoffSnapshot>;
    freeze(): Promise<void>;
    commit(): Promise<void>;
    abort(): Promise<void>;
}
/** Standby (follow) side hooks for accepting ownership and only then serving. */
export interface HandoffFollowHooks {
    /** Validate the incoming snapshot; throws when it is unreadable. */
    acceptSnapshot(snapshot: HandoffSnapshot): void | Promise<void>;
    /** Atomically acquire the lock lease so this standby becomes the sole owner. */
    acquireOwnership(): void | Promise<void>;
    /** Release the acquired lease after an abort/backoff; must be idempotent. */
    releaseOwnership(): void | Promise<void>;
    /** Begin watching and serving only after ownership has committed. */
    beginServing(): void | Promise<void>;
    /** True while this standby exclusively owns the endpoint after acquisition. */
    verifyStillOwner(): boolean | Promise<boolean>;
}
/** Old-supervisor handoff coordinator: validates, freezes, then commits ownership. */
export declare function createHandoffLead(hooks: HandoffLeadHooks, channel: HandoffChannel, options?: {
    readonly timeoutMs?: number;
}): {
    readonly handoff: SupervisorHandoff;
};
/**
 * Standby coordinator: accepts the snapshot, acquires ownership, and only begins
 * serving after the lead confirms with `handoff-committed`.
 */
export declare function createHandoffFollow(hooks: HandoffFollowHooks, channel: HandoffChannel, options?: {
    readonly timeoutMs?: number;
}): {
    start(): Promise<void>;
};
export interface HandoffTransportOptions {
    readonly endpoint: string;
    readonly token: string;
    readonly transactionId: string;
}
/** Fresh one-use handoff socket path keyed by transaction id, bounded for Unix. */
export declare function resolveHandoffEndpoint(paths: RuntimePaths, transactionId: string): string;
declare function decodeSnapshot(value: unknown): HandoffSnapshot;
/** Standby-side snapshot validation exposed for tests and the transport hook. */
export { decodeSnapshot as decodeHandoffSnapshot };
export interface HandoffChannelHandle {
    readonly channel: HandoffChannel;
    close(): Promise<void>;
}
/** Standby side: bind a fresh one-use private endpoint and authenticate the lead. */
export declare function listenForHandoff(options: HandoffTransportOptions): Promise<HandoffChannelHandle>;
/** Old (lead) side: connect to the standby's one-use endpoint and authenticate. */
export declare function connectForHandoff(options: HandoffTransportOptions): Promise<HandoffChannelHandle>;
//# sourceMappingURL=handoff.d.ts.map