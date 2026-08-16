/**
 * Once-only recovery decision for the browser settings card.
 *
 * The client plugin never contacts the supervisor or the daemon directly. After
 * the host announces an imminent full restart it records the current host
 * boot id in this page's sessionStorage (marker key `dsh.devReloader.recovery.v1`)
 * and begins polling the same-origin health/bridge surfaces through the typed
 * API helpers. Each poll feeds {@link decideRecovery} a state plus a probe; the
 * decision tells the card whether to keep waiting, perform a single
 * `location.reload()`, or clear the recovery marker once the reload landed
 * through a fresh page generation.
 *
 * The pure decision rule guarantees the "once-only" property: a reload is
 * requested exactly when a *new* boot id is healthy and bridge-ready and the
 * page is not already reloading. Any repetition of the same probe therefore
 * never yields a second reload.
 */
/** Marker key stored in sessionStorage while recovery is pending. */
export declare const RECOVERY_MARKER_KEY = "dsh.devReloader.recovery.v1";
/**
 * Recovery phase: `waiting` while polling for the new generation, `reloading`
 * once a `reload` decision was made (a new page is expected to clear the
 * marker and stop polling).
 */
export interface RecoveryState {
    readonly phase: 'waiting' | 'reloading';
    /** Boot id captured when the restart was planned. */
    readonly savedBootId: string | undefined;
}
/** A single poll result against the host health and bridge surfaces. */
export interface RecoveryProbe {
    /** The new host HTTP endpoint reports healthy. */
    readonly healthy: boolean;
    /** The bridge is reachable and advertising its boot id. */
    readonly bridgeReady: boolean;
    /** Current bridge boot id, if the bridge is serving one. */
    readonly bootId: string | undefined;
}
/**
 * What to do next. `stay` keeps polling; `reload` performs the single page
 * reload and moves into the `reloading` phase; `clear` drops the marker (the
 * reload already replaced this page generation).
 */
export type RecoveryDecision = {
    readonly type: 'stay';
} | {
    readonly type: 'reload';
    readonly bootId: string;
} | {
    readonly type: 'clear';
};
/**
 * Decide the next recovery action from a state/probe pair.
 *
 * - unhealthy or bridge-absent or unknown boot id → stay (keep waiting)
 * - already `reloading` and a healthy bridge-ready boot id is present → clear
 *   the marker: the single reload already replaced this generation, so any
 *   subsequent probe must never reload again.
 * - same boot id as the saved one while still `waiting` → stay (not yet changed)
 * - new boot id, healthy and bridge-ready while `waiting` → request the reload
 */
export declare function decideRecovery(state: RecoveryState, probe: RecoveryProbe): RecoveryDecision;
//# sourceMappingURL=reconnect.d.ts.map