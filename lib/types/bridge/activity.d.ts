import type { ActivitySnapshot } from '../shared/protocol.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs';
/** Narrow structural view of an agent used by the activity adapter. */
export type ActivityAgent = Agent;
/** Narrow structural view of a background job snapshot used by the activity adapter. */
export type ActivityJob = Pick<JobSnapshot, 'id' | 'status'>;
/** Narrow view of one Cordis `hmr/reload` Reload entry. */
export interface ActivityReloadEntry {
    readonly filename: string;
}
export interface ActivityObserverOptions {
    /** Top-level agents, whose `running` count seeds the snapshot. */
    readonly roots: () => readonly ActivityAgent[];
    /** All live agents, used to enumerate owner-scoped jobs. */
    readonly listAll: () => readonly ActivityAgent[];
    /** Jobs visible for one agent, or unowned jobs when no caller is supplied. */
    readonly listJobs: (agent?: ActivityAgent) => readonly ActivityJob[];
    /** Subscribe to `agent/status` notifications; returns a disposer. */
    readonly subscribeAgentStatus: (handler: () => void) => () => void;
    /** Subscribe to job-set changes; returns a disposer. */
    readonly subscribeJobsChanged: (handler: () => void) => () => void;
    /** Subscribe to Cordis `hmr/reload`; payload is the reload map. */
    readonly subscribeReload: (handler: (reloads: ReadonlyMap<unknown, ActivityReloadEntry>) => void) => () => void;
    /** Publish a freshly computed activity snapshot. */
    readonly publish: (snapshot: ActivitySnapshot) => void;
    /** Forward a set of reloaded entry identities to the supervisor. */
    readonly publishReload?: (entries: readonly string[]) => void;
    /** Clock used for snapshot `capturedAt`; defaults to `Date.now`. */
    readonly now?: () => number;
}
export interface ActivityObserver {
    /** Compute and return a fresh snapshot, advancing the monotonic sequence. */
    snapshot(): ActivitySnapshot;
    /** Subscribe all event sinks; returns a disposer that unsubscribes them. */
    start(): () => void;
    /** Extract reloaded entry filenames and forward them. */
    forwardReload(reloads: ReadonlyMap<unknown, ActivityReloadEntry>): void;
}
export declare function createActivityObserver(options: ActivityObserverOptions): ActivityObserver;
//# sourceMappingURL=activity.d.ts.map