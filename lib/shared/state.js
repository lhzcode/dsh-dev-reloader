export function createSupervisorState(at = Date.now()) {
    return { phase: 'starting', changedAt: at };
}
function nextState(state, phase, at, details = {}) {
    const boot = details.bootId ?? state.bootId;
    return boot === undefined
        ? { phase, changedAt: at, ...details }
        : { phase, changedAt: at, ...details, bootId: boot };
}
function illegal(state, event) {
    throw new Error(`illegal supervisor transition: ${state.phase} -> ${event.type}`);
}
export function transitionSupervisorState(state, event) {
    if (event.type === 'fail') {
        return nextState(state, 'failed', event.at, { error: event.error });
    }
    if (event.type === 'pause' && state.phase !== 'failed') {
        return nextState(state, 'paused', event.at);
    }
    if (event.type === 'degrade' && state.phase !== 'failed' && state.phase !== 'paused') {
        return nextState(state, 'degraded', event.at, { error: event.error });
    }
    switch (state.phase) {
        case 'starting':
            if (event.type === 'watch-ready') {
                return nextState(state, 'watching', event.at);
            }
            break;
        case 'watching':
            if (event.type === 'build-started') {
                return nextState(state, 'building', event.at, {
                    projects: [...event.projects],
                });
            }
            if (event.type === 'restart-pending') {
                return nextState(state, 'pending-restart', event.at, {
                    reason: event.reason,
                });
            }
            break;
        case 'building':
            if (event.type === 'build-succeeded') {
                return nextState(state, 'watching', event.at);
            }
            if (event.type === 'build-failed') {
                return nextState(state, 'degraded', event.at, { error: event.error });
            }
            if (event.type === 'hmr-wait') {
                return nextState(state, 'hmr-wait', event.at);
            }
            if (event.type === 'restart-pending') {
                return nextState(state, 'pending-restart', event.at, {
                    reason: event.reason,
                });
            }
            break;
        case 'hmr-wait':
            if (event.type === 'hmr-complete') {
                return nextState(state, 'watching', event.at);
            }
            if (event.type === 'restart-pending') {
                return nextState(state, 'pending-restart', event.at, {
                    reason: event.reason,
                });
            }
            break;
        case 'pending-restart':
            if (event.type === 'restart-ready') {
                return nextState(state, 'restarting', event.at);
            }
            break;
        case 'restarting':
            if (event.type === 'host-started') {
                return nextState(state, 'recovering', event.at, {
                    bootId: event.bootId,
                });
            }
            break;
        case 'recovering':
            if (event.type === 'recovered') {
                return nextState(state, 'watching', event.at);
            }
            break;
        case 'degraded':
            if (event.type === 'watch-ready') {
                return nextState(state, 'watching', event.at);
            }
            if (event.type === 'build-started') {
                return nextState(state, 'building', event.at, {
                    projects: [...event.projects],
                });
            }
            if (event.type === 'restart-pending') {
                return nextState(state, 'pending-restart', event.at, {
                    reason: event.reason,
                });
            }
            break;
        case 'paused':
            if (event.type === 'resume') {
                return nextState(state, 'starting', event.at);
            }
            break;
        case 'failed':
            if (event.type === 'resume') {
                return nextState(state, 'starting', event.at);
            }
            break;
    }
    return illegal(state, event);
}
const AUTHORIZATION_CREDENTIAL = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;&]+/gi;
const SENSITIVE_ASSIGNMENT = /\b([a-z0-9_.-]*(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|credential)[a-z0-9_.-]*\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi;
function redactSensitiveText(value) {
    return value
        .replace(AUTHORIZATION_CREDENTIAL, '$1[REDACTED]')
        .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]');
}
function redactAndTruncate(value, max) {
    const redacted = redactSensitiveText(value);
    return redacted.length <= max
        ? redacted
        : `${redacted.slice(0, max - 1)}…`;
}
export function toPublicStatus(state) {
    const status = {
        phase: state.phase,
        changedAt: state.changedAt,
    };
    if (state.reason !== undefined) {
        status.reason = redactAndTruncate(state.reason, 512);
    }
    if (state.projects !== undefined)
        status.projects = state.projects.slice(0, 32);
    if (state.error !== undefined) {
        status.error = redactAndTruncate(state.error, 2_048);
    }
    if (state.bootId !== undefined)
        status.bootId = state.bootId;
    return status;
}
//# sourceMappingURL=state.js.map