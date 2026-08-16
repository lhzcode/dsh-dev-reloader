import z from '@deepseek-ai/schemastery';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { SupervisorConfig } from './shared/config.js';
import type { RuntimePathOptions, RuntimePaths } from './supervisor/paths.js';
import { type ConnectToSupervisorOptions, type IpcClient } from './supervisor/ipc.js';
import { spawnSupervisor } from './bridge/spawn.js';
export declare const name = "dsh-dev-reloader";
export declare const inject: string[];
export declare const Config: z<SupervisorConfig>;
export interface HostPluginDependencies {
    readonly pid?: number;
    readonly nodeExecutable?: string;
    readonly execArgv?: readonly string[];
    readonly argv?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly webUrl?: string;
    readonly randomBootId?: () => string;
    readonly now?: () => number;
    readonly resolveRuntimePaths?: (options: RuntimePathOptions) => Promise<RuntimePaths>;
    readonly loadOrCreateToken?: (paths: RuntimePaths) => Promise<string>;
    readonly connectClient?: (options: ConnectToSupervisorOptions) => Promise<IpcClient>;
    readonly spawnChild?: typeof spawnSupervisor;
    readonly connectRetryMs?: number;
    readonly connectRetries?: number;
    readonly cliPath?: string;
    readonly createRequestId?: () => string;
    /** Test seam: disposal cleanup must never invoke this. */
    readonly deleteSupervisorLock?: (paths: RuntimePaths) => Promise<void>;
}
export type HostPluginConfig = SupervisorConfig;
export declare function createHostPlugin(pluginDeps?: HostPluginDependencies): Plugin;
/** The default Cordis host plugin instance. */
declare const plugin: Plugin<HostPluginConfig>;
export default plugin;
export type { Context };
//# sourceMappingURL=index.d.ts.map