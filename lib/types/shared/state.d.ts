import type { PublicSupervisorStatus, SupervisorPhase } from './protocol.js';
export interface SupervisorState {
    readonly phase: SupervisorPhase;
    readonly changedAt: number;
    readonly reason?: string;
    readonly projects?: readonly string[];
    readonly error?: string;
    readonly bootId?: string;
}
export type SupervisorStateEvent = {
    readonly type: 'watch-ready';
    readonly at: number;
} | {
    readonly type: 'build-started';
    readonly at: number;
    readonly projects: readonly string[];
} | {
    readonly type: 'build-succeeded';
    readonly at: number;
} | {
    readonly type: 'build-failed';
    readonly at: number;
    readonly error: string;
} | {
    readonly type: 'hmr-wait';
    readonly at: number;
} | {
    readonly type: 'hmr-complete';
    readonly at: number;
} | {
    readonly type: 'restart-pending';
    readonly at: number;
    readonly reason: string;
} | {
    readonly type: 'restart-ready';
    readonly at: number;
} | {
    readonly type: 'host-started';
    readonly at: number;
    readonly bootId: string;
} | {
    readonly type: 'recovered';
    readonly at: number;
} | {
    readonly type: 'degrade';
    readonly at: number;
    readonly error: string;
} | {
    readonly type: 'fail';
    readonly at: number;
    readonly error: string;
} | {
    readonly type: 'pause';
    readonly at: number;
} | {
    readonly type: 'resume';
    readonly at: number;
};
export declare function createSupervisorState(at?: number): SupervisorState;
export declare function transitionSupervisorState(state: SupervisorState, event: SupervisorStateEvent): SupervisorState;
export declare function toPublicStatus(state: SupervisorState): PublicSupervisorStatus;
//# sourceMappingURL=state.d.ts.map