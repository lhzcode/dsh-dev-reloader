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
export const RECOVERY_MARKER_KEY = 'dsh.devReloader.recovery.v1';
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
export function decideRecovery(state, probe) {
    if (!probe.healthy || !probe.bridgeReady || probe.bootId === undefined) {
        return { type: 'stay' };
    }
    if (state.phase === 'reloading') {
        return { type: 'clear' };
    }
    if (state.savedBootId !== undefined && probe.bootId === state.savedBootId) {
        return { type: 'stay' };
    }
    return { type: 'reload', bootId: probe.bootId };
}
//# sourceMappingURL=reconnect.js.map