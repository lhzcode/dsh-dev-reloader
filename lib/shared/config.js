export const DEFAULT_SUPERVISOR_CONFIG = Object.freeze({
    enabled: true,
    profile: 'web',
    sourceRoots: Object.freeze([]),
    debounceMs: 250,
    healthTimeoutMs: 60_000,
    shutdownGraceMs: 10_000,
    bridgeGraceMs: 10_000,
    crashWindowMs: 60_000,
    maxCrashRestarts: 3,
    ignored: Object.freeze([]),
    projectOverrides: Object.freeze([]),
    logLevel: 'info',
});
//# sourceMappingURL=config.js.map