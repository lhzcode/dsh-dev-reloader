/** macOS sockaddr_un.sun_path is 104 bytes including its trailing NUL. */
export declare const MAX_UNIX_SOCKET_PATH_BYTES = 103;
export interface RuntimePaths {
    readonly platform: NodeJS.Platform;
    readonly dshHome: string;
    readonly profile: string;
    readonly stateDir: string;
    readonly endpoint: string;
    /** Filesystem directory containing the Unix socket; absent for a named pipe. */
    readonly endpointDir?: string;
    /** Whether the endpoint uses the state directory, a private tmp fallback, or a named pipe. */
    readonly endpointDirKind: 'state' | 'temporary' | 'named-pipe';
    readonly tokenFile: string;
    readonly lockFile: string;
    readonly guardFile: string;
    readonly logFile: string;
}
export interface RuntimePathOptions {
    readonly dshHome?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly profile: string;
    readonly platform?: NodeJS.Platform;
}
export interface AtomicWriteHooks {
    /** Test seam after rename, immediately before the durability fsync. */
    beforeDirectorySync?(directory: string): void | Promise<void>;
}
export declare function resolveRuntimePaths(options: RuntimePathOptions): Promise<RuntimePaths>;
/** Remove a stale Unix socket after the caller has acquired the supervisor lock. */
export declare function removeStaleSupervisorSocket(paths: RuntimePaths): Promise<void>;
/** Write a same-directory temporary file, fsync it, then atomically rename it. */
export declare function writePrivateFileAtomic(path: string, content: string, platform?: NodeJS.Platform, hooks?: AtomicWriteHooks): Promise<void>;
//# sourceMappingURL=paths.d.ts.map