import { SettingsConflictError, } from '@deepseek-ai/dsh-settings';
import { BRIDGE_PREFIX, authorizeCommandRequest, readRequestBody } from './routes.js';
export const SETTINGS_PATH = `${BRIDGE_PREFIX}/settings`;
export const MAX_SETTINGS_BODY_BYTES = 64 * 1024;
export const MAX_SETTINGS_OPS = 64;
const EDITABLE_FIELDS = new Set([
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
]);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(record, allowed) {
    const keys = Object.keys(record);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
function isJsonValue(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object')
        return false;
    if (seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.every((entry) => isJsonValue(entry, seen));
    const record = value;
    return Object.keys(record).every((key) => (key !== '__proto__'
        && key !== 'prototype'
        && key !== 'constructor'
        && isJsonValue(record[key], seen)));
}
export function parseSettingsMutation(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, status: 400, error: 'invalid JSON body' };
    }
    if (!isRecord(parsed))
        return { ok: false, status: 400, error: 'settings body must be an object' };
    const bodyKeys = Object.keys(parsed);
    if (!bodyKeys.every((key) => key === 'ops' || key === 'expectedRevision') || !bodyKeys.includes('ops')) {
        return { ok: false, status: 400, error: 'malformed settings body' };
    }
    const expectedRevision = parsed.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        return { ok: false, status: 400, error: 'expectedRevision must be a non-negative integer' };
    }
    if (!Array.isArray(parsed.ops))
        return { ok: false, status: 400, error: 'ops must be an array' };
    if (parsed.ops.length > MAX_SETTINGS_OPS) {
        return { ok: false, status: 413, error: `too many settings operations (maximum ${MAX_SETTINGS_OPS})` };
    }
    const ops = [];
    for (const candidate of parsed.ops) {
        if (!isRecord(candidate) || (candidate.op !== 'set' && candidate.op !== 'unset')) {
            return { ok: false, status: 400, error: 'malformed settings operation' };
        }
        const expectedKeys = candidate.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'];
        if (!hasOnlyKeys(candidate, expectedKeys)) {
            return { ok: false, status: 400, error: 'malformed settings operation' };
        }
        if (!Array.isArray(candidate.path)
            || candidate.path.length !== 1
            || typeof candidate.path[0] !== 'string'
            || !EDITABLE_FIELDS.has(candidate.path[0])) {
            return { ok: false, status: 400, error: 'unknown or immutable settings field' };
        }
        const path = [candidate.path[0]];
        if (candidate.op === 'set') {
            if (!isJsonValue(candidate.value)) {
                return { ok: false, status: 400, error: 'settings value must be JSON-shaped' };
            }
            ops.push({ op: 'set', path, value: candidate.value });
        }
        else {
            ops.push({ op: 'unset', path });
        }
    }
    return {
        ok: true,
        ops,
        ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision }),
    };
}
function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function forwarded(req) {
    return req.headers['x-forwarded-for'] !== undefined
        || req.headers['x-forwarded-host'] !== undefined
        || req.headers.forwarded !== undefined;
}
function sendJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}
function sendDescriptor(res, deps) {
    const descriptor = deps.describe();
    if (descriptor === undefined) {
        sendJson(res, 503, { error: 'settings namespace is unavailable' });
        return;
    }
    sendJson(res, 200, { ok: true, descriptor });
}
export function createSettingsRoute(deps) {
    const handler = async (req, res) => {
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        if (!isLoopback(req.socket.remoteAddress) || forwarded(req)) {
            sendJson(res, 403, { error: 'forbidden: direct loopback only' });
            return;
        }
        if (method === 'GET') {
            sendDescriptor(res, deps);
            return;
        }
        const headers = req.headers;
        const auth = authorizeCommandRequest({
            remoteAddress: req.socket.remoteAddress,
            forwarded: forwarded(req),
            origin: typeof headers.origin === 'string' ? headers.origin : undefined,
            host: typeof headers.host === 'string' ? headers.host : undefined,
            contentType: typeof headers['content-type'] === 'string' ? headers['content-type'] : undefined,
        });
        if (!auth.ok) {
            sendJson(res, auth.status, { error: auth.error });
            return;
        }
        const current = deps.describe();
        if (current === undefined) {
            sendJson(res, 503, { error: 'settings namespace is unavailable' });
            return;
        }
        if (!current.writable) {
            sendJson(res, 403, { error: 'settings document is read-only' });
            return;
        }
        const body = await readRequestBody(req, MAX_SETTINGS_BODY_BYTES);
        if (body.kind === 'too-large') {
            sendJson(res, 413, { error: `request body exceeds ${MAX_SETTINGS_BODY_BYTES} bytes` });
            return;
        }
        const parsed = parseSettingsMutation(body.text);
        if (!parsed.ok) {
            sendJson(res, parsed.status, { error: parsed.error });
            return;
        }
        try {
            await deps.mutate(parsed.ops, parsed.expectedRevision);
        }
        catch (error) {
            if (error instanceof SettingsConflictError || (error instanceof Error && error.name === 'SettingsConflictError')) {
                sendJson(res, 409, { error: 'settings changed; reload and try again' });
            }
            else {
                sendJson(res, 500, { error: 'settings update failed' });
            }
            return;
        }
        sendDescriptor(res, deps);
    };
    return { kind: 'exact', path: SETTINGS_PATH, handler };
}
/**
 * Register one canonical settings section and expose its redacted descriptor
 * through the rc.6 compatibility route. The route is only a transport adapter:
 * every read and write remains owned by the injected SettingsProvider.
 */
export function installSettingsBridgeSection(ctx, ns, schema, entry, registerRoute, hooks) {
    ctx.inject(['settings'], (sctx) => {
        const scope = sctx.settings.register(ns, schema, {
            base: entry,
            ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
        });
        hooks.setSource(() => scope.get());
        sctx.effect(() => () => {
            const state = ctx.fiber.state;
            if (state === 4 || state === 5)
                return;
            hooks.setSource(() => entry);
            hooks.onChange();
        });
        hooks.onChange();
        scope.watch(() => {
            const state = ctx.fiber.state;
            if (state === 4 || state === 5)
                return;
            hooks.onChange();
        });
        const describe = () => {
            const descriptor = sctx.settings
                .describe({ redactSecrets: true })
                .find((candidate) => candidate.ns === ns);
            if (descriptor === undefined)
                return undefined;
            return {
                value: descriptor.value,
                base: descriptor.base,
                user: descriptor.user,
                revision: descriptor.revision,
                writable: sctx.settings.writable,
            };
        };
        const route = createSettingsRoute({
            describe,
            mutate: (ops, expectedRevision) => sctx.settings.mutate(ns, ops, expectedRevision),
        });
        sctx.effect(() => registerRoute(route), 'dsh-dev-reloader: settings bridge route');
    });
}
//# sourceMappingURL=settings.js.map