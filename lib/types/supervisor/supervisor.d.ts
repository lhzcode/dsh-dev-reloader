import type { SupervisorConfig } from '../shared/config.js';
import { type BridgeEvent, type HostLaunchSpec, type PublicSupervisorStatus } from '../shared/protocol.js';
import { type HandoffChannel, type SupervisorHandoff } from './handoff.js';
import type { DiscoveryResult } from './discovery.js';
import type { HostLifecycle } from './lifecycle.js';
import type { CommandRunner } from './runner.js';
import type { ChangeScheduler, ChangeSchedulerOptions } from './scheduler.js';
import type { TaskGate } from './task-gate.js';
import type { CreateWatchPlanControllerOptions, WatchPlanController } from './watcher.js';
export interface CreateSupervisorOptions {
    readonly config: SupervisorConfig;
    readonly discover: (config: SupervisorConfig, launch: HostLaunchSpec) => Promise<DiscoveryResult>;
    readonly createWatcher: (options: CreateWatchPlanControllerOptions) => WatchPlanController;
    readonly createScheduler: (options: ChangeSchedulerOptions) => ChangeScheduler;
    readonly runner: CommandRunner;
    readonly gate: TaskGate;
    readonly lifecycle: HostLifecycle;
    readonly createLifecycle?: (config: SupervisorConfig, launch: HostLaunchSpec) => HostLifecycle;
    readonly createBootId: () => string;
    readonly publishStatus?: (status: PublicSupervisorStatus) => void | Promise<void>;
    readonly now?: () => number;
}
export interface RestartCommand {
    readonly force: boolean;
    readonly reason: string;
}
/** Lock-side hooks the CLI supplies so the supervisor can hand off its lock. */
export interface HandoffLockHooks {
    /** Atomically release the old supervisor's lock lease so a new owner can acquire it. */
    readonly transferOwnership: () => void | Promise<void>;
    /**
     * Re-acquire the endpoint lease after a handoff aborts past the transfer point.
     * Returns `false` when the standby still holds the lease (so the old supervisor
     * fails closed rather than resuming service without ownership).
     */
    readonly reacquire: () => Promise<boolean>;
}
export interface DevReloaderSupervisor {
    readonly status: PublicSupervisorStatus;
    start(launch: HostLaunchSpec): Promise<void>;
    bridgeConnected(launch: HostLaunchSpec): Promise<void>;
    /**
     * Synchronous bridge-generation admission: when the connecting bridge belongs
     * to a different host generation (pid or boot id), reset the activity gate so
     * the new generation's sequence baseline starts fresh. Must run before the
     * bridge handshake completes so the new bridge's first activity snapshot is
     * never rejected against a stale baseline, and never blocks on the mutation
     * tail (a long-running restart must not stall bridge authentication).
     */
    prepareBridge(launch: HostLaunchSpec): void;
    observeUnexpectedExit(hostPid: number): Promise<void>;
    handleBridgeEvent(event: BridgeEvent): Promise<void>;
    requestRestart(command: RestartCommand): Promise<void>;
    updateConfig(config: SupervisorConfig): Promise<void>;
    rebuild(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
    /** Expose the handoff state-machine seams (prepare/commit/abort/freeze) over a channel. */
    handoff(channel: HandoffChannel, lock: HandoffLockHooks, transaction?: {
        readonly id: string;
        readonly generation: number;
    }): SupervisorHandoff;
}
/** Coordinate already-separated discovery, watch, build, gate, and host-lifecycle adapters. */
export declare function createSupervisor(options: CreateSupervisorOptions): DevReloaderSupervisor;
//# sourceMappingURL=supervisor.d.ts.map