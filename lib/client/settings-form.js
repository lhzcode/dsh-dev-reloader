export const EDITABLE_SETTINGS_FIELDS = [
    'enabled',
    'sourceRoots',
    'webUrl',
    'debounceMs',
    'healthTimeoutMs',
    'shutdownGraceMs',
    'bridgeGraceMs',
    'crashWindowMs',
    'maxCrashRestarts',
    'ignored',
    'projectOverrides',
    'logLevel',
];
const NATURAL_FIELDS = [
    'debounceMs',
    'healthTimeoutMs',
    'shutdownGraceMs',
    'bridgeGraceMs',
    'crashWindowMs',
    'maxCrashRestarts',
];
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
function lines(value) {
    return value.split(/\r?\n/u).map(entry => entry.trim()).filter(Boolean);
}
function natural(value) {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized))
        return undefined;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validCommand(value) {
    if (!isRecord(value))
        return false;
    return (value.executable === undefined || typeof value.executable === 'string')
        && (value.cwd === undefined || typeof value.cwd === 'string')
        && (value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')));
}
function validProjectOverrides(value) {
    return Array.isArray(value) && value.every(entry => (isRecord(entry)
        && typeof entry.root === 'string'
        && entry.root.length > 0
        && (entry.build === undefined || validCommand(entry.build))
        && (entry.devWeb === undefined || validCommand(entry.devWeb))));
}
function equalJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export function createSettingsDraft(config) {
    return {
        enabled: config.enabled,
        profile: config.profile,
        sourceRoots: config.sourceRoots.join('\n'),
        webUrl: config.webUrl ?? '',
        debounceMs: String(config.debounceMs),
        healthTimeoutMs: String(config.healthTimeoutMs),
        shutdownGraceMs: String(config.shutdownGraceMs),
        bridgeGraceMs: String(config.bridgeGraceMs),
        crashWindowMs: String(config.crashWindowMs),
        maxCrashRestarts: String(config.maxCrashRestarts),
        ignored: config.ignored.join('\n'),
        projectOverrides: JSON.stringify(config.projectOverrides, null, 2),
        logLevel: config.logLevel,
    };
}
export function parseSettingsDraft(draft) {
    const errors = {};
    const numbers = {};
    for (const field of NATURAL_FIELDS) {
        const value = natural(draft[field]);
        if (value === undefined)
            errors[field] = 'Enter a non-negative integer.';
        else
            numbers[field] = value;
    }
    let webUrl;
    const rawUrl = draft.webUrl.trim();
    if (rawUrl !== '') {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                throw new Error('protocol');
            webUrl = rawUrl;
        }
        catch {
            errors.webUrl = 'Enter an absolute HTTP or HTTPS URL.';
        }
    }
    let projectOverrides = [];
    try {
        const parsed = JSON.parse(draft.projectOverrides.trim() || '[]');
        if (!validProjectOverrides(parsed))
            throw new Error('shape');
        projectOverrides = parsed;
    }
    catch {
        errors.projectOverrides = 'Enter a JSON array of project override objects.';
    }
    if (!LOG_LEVELS.has(draft.logLevel)) {
        errors.logLevel = 'Choose debug, info, warn, or error.';
    }
    if (Object.keys(errors).length > 0)
        return { ok: false, errors };
    const value = {
        enabled: draft.enabled,
        profile: draft.profile,
        sourceRoots: lines(draft.sourceRoots),
        ...(webUrl === undefined ? {} : { webUrl }),
        debounceMs: numbers.debounceMs,
        healthTimeoutMs: numbers.healthTimeoutMs,
        shutdownGraceMs: numbers.shutdownGraceMs,
        bridgeGraceMs: numbers.bridgeGraceMs,
        crashWindowMs: numbers.crashWindowMs,
        maxCrashRestarts: numbers.maxCrashRestarts,
        ignored: lines(draft.ignored),
        projectOverrides,
        logLevel: draft.logLevel,
    };
    return { ok: true, value };
}
export function settingsOpsFromDraft(current, draft) {
    const parsed = parseSettingsDraft(draft);
    if (!parsed.ok)
        return parsed;
    const next = parsed.value;
    const ops = [];
    for (const field of EDITABLE_SETTINGS_FIELDS) {
        if (equalJson(current[field], next[field]))
            continue;
        if (field === 'webUrl' && next.webUrl === undefined) {
            ops.push({ op: 'unset', path: [field] });
        }
        else {
            ops.push({ op: 'set', path: [field], value: next[field] });
        }
    }
    return { ok: true, value: next, ops };
}
export function resetSettingsOps() {
    return EDITABLE_SETTINGS_FIELDS.map(field => ({ op: 'unset', path: [field] }));
}
//# sourceMappingURL=settings-form.js.map