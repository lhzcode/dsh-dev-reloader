import { PROTOCOL_VERSION, } from '../shared/protocol.js';
/** Route URL prefix shared by the host status/health/command surfaces. */
export const BRIDGE_PREFIX = '/plugins/dsh-dev-reloader';
const STATUS_PATH = `${BRIDGE_PREFIX}/status`;
const HEALTH_PATH = `${BRIDGE_PREFIX}/health`;
const COMMAND_PATH = `${BRIDGE_PREFIX}/command`;
export const MAX_COMMAND_BODY_BYTES = 64 * 1024;
function jsonHeaders() {
    return { 'content-type': 'application/json; charset=utf-8' };
}
function sendJson(res, status, body) {
    res.writeHead(status, jsonHeaders());
    res.end(JSON.stringify(body));
}
function isLoopbackAddress(address) {
    if (address === undefined)
        return false;
    // Accept the bare loopback literals and the IPv4-mapped IPv6 loopback.
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1';
}
/**
 * Authorize an administrative command request: it must arrive directly from a
 * loopback peer, never through a proxy, never from another origin, and carry a
 * JSON content type.
 */
export function authorizeCommandRequest(meta) {
    if (!isLoopbackAddress(meta.remoteAddress)) {
        return { ok: false, status: 403, error: 'forbidden: non-loopback peer' };
    }
    if (meta.forwarded) {
        return {
            ok: false,
            status: 403,
            error: 'forbidden: forwarded request is not accepted',
        };
    }
    if (meta.origin !== undefined) {
        if (meta.host === undefined) {
            return { ok: false, status: 403, error: 'forbidden: origin without host' };
        }
        const expected = `http://${meta.host}`;
        if (meta.origin !== expected) {
            return { ok: false, status: 403, error: 'forbidden: cross-origin request' };
        }
    }
    if (meta.contentType === undefined || meta.contentType.split(';')[0].trim() !== 'application/json') {
        return { ok: false, status: 415, error: 'unsupported media type' };
    }
    return { ok: true };
}
/** Read a request body up to a byte bound, rejecting early on overflow. */
export async function readRequestBody(source, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of source) {
        let buffer;
        if (typeof chunk === 'string') {
            buffer = Buffer.from(chunk, 'utf8');
        }
        else if (Buffer.isBuffer(chunk)) {
            buffer = chunk;
        }
        else {
            const view = chunk;
            buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        }
        total += buffer.length;
        if (total > maxBytes)
            return { kind: 'too-large' };
        chunks.push(buffer);
    }
    return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') };
}
const KNOWN_COMMAND_TYPES = new Set([
    'get-status',
    'update-config',
    'rebuild',
    'restart',
    'pause',
    'stop',
]);
/** Parse and validate a JSON command body against the known supervisor commands. */
export function parseCommandBody(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { ok: false, status: 400, error: 'invalid JSON body' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: 'command body must be an object' };
    }
    const record = parsed;
    if (record.protocolVersion !== PROTOCOL_VERSION
        || typeof record.type !== 'string'
        || !KNOWN_COMMAND_TYPES.has(record.type)
        || typeof record.requestId !== 'string'
        || record.requestId.length === 0) {
        return { ok: false, status: 400, error: 'unknown or malformed command' };
    }
    const command = record;
    return { ok: true, command };
}
function fromRequest(req) {
    const headers = req.headers;
    const forwarded = headers['x-forwarded-for'] !== undefined
        || headers['x-forwarded-host'] !== undefined
        || headers['forwarded'] !== undefined;
    const contentType = typeof headers['content-type'] === 'string'
        ? headers['content-type']
        : undefined;
    const origin = typeof headers['origin'] === 'string'
        ? headers['origin']
        : undefined;
    const host = typeof headers['host'] === 'string'
        ? headers['host']
        : undefined;
    return {
        remoteAddress: req.socket.remoteAddress,
        forwarded,
        origin,
        host,
        contentType,
    };
}
export function createBridgeRoutes(deps) {
    const statusHandler = (_req, res) => {
        const status = deps.status();
        sendJson(res, 200, status ?? { phase: 'starting', changedAt: Date.now() });
    };
    const healthHandler = (_req, res) => {
        sendJson(res, 200, { ok: true, bootId: deps.bootId() });
    };
    const commandHandler = async (req, res) => {
        const auth = authorizeCommandRequest(fromRequest(req));
        if (!auth.ok) {
            sendJson(res, auth.status, { error: auth.error });
            return;
        }
        const body = await readRequestBody(req, MAX_COMMAND_BODY_BYTES);
        if (body.kind === 'too-large') {
            sendJson(res, 413, { error: `request body exceeds ${MAX_COMMAND_BODY_BYTES} bytes` });
            return;
        }
        const parsed = parseCommandBody(body.text);
        if (!parsed.ok) {
            sendJson(res, parsed.status, { error: parsed.error });
            return;
        }
        let result;
        try {
            result = await deps.sendCommand(parsed.command);
        }
        catch (error) {
            sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
            return;
        }
        sendJson(res, 200, { ok: result.ok, error: result.error });
    };
    return {
        status: { kind: 'exact', path: STATUS_PATH, handler: statusHandler },
        health: { kind: 'exact', path: HEALTH_PATH, handler: healthHandler },
        command: { kind: 'exact', path: COMMAND_PATH, handler: commandHandler },
    };
}
//# sourceMappingURL=routes.js.map