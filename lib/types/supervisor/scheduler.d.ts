import { type ChangeEvent, type ChangePlan } from './classifier.js';
export type BuildCycleResult = {
    readonly kind: 'success';
} | {
    readonly kind: 'build-failed';
    readonly error: string;
};
export interface ChangeSchedulerOptions {
    readonly debounceMs: number;
    readonly runBuilds: (plan: ChangePlan, signal: AbortSignal) => Promise<BuildCycleResult>;
    readonly onReady: (plan: ChangePlan) => void | Promise<void>;
}
export interface ChangeScheduler {
    enqueue(event: ChangeEvent): void;
    waitForIdle(): Promise<BuildCycleResult>;
    close(): Promise<void>;
}
export declare function createChangeScheduler(options: ChangeSchedulerOptions): ChangeScheduler;
//# sourceMappingURL=scheduler.d.ts.map