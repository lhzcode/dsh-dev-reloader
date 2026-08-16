import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { HostLaunchSpec } from '../shared/protocol.js';
import { type HealthCheckRequest, type HealthObservation } from './health-check.js';
export interface AdoptedHost {
    readonly pid: number;
    readonly bootId: string;
    readonly launch: HostLaunchSpec;
    readonly source: 'adopted' | 'spawned';
    readonly child?: ChildProcess;
}
export interface RestartRequest {
    readonly host: AdoptedHost;
    readonly expectedBootId: string;
    readonly signal?: AbortSignal;
}
export interface RestartResult {
    readonly host: AdoptedHost;
    readonly health: HealthObservation;
}
export interface HostLifecycle {
    adopt(launch: HostLaunchSpec): Promise<AdoptedHost>;
    restart(request: RestartRequest): Promise<RestartResult>;
    observeUnexpectedExit(host: AdoptedHost, signal?: AbortSignal): Promise<'restarted' | 'circuit-open'>;
    observeHostDisposing(host: AdoptedHost, signal?: AbortSignal): Promise<'stopped' | 'reconnected' | 'bridge-timeout'>;
    observeBridgeConnected(host: AdoptedHost): void;
    dispose(): Promise<void>;
}
export type HostSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface HostLifecycleOptions {
    readonly shutdownGraceMs?: number;
    readonly bridgeGraceMs?: number;
    readonly healthTimeoutMs?: number;
    readonly crashWindowMs?: number;
    readonly maxCrashRestarts?: number;
    readonly crashBackoffBaseMs?: number;
    readonly spawn?: HostSpawn;
    readonly signalPid?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
    readonly isPidAlive?: (pid: number) => boolean;
    readonly waitForPortRelease?: (webUrl: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
    readonly waitForHealth?: (request: HealthCheckRequest) => Promise<HealthObservation>;
    readonly observeBridgeBootId?: () => string | undefined | Promise<string | undefined>;
    readonly notifyRestartPlanned?: (oldBootId: string, expectedBootId: string) => void | Promise<void>;
    readonly now?: () => number;
    readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly createBootId?: () => string;
}
export declare const BOOT_ID_ENV = "DSH_DEV_BOOT_ID";
export declare function createHostLifecycle(options?: HostLifecycleOptions): HostLifecycle;
//# sourceMappingURL=lifecycle.d.ts.map