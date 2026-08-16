import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { CommandTemplate } from '../shared/protocol.js';
export interface CommandSpec extends CommandTemplate {
    readonly env?: Readonly<Record<string, string | undefined>>;
}
export interface CommandResult {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
}
export interface PersistentProcess {
    readonly key: string;
    readonly command: CommandSpec;
    readonly pid: number | undefined;
    readonly done: Promise<CommandResult>;
    stop(): Promise<void>;
}
export interface CommandRunner {
    run(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult>;
    ensurePersistent(key: string, command: CommandSpec): Promise<PersistentProcess>;
    stopAll(): Promise<void>;
    readonly persistentCount: number;
}
export type SpawnAdapter = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface CommandRunnerOptions {
    readonly spawn?: SpawnAdapter;
    /** Platform used for executable shim handling; injectable for deterministic tests. */
    readonly platform?: NodeJS.Platform;
    readonly outputLimitBytes?: number;
    readonly secrets?: readonly string[];
    readonly stopGraceMs?: number;
}
export declare function createCommandRunner(options?: CommandRunnerOptions): CommandRunner;
export declare function redactSensitiveText(value: string, secrets?: readonly string[]): string;
//# sourceMappingURL=runner.d.ts.map