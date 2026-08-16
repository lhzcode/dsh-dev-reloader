import type { ActivitySnapshot } from '../shared/protocol.js';
export type GateClosedReason = 'bridge-unknown' | 'agents-running' | 'jobs-running' | 'jobs-stopping' | 'local-tasks';
export type GateDecision = {
    readonly open: true;
} | {
    readonly open: false;
    readonly reason: GateClosedReason;
};
export interface TaskGate {
    inspect(): GateDecision;
    updateActivity(snapshot: ActivitySnapshot): boolean;
    bridgeDisconnected(): void;
    bridgeReplaced(): void;
    beginLocalTask(label: string): () => void;
    waitUntilOpen(signal?: AbortSignal): Promise<void>;
}
export declare function createTaskGate(): TaskGate;
//# sourceMappingURL=task-gate.d.ts.map