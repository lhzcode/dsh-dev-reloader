import type { CommandTemplate } from './protocol.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface ProjectOverride {
    readonly root: string;
    readonly build?: CommandTemplate;
    readonly devWeb?: CommandTemplate;
}
/** Serializable configuration sent from the host bridge to the supervisor. */
export interface SupervisorConfig {
    readonly enabled: boolean;
    readonly profile: string;
    readonly sourceRoots: readonly string[];
    readonly webUrl?: string;
    readonly debounceMs: number;
    readonly healthTimeoutMs: number;
    readonly shutdownGraceMs: number;
    readonly bridgeGraceMs: number;
    readonly crashWindowMs: number;
    readonly maxCrashRestarts: number;
    readonly ignored: readonly string[];
    readonly projectOverrides: readonly ProjectOverride[];
    readonly logLevel: LogLevel;
}
export declare const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig;
//# sourceMappingURL=config.d.ts.map