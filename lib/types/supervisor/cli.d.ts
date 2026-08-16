import { type SupervisorConfig } from '../shared/config.js';
import { type HostLaunchSpec, type PublicSupervisorStatus, type SupervisorEvent } from '../shared/protocol.js';
import { type HandoffChannelHandle } from './handoff.js';
import { type IpcServer, type ListenForBridgesOptions } from './ipc.js';
import { type LockLease } from './lock.js';
import { type RuntimePaths } from './paths.js';
import { type DevReloaderSupervisor } from './supervisor.js';
export type SupervisorCliArguments = {
    readonly mode: 'serve';
    readonly profile: string;
} | {
    readonly mode: 'handoff';
    readonly profile: string;
};
export interface SupervisorCliAdapters {
    readonly serve: (arguments_: Extract<SupervisorCliArguments, {
        mode: 'serve';
    }>) => void | Promise<void>;
    readonly handoff: (arguments_: Extract<SupervisorCliArguments, {
        mode: 'handoff';
    }>) => void | Promise<void>;
}
export interface SupervisorFactoryContext {
    readonly paths: RuntimePaths;
    readonly token: string;
    readonly config?: SupervisorConfig;
    readonly publishStatus: (status: PublicSupervisorStatus) => void | Promise<void>;
    readonly publishEvent: (event: SupervisorEvent) => void | Promise<void>;
    readonly observeBridgeBootId: () => string | undefined;
}
export interface SupervisorCliRuntime {
    readonly resolvePaths: (profile: string) => Promise<RuntimePaths>;
    readonly acquireLock: (paths: RuntimePaths) => Promise<LockLease>;
    readonly loadToken: (paths: RuntimePaths) => Promise<string>;
    readonly createSupervisor: (context: SupervisorFactoryContext) => DevReloaderSupervisor;
    readonly listen: (options: ListenForBridgesOptions) => Promise<IpcServer>;
    readonly installSignalHandlers: (handler: () => void) => () => void;
    readonly watchHostExit: (pid: number, handler: () => void) => () => void;
    readonly listenHandoff: (options: {
        endpoint: string;
        token: string;
        transactionId: string;
    }) => Promise<HandoffChannelHandle>;
    readonly connectHandoff: (options: {
        endpoint: string;
        token: string;
        transactionId: string;
    }) => Promise<HandoffChannelHandle>;
    /** Spawn a standby supervisor CLI process for a lead-side handoff. */
    readonly spawnStandby: (options: {
        profile: string;
        transactionId: string;
    }) => {
        readonly pid: number;
    };
    readonly handoff: (arguments_: Extract<SupervisorCliArguments, {
        mode: 'handoff';
    }>) => void | Promise<void>;
}
export interface SupervisorSeed {
    readonly launch: HostLaunchSpec;
    readonly config: SupervisorConfig;
}
export declare function parseCliArguments(argv: readonly string[]): SupervisorCliArguments;
/** Load the private instance credential, creating only the existing 0600 token contract. */
export declare function loadOrCreateSupervisorToken(paths: RuntimePaths): Promise<string>;
export declare function createDefaultSupervisor(context: SupervisorFactoryContext): DevReloaderSupervisor;
export declare function serveSupervisor(arguments_: Extract<SupervisorCliArguments, {
    mode: 'serve';
}>, runtime: SupervisorCliRuntime, seed?: {
    readonly lease?: LockLease;
    readonly launch: HostLaunchSpec;
    readonly config: SupervisorConfig;
}): Promise<void>;
/**
 * Lead side of self-handoff, wired to the serve loop's `handoff` IPC command.
 * Captures the running snapshot, spawns a standby, authenticates, drives the
 * prepare→freeze→commit protocol, then exits the old process once committed.
 * Any earlier step aborts and resumes the old supervisor (or fails closed if the
 * released lease cannot be re-acquired).
 */
export declare function runLeadHandoff(options: {
    readonly runtime: SupervisorCliRuntime;
    readonly profile: string;
    readonly paths: RuntimePaths;
    readonly token: string;
    readonly supervisor: DevReloaderSupervisor;
    readonly getLease: () => LockLease | undefined;
    readonly setLease: (lease: LockLease | undefined) => void;
    /** Retire the old bridge endpoint after ownership transfers but before the standby binds it. */
    readonly beforeCommit: () => void | Promise<void>;
    /** Restore the old bridge endpoint after a pre-commit abort has returned ownership. */
    readonly restoreAfterAbort: () => void | Promise<void>;
    readonly onCommitted: () => void;
}): Promise<void>;
export declare function createSupervisorCliAdapters(runtime?: SupervisorCliRuntime): SupervisorCliAdapters;
export declare function runSupervisorCli(argv: readonly string[], adapters?: SupervisorCliAdapters): Promise<void>;
//# sourceMappingURL=cli.d.ts.map