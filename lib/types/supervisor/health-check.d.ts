export interface HealthCheckRequest {
    readonly webUrl: string;
    readonly expectedBootId: string;
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly observeBridgeBootId: () => string | undefined | Promise<string | undefined>;
    readonly signal?: AbortSignal;
    readonly request?: (url: string, signal: AbortSignal) => Promise<boolean>;
}
export interface HealthObservation {
    readonly healthy: boolean;
    readonly httpReady: boolean;
    readonly bridgeReady: boolean;
    readonly expectedBootId: string;
    readonly observedBootId?: string;
}
export declare function waitForHostHealth(request: HealthCheckRequest): Promise<HealthObservation>;
//# sourceMappingURL=health-check.d.ts.map