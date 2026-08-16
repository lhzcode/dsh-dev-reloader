import { type ChildProcess, type SpawnOptions } from 'node:child_process';
/** Resolve the supervisor CLI entry under the current package's `lib`. */
export declare function resolveSupervisorCli(moduleUrl?: string): string;
export interface SpawnSupervisorOptions {
    /** Absolute path to the built supervisor CLI entry. */
    readonly cliPath: string;
    /** DSH profile the supervisor should serve. */
    readonly profile: string;
    /** Environment inherited in memory by the detached supervisor. */
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Test seam for the child-process spawner. */
    readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}
export interface SpawnSupervisorResult {
    readonly process: ChildProcess;
    readonly pid: number;
}
/**
 * Launch the dev supervisor as a detached daemon so it outlives the host.
 * The child inherits `process.execPath`, ignored stdio, and is unref'd so it
 * never keeps the host's event loop alive.
 */
export declare function spawnSupervisor(options: SpawnSupervisorOptions): SpawnSupervisorResult;
//# sourceMappingURL=spawn.d.ts.map