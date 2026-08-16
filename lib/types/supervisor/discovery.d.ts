import type { CommandTemplate } from '../shared/protocol.js';
export interface ProjectDescriptor {
    readonly id: string;
    readonly kind: 'dsh-checkout' | 'linked-plugin';
    readonly root: string;
    readonly workspaceRoot: string;
    readonly packageName?: string;
    readonly serverEntries: readonly string[];
    readonly clientEntries: readonly string[];
    readonly manifests: readonly string[];
    readonly build?: CommandTemplate;
    readonly devWeb?: CommandTemplate;
    readonly outputRoots: readonly string[];
}
export interface DiscoveryWarning {
    readonly code: 'DEPENDENCY_SPEC_TOO_LONG' | 'DSH_RUNTIME_ONLY' | 'INVALID_DSH_SOURCE_ROOT' | 'INVALID_PACKAGE_NAME' | 'LOCAL_BUNDLE_MISSING' | 'LOCAL_BUNDLE_NOT_DIRECTORY' | 'PACKAGE_MANIFEST_INVALID' | 'PACKAGE_MANIFEST_MISSING' | 'PACKAGE_MANIFEST_READ_FAILED' | 'PACKAGE_MANIFEST_TOO_LARGE' | 'PACKAGE_NAME_MISMATCH' | 'PROFILE_BUNDLES_LIMIT_EXCEEDED' | 'PROFILE_CANDIDATES_LIMIT_EXCEEDED' | 'PROFILE_DEPENDENCIES_LIMIT_EXCEEDED' | 'PROFILE_MANIFEST_INVALID' | 'PROFILE_MANIFEST_READ_FAILED' | 'PROFILE_MANIFEST_TOO_LARGE' | 'WORKSPACE_CONFIG_INVALID' | 'WORKSPACE_CONFIG_READ_FAILED' | 'WORKSPACE_CONFIG_TOO_LARGE';
    readonly path: string;
    readonly message: string;
}
export interface DiscoveryResult {
    readonly projects: readonly ProjectDescriptor[];
    readonly warnings: readonly DiscoveryWarning[];
    readonly runtimeDshRoot?: string;
}
export interface DiscoverProjectsOptions {
    readonly dshHome: string;
    readonly profile: string;
    readonly sourceRoots: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly installedDshRoot?: string;
}
/** Discover buildable DSH checkouts and profile-linked DSH bundles from explicit process facts. */
export declare function discoverProjects(options: DiscoverProjectsOptions): Promise<DiscoveryResult>;
//# sourceMappingURL=discovery.d.ts.map