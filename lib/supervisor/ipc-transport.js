import { Buffer } from 'node:buffer';
import { chmod, lstat } from 'node:fs/promises';
import { MAX_FRAME_BYTES, parseWireEnvelope, } from '../shared/protocol.js';
export class IpcError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'IpcError';
        this.code = code;
    }
}
export const MAX_QUEUED_FRAMES = 16;
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2;
const MAX_OUTBOUND_FRAMES = 16;
const MAX_OUTBOUND_BYTES = MAX_FRAME_BYTES * 2;
const CLOSE_GRACE_MS = 100;
function errorOptions(cause) {
    return cause === undefined ? undefined : { cause };
}
export function protocolError(message, cause) {
    return new IpcError('IPC_PROTOCOL_ERROR', message, errorOptions(cause));
}
export function disconnected(message = 'IPC peer disconnected', cause) {
    return new IpcError('IPC_DISCONNECTED', message, errorOptions(cause));
}
export class ByteLineDecoder {
    parts = [];
    byteLength = 0;
    push(chunk) {
        const lines = [];
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            const end = newline === -1 ? chunk.length : newline;
            this.append(chunk.subarray(offset, end));
            if (newline === -1)
                break;
            lines.push(this.takeLine());
            offset = newline + 1;
        }
        return lines;
    }
    append(part) {
        if (this.byteLength + part.length > MAX_FRAME_BYTES) {
            throw new IpcError('IPC_FRAME_TOO_LARGE', `IPC frame exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        if (part.length === 0)
            return;
        this.parts.push(part);
        this.byteLength += part.length;
    }
    takeLine() {
        const line = this.parts.length === 1
            ? this.parts[0]
            : Buffer.concat(this.parts, this.byteLength);
        this.parts.length = 0;
        this.byteLength = 0;
        return line.length > 0 && line[line.length - 1] === 0x0d
            ? line.subarray(0, -1)
            : line;
    }
}
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
export function decodeEnvelope(frame) {
    if (frame.length === 0) {
        throw protocolError('empty IPC frame');
    }
    try {
        return parseWireEnvelope(fatalUtf8.decode(frame));
    }
    catch (error) {
        throw protocolError('invalid IPC wire frame', error);
    }
}
function encodeFrame(value) {
    let encoded;
    try {
        encoded = Buffer.from(`${JSON.stringify(value)}\n`);
    }
    catch (error) {
        throw protocolError('IPC frame is not serializable', error);
    }
    if (encoded.length - 1 > MAX_FRAME_BYTES) {
        throw new IpcError('IPC_FRAME_TOO_LARGE', `IPC frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    return encoded;
}
class BoundedSocketWriter {
    socket;
    queue = [];
    active;
    queuedBytes = 0;
    failed;
    constructor(socket) {
        this.socket = socket;
        socket.once('close', () => this.abort(disconnected()));
    }
    write(value) {
        if (this.failed !== undefined)
            return Promise.reject(this.failed);
        if (this.socket.destroyed || !this.socket.writable) {
            return Promise.reject(disconnected());
        }
        const frame = encodeFrame(value);
        const frameCount = this.queue.length + (this.active === undefined ? 0 : 1);
        if (frameCount + 1 > MAX_OUTBOUND_FRAMES
            || this.queuedBytes + frame.length > MAX_OUTBOUND_BYTES) {
            const error = protocolError('IPC outbound queue limit exceeded');
            this.abort(error);
            this.socket.destroy(error);
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            this.queuedBytes += frame.length;
            this.queue.push({ frame, resolve, reject });
            this.pump();
        });
    }
    abort(error) {
        if (this.failed !== undefined)
            return;
        this.failed = error;
        if (this.active !== undefined) {
            this.queuedBytes -= this.active.frame.length;
            this.active.reject(error);
            this.active = undefined;
        }
        for (const pending of this.queue.splice(0)) {
            this.queuedBytes -= pending.frame.length;
            pending.reject(error);
        }
    }
    pump() {
        if (this.failed !== undefined || this.active !== undefined)
            return;
        const pending = this.queue.shift();
        if (pending === undefined)
            return;
        this.active = pending;
        const settle = (error) => {
            if (this.active !== pending)
                return;
            this.active = undefined;
            this.queuedBytes -= pending.frame.length;
            if (error === null || error === undefined) {
                pending.resolve();
            }
            else {
                const failure = disconnected('failed to write IPC frame', error);
                pending.reject(failure);
                this.abort(failure);
            }
            this.pump();
        };
        try {
            this.socket.write(pending.frame, settle);
        }
        catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
        }
    }
}
const writers = new WeakMap();
function socketWriter(socket) {
    let writer = writers.get(socket);
    if (writer === undefined) {
        writer = new BoundedSocketWriter(socket);
        writers.set(socket, writer);
    }
    return writer;
}
export function writeFrame(socket, value) {
    return socketWriter(socket).write(value);
}
export function waitForSocketClose(socket) {
    return socket.destroyed
        ? Promise.resolve()
        : new Promise(resolve => socket.once('close', resolve));
}
export async function closeSocket(socket) {
    if (socket.destroyed)
        return;
    const closed = waitForSocketClose(socket);
    socket.end();
    const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
    timer.unref();
    await closed;
    clearTimeout(timer);
}
/**
 * Do not widen Windows named-pipe access. Node still relies on the current
 * user's default DACL; this module does not claim or emulate custom ACL support.
 */
