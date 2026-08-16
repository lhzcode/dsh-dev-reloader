import type { SupervisorConfig } from './config.js';
export declare const PROTOCOL_VERSION: 1;
export declare const MAX_FRAME_BYTES: number;
export declare const MAX_STRING_BYTES: number;
export declare const MAX_LIST_ITEMS = 256;
export declare const MAX_ENV_ENTRIES = 1024;
export type SupervisorPhase = 'starting' | 'watching' | 'building' | 'hmr-wait' | 'pending-restart' | 'restarting' | 'recovering' | 'degraded' | 'failed' | 'paused';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface CommandTemplate {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}
export interface HostLaunchSpec {
    readonly pid: number;
    readonly bootId: string;
    readonly nodeExecutable: string;
    readonly execArgv: readonly string[];
    readonly argv: readonly string[];
    readonly cwd: string;
    /** In-memory may contain undefined; JSON wire form contains only string values. */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly profile: string;
    readonly webUrl: string;
}
export interface ActivitySnapshot {
    readonly sequence: number;
    readonly capturedAt: number;
    readonly runningAgents: number;
    readonly runningJobs: number;
    readonly stoppingJobs: number;
}
export interface PublicSupervisorStatus {
    readonly phase: SupervisorPhase;
    readonly changedAt: number;
    readonly reason?: string;
    readonly projects?: readonly string[];
    readonly error?: string;
    readonly bootId?: string;
}
export interface WireEnvelope {
    readonly protocolVersion: typeof PROTOCOL_VERSION;
    readonly type: string;
    readonly [key: string]: unknown;
}
export interface BridgeHello extends WireEnvelope {
    readonly type: 'bridge-hello';
    readonly hostPid: number;
    readonly bootId: string;
    readonly launch: HostLaunchSpec;
    readonly clientNonce: string;
    readonly clientProof: string;
}
export type BridgeEvent = (WireEnvelope & {
    readonly type: 'activity';
    readonly snapshot: ActivitySnapshot;
}) | (WireEnvelope & {
    readonly type: 'host-disposing';
    readonly hostPid: number;
}) | (WireEnvelope & {
    readonly type: 'hmr-reload';
    readonly entries: readonly string[];
}) | (WireEnvelope & {
    readonly type: 'heartbeat';
});
interface CommandBase extends WireEnvelope {
    readonly requestId: string;
}
export type SupervisorCommand = (CommandBase & {
    readonly type: 'get-status';
}) | (CommandBase & {
    readonly type: 'update-config';
    readonly config: SupervisorConfig;
}) | (CommandBase & {
    readonly type: 'rebuild';
}) | (CommandBase & {
    readonly type: 'restart';
    readonly force: boolean;
}) | (CommandBase & {
    readonly type: 'pause';
}) | (CommandBase & {
    readonly type: 'stop';
}) | (CommandBase & {
    readonly type: 'handoff';
});
export type SupervisorEvent = (WireEnvelope & {
    readonly type: 'status';
    readonly status: PublicSupervisorStatus;
}) | (WireEnvelope & {
    readonly type: 'restart-planned';
    readonly bootId: string;
}) | (WireEnvelope & {
    readonly type: 'command-result';
    readonly requestId: string;
    readonly ok: boolean;
    readonly error?: string;
}) | (WireEnvelope & {
    readonly type: 'heartbeat';
});
export declare function decodeLaunchSpec(value: unknown): HostLaunchSpec;
export declare function parseWireEnvelope(line: string): WireEnvelope;
export declare function decodeBridgeHello(value: unknown): BridgeHello;
export declare function decodeBridgeEvent(value: unknown): BridgeEvent;
export declare function validateSupervisorConfig(value: unknown): void;
export declare function decodeSupervisorCommand(value: unknown): SupervisorCommand;
export declare function decodeSupervisorEvent(value: unknown): SupervisorEvent;
export {};
//# sourceMappingURL=protocol.d.ts.map