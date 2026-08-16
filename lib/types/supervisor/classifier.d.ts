import type { CommandTemplate } from '../shared/protocol.js';
import type { ProjectDescriptor } from './discovery.js';
export type Impact = 'ignore' | 'config-hmr' | 'server-hmr' | 'client-hmr' | 'full-restart';
export type ChangePathOrigin = 'project' | 'workspace';
export interface ChangeEvent {
    readonly project: ProjectDescriptor;
    /** POSIX-normalized path relative to the selected origin root. */
    readonly path: string;
    /** Defaults to project for compatibility with project-root watchers. */
    readonly origin?: ChangePathOrigin;
}
interface ActionBase {
    readonly impact: Exclude<Impact, 'ignore'>;
    readonly projectId: string;
}
export type ChangeAction = (ActionBase & {
    readonly kind: 'dependency-install';
    readonly command: CommandTemplate;
}) | (ActionBase & {
    readonly kind: 'build';
    readonly command: CommandTemplate;
}) | (ActionBase & {
    readonly kind: 'client-watch';
    readonly command: CommandTemplate;
}) | (ActionBase & {
    readonly kind: 'config-hmr';
    readonly path: string;
}) | (ActionBase & {
    readonly kind: 'server-hmr';
    readonly path: string;
}) | (ActionBase & {
    readonly kind: 'full-restart';
    readonly path: string;
    readonly reason: 'dependency' | 'manifest' | 'runtime';
});
export interface ChangePlan {
    readonly impact: Impact;
    readonly actions: readonly ChangeAction[];
}
export declare function classifyChange(event: ChangeEvent): ChangeAction[];
export declare function classifyChange(project: ProjectDescriptor, relativePath: string, origin?: ChangePathOrigin): ChangeAction[];
/** Deduplicate operational work, preserve independent action kinds, and select maximum impact. */
export declare function mergeActions(actions: readonly ChangeAction[]): ChangePlan;
export {};
//# sourceMappingURL=classifier.d.ts.map