export function privateListenOptions(endpoint, platform = process.platform) {
    return platform === 'win32'
        ? { path: endpoint, readableAll: false, writableAll: false }
        : endpoint;
}
export async function verifyUnixEndpoint(endpoint) {
    const before = await lstat(endpoint);
    if (!before.isSocket() || before.isSymbolicLink()) {
        throw new Error(`IPC endpoint is not a Unix socket: ${endpoint}`);
    }
    const uid = typeof process.getuid === 'function'
        ? process.getuid()
        : undefined;
    if (uid !== undefined && before.uid !== uid) {
        throw new Error(`IPC socket is not owned by current user: ${endpoint}`);
    }
    await chmod(endpoint, 0o600);
    const after = await lstat(endpoint);
    if (!after.isSocket()
        || after.isSymbolicLink()
        || after.dev !== before.dev
        || after.ino !== before.ino) {
        throw new Error(`IPC socket changed during permission validation: ${endpoint}`);
    }
    if (uid !== undefined && after.uid !== uid) {
        throw new Error(`IPC socket owner changed during validation: ${endpoint}`);
    }
    if ((after.mode & 0o777) !== 0o600) {
        throw new Error(`IPC socket mode is not 0600: ${endpoint}`);
    }
}
export function createInboundQueue() {
    return {
        frames: [],
        bytes: 0,
        processing: false,
        failed: false,
    };
}
export function failInboundQueue(state) {
    state.failed = true;
    state.frames.length = 0;
    state.bytes = 0;
}
function resumeQueueIfReady(socket, state) {
    if (!state.failed
        && !state.processing
        && !socket.destroyed) {
        socket.resume();
    }
}
export function enqueueInboundFrames(socket, state, decoder, chunk, maxFrames, consume, fail) {
    if (state.failed)
        return;
    socket.pause();
    let frames;
    try {
        frames = decoder.push(chunk);
    }
    catch (error) {
        fail(error);
        return;
    }
    const bytes = frames.reduce((total, frame) => total + frame.length, 0);
    if (state.frames.length + frames.length > maxFrames
        || state.bytes + bytes > MAX_QUEUED_BYTES) {
        fail(protocolError('IPC receive queue limit exceeded'));
        return;
    }
    state.frames.push(...frames);
    state.bytes += bytes;
    if (state.processing)
        return;
    state.processing = true;
    void (async () => {
        while (!state.failed && state.frames.length > 0) {
            const frame = state.frames.shift();
            state.bytes -= frame.length;
            await consume(frame);
        }
        state.processing = false;
        resumeQueueIfReady(socket, state);
    })().catch(fail);
}
//# sourceMappingURL=ipc-transport.js.map