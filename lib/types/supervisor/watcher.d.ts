import type { ChangeEvent, ChangePathOrigin } from './classifier.js';
import type { ProjectDescriptor } from './discovery.js';
export type RawWatchEventKind = 'add' | 'change' | 'unlink';
export interface RawWatchEvent {
    readonly kind: RawWatchEventKind;
    readonly absolutePath: string;
}
export interface WatchEvent extends ChangeEvent {
    readonly kind: RawWatchEventKind;
    readonly origin: ChangePathOrigin;
}
export interface WatchBackendSession {
    close(): Promise<void>;
}
export interface WatchBackend {
    start(roots: readonly string[], ignored: (path: string) => boolean, onEvent: (event: RawWatchEvent) => void, onError?: (error: Error) => void, signal?: AbortSignal): Promise<WatchBackendSession>;
}
export interface WatchPlan {
    readonly projects: readonly ProjectDescriptor[];
    readonly ignored: readonly string[];
}
export interface DegradedWatchRoot {
    readonly root: string;
    readonly phase: 'setup' | 'runtime';
    readonly error: Error;
}
export interface WatchPlanStatus {
    readonly promoted: boolean;
    readonly watchedRoots: readonly string[];
    readonly degradedRoots: readonly DegradedWatchRoot[];
}
export interface WatchPlanController {
    replace(plan: WatchPlan): Promise<WatchPlanStatus>;
    inspect(): WatchPlanStatus;
    close(): Promise<void>;
}
export interface CreateWatchPlanControllerOptions {
    readonly backend?: WatchBackend;
    readonly setupTimeoutMs?: number;
    readonly onEvent: (event: WatchEvent) => void;
    readonly onError?: (error: Error) => void;
    readonly onDegradedRoot?: (root: DegradedWatchRoot) => void;
}
/** Own live per-root Chokidar sessions and promote every viable successor atomically. */
export declare function createWatchPlanController(options: CreateWatchPlanControllerOptions): WatchPlanController;
//# sourceMappingURL=watcher.d.ts.map