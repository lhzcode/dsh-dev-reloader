import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, } from 'node:net';
import { PROTOCOL_VERSION, decodeBridgeEvent, decodeBridgeHello, decodeSupervisorCommand, decodeSupervisorEvent, } from '../shared/protocol.js';
import { ByteLineDecoder, IpcError, MAX_QUEUED_FRAMES, closeSocket, createInboundQueue as createQueueState, decodeEnvelope, disconnected, enqueueInboundFrames as enqueue, failInboundQueue as failQueue, privateListenOptions, protocolError, verifyUnixEndpoint, waitForSocketClose, writeFrame, } from './ipc-transport.js';
export { IpcError, privateListenOptions };
const NONCE_BYTES = 32;
const MAX_IN_FLIGHT_REQUESTS = 128;
const MAX_RECENT_REQUESTS = 1_024;
const MAX_SERVER_CONNECTIONS = 128;
const AUTHENTICATION_TIMEOUT_MS = 5_000;
const CLIENT_DOMAIN = 'dsh-dev-reloader/ipc/client-proof/v1';
const SERVER_DOMAIN = 'dsh-dev-reloader/ipc/server-proof/v1';
function validateToken(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new TypeError('IPC token must be exactly 32 random bytes encoded as lowercase hex');
    }
}
function createProof(token, domain, serverNonce, clientNonce) {
    return createHmac('sha256', token)
        .update(domain)
        .update('\0')
        .update(serverNonce)
        .update('\0')
        .update(clientNonce)
        .digest('hex');
}
function digestEqual(actual, expected) {
    if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) {
        return false;
    }
    const actualBytes = Buffer.from(actual, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return actualBytes.length === 32
        && expectedBytes.length === 32
        && timingSafeEqual(actualBytes, expectedBytes);
}
function requireExactEnvelope(envelope, type, fields) {
    if (envelope.type !== type) {
        throw protocolError(`expected ${type}`);
    }
    const allowedFields = new Set(['protocolVersion', 'type', ...fields]);
    for (const key of Object.keys(envelope)) {
        if (!allowedFields.has(key)) {
            throw protocolError(`${type} has unknown field: ${key}`);
        }
    }
}
function boundedError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 2_048
        ? message
        : `${message.slice(0, 2_047)}…`;
}
const SUPERVISOR_COMMAND_TYPES = new Set([
    'get-status',
    'update-config',
    'rebuild',
    'restart',
    'pause',
    'stop',
]);
function rememberRequestId(requestId, recent, recentOrder) {
    recent.add(requestId);
    recentOrder.push(requestId);
    if (recentOrder.length > MAX_RECENT_REQUESTS) {
        recent.delete(recentOrder.shift());
    }
}
function isSupervisorCommand(envelope) {
    return SUPERVISOR_COMMAND_TYPES.has(envelope.type);
}
export async function listenForBridges(options) {
    if (!options.endpoint) {
        throw new TypeError('IPC endpoint is required');
    }
    validateToken(options.token);
    const peers = new Set();
    let closed = false;
    let endpointVerified = process.platform === 'win32';
    const server = createServer(socket => {
        if (!endpointVerified || peers.size >= MAX_SERVER_CONNECTIONS) {
            socket.destroy();
            return;
        }
        const peerState = {
            socket,
            authenticated: false,
            hello: undefined,
            failed: false,
        };
        const queue = createQueueState();
        const decoder = new ByteLineDecoder();
        const serverNonce = randomBytes(NONCE_BYTES).toString('hex');
        const inFlight = new Set();
        const recent = new Set();
        const recentOrder = [];
        let authenticationTimer;
        peers.add(peerState);
        socket.on('error', () => undefined);
        socket.once('close', () => {
            if (authenticationTimer !== undefined) {
                clearTimeout(authenticationTimer);
            }
            peerState.failed = true;
            failQueue(queue);
            peers.delete(peerState);
        });
        const fail = (error) => {
            void error;
            if (peerState.failed)
                return;
            peerState.failed = true;
            failQueue(queue);
            socket.destroy();
        };
        authenticationTimer = setTimeout(() => fail(new IpcError('IPC_AUTHENTICATION_FAILED', 'IPC authentication timed out')), AUTHENTICATION_TIMEOUT_MS);
        authenticationTimer.unref();
        const currentPeer = () => {
            if (peerState.hello === undefined) {
                throw protocolError('bridge peer is not authenticated');
            }
            return {
                hello: peerState.hello,
                send: event => {
                    decodeSupervisorEvent(event);
                    return writeFrame(socket, event);
                },
            };
        };
        let handshakePhase = 'awaiting-init';
        let authenticatedClientNonce;
        const consume = async (frame) => {
            if (peerState.failed)
                return;
            const envelope = decodeEnvelope(frame);
            if (handshakePhase === 'awaiting-init') {
                requireExactEnvelope(envelope, 'authentication-init', ['clientNonce']);
                if (typeof envelope.clientNonce !== 'string'
                    || !/^[a-f0-9]{64}$/.test(envelope.clientNonce)) {
                    throw new IpcError('IPC_AUTHENTICATION_FAILED', 'invalid client nonce');
                }
                authenticatedClientNonce = envelope.clientNonce;
                handshakePhase = 'awaiting-hello';
                await writeFrame(socket, {
                    protocolVersion: PROTOCOL_VERSION,
                    type: 'authentication-proof',
                    serverProof: createProof(options.token, SERVER_DOMAIN, serverNonce, authenticatedClientNonce),
                });
                return;
            }
            if (handshakePhase === 'awaiting-hello') {
                let hello;
                try {
                    hello = decodeBridgeHello(envelope);
                }
                catch (error) {
                    throw new IpcError('IPC_AUTHENTICATION_FAILED', 'invalid bridge hello', { cause: error });
                }
                if (hello.clientNonce !== authenticatedClientNonce
                    || !digestEqual(hello.clientProof, createProof(options.token, CLIENT_DOMAIN, serverNonce, hello.clientNonce))) {
                    throw new IpcError('IPC_AUTHENTICATION_FAILED', 'bridge authentication failed');
                }
                if (!await options.validateHost(hello)) {
                    throw new IpcError('IPC_AUTHENTICATION_FAILED', 'bridge host validation failed');
                }
                if (peerState.failed || socket.destroyed)
                    return;
                peerState.hello = hello;
                peerState.authenticated = true;
                handshakePhase = 'authenticated';
                if (authenticationTimer !== undefined) {
                    clearTimeout(authenticationTimer);
                }
                await writeFrame(socket, {
                    protocolVersion: PROTOCOL_VERSION,
                    type: 'authentication-result',
                    ok: true,
                    serverProof: createProof(options.token, SERVER_DOMAIN, serverNonce, hello.clientNonce),
                });
                return;
            }
            if (isSupervisorCommand(envelope)) {
                const command = decodeSupervisorCommand(envelope);
                if (inFlight.has(command.requestId) || recent.has(command.requestId)) {
                    throw new IpcError('IPC_DUPLICATE_REQUEST', `duplicate IPC request id: ${command.requestId}`);
                }
                if (inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
                    throw protocolError('too many in-flight IPC requests');
                }
                inFlight.add(command.requestId);
                void Promise.resolve()
                    .then(() => options.onCommand?.(command, currentPeer()))
                    .then(outcome => {
                    if (peerState.failed)
                        return;
                    const result = outcome?.error === undefined
                        ? {
                            protocolVersion: PROTOCOL_VERSION,
                            type: 'command-result',
                            requestId: command.requestId,
                            ok: outcome?.ok ?? options.onCommand !== undefined,
                        }
                        : {
                            protocolVersion: PROTOCOL_VERSION,
                            type: 'command-result',
                            requestId: command.requestId,
                            ok: outcome.ok,
                            error: outcome.error,
                        };
                    return writeFrame(socket, result);
                })
                    .catch(error => {
                    if (peerState.failed)
                        return;
                    return writeFrame(socket, {
                        protocolVersion: PROTOCOL_VERSION,
                        type: 'command-result',
                        requestId: command.requestId,
                        ok: false,
                        error: boundedError(error),
                    }).catch(fail);
                })
                    .finally(() => {
                    inFlight.delete(command.requestId);
                    rememberRequestId(command.requestId, recent, recentOrder);
                });
                return;
            }
            await options.onEvent(decodeBridgeEvent(envelope), currentPeer());
        };
        void writeFrame(socket, {
            protocolVersion: PROTOCOL_VERSION,
            type: 'authentication-challenge',
            serverNonce,
        }).catch(fail);
        socket.on('data', chunk => enqueue(socket, queue, decoder, chunk, peerState.authenticated ? MAX_QUEUED_FRAMES : 1, consume, fail));
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(privateListenOptions(options.endpoint));
    });
    if (process.platform !== 'win32') {
        try {
            await verifyUnixEndpoint(options.endpoint);
            endpointVerified = true;
        }
        catch (error) {
            await new Promise(resolve => server.close(() => resolve()));
            throw error;
        }
    }
    server.on('error', () => undefined);
    let closePromise;
    return {
        endpoint: options.endpoint,
        get closed() {
            return closed;
        },
        get connectionCount() {
            return peers.size;
        },
        async broadcast(event) {
            decodeSupervisorEvent(event);
            const livePeers = [...peers].filter(peer => peer.authenticated
                && !peer.failed
                && !peer.socket.destroyed);
            await Promise.all(livePeers.map(peer => writeFrame(peer.socket, event)));
        },
        close() {
            if (closePromise !== undefined)
                return closePromise;
            closed = true;
            closePromise = (async () => {
                const waits = [...peers].map(peer => {
                    peer.failed = true;
                    peer.socket.destroy();
                    return waitForSocketClose(peer.socket);
                });
                await new Promise((resolve, reject) => {
                    server.close(error => error ? reject(error) : resolve());
                });
                await Promise.all(waits);
            })();
            return closePromise;
        },
    };
}
export async function connectToSupervisor(options) {
    if (!options.endpoint) {
        throw new TypeError('IPC endpoint is required');
    }
    validateToken(options.token);
    const socket = createConnection(options.endpoint);
    const decoder = new ByteLineDecoder();
    const queue = createQueueState();
    const pending = new Map();
    const recent = new Set();
    const recentOrder = [];
    let authenticated = false;
    let closed = false;
    let closing = false;
    let failed = false;
    const clientNonce = randomBytes(NONCE_BYTES).toString('hex');
    let settleAuthentication;
    const authentication = new Promise((resolve, reject) => {
        settleAuthentication = error => error === undefined
            ? resolve()
            : reject(error);
    });
    // A connection error can happen before this function reaches `await
    // authentication`; attaching a rejection observer now prevents an orphaned
    // promise from terminating the host while preserving the later await result.
    void authentication.catch(() => undefined);
    const rejectPending = (error) => {
        for (const request of pending.values()) {
            request.reject(error);
        }
        pending.clear();
    };
    const fail = (raw) => {
        if (failed)
            return;
        failed = true;
        failQueue(queue);
        const error = raw instanceof IpcError
            ? raw
            : protocolError('invalid IPC frame', raw);
        if (!authenticated) {
            settleAuthentication(error);
        }
        rejectPending(error);
        socket.destroy();
    };
    const authenticationTimer = setTimeout(() => fail(new IpcError('IPC_AUTHENTICATION_FAILED', 'IPC authentication timed out')), AUTHENTICATION_TIMEOUT_MS);
    authenticationTimer.unref();
    const onSocketError = (error) => {
        fail(disconnected('IPC connection failed', error));
    };
    socket.on('error', onSocketError);
    socket.once('close', () => {
        clearTimeout(authenticationTimer);
        closed = true;
        failed = true;
        failQueue(queue);
        const error = authenticated
            ? disconnected()
            : new IpcError('IPC_AUTHENTICATION_FAILED', 'IPC authentication did not complete');
        if (!authenticated) {
            settleAuthentication(error);
        }
        rejectPending(error);
    });
    let handshakePhase = 'awaiting-challenge';
    let authenticatedServerNonce;
    const consume = async (frame) => {
        if (failed)
            return;
        const envelope = decodeEnvelope(frame);
        if (handshakePhase === 'awaiting-challenge') {
            requireExactEnvelope(envelope, 'authentication-challenge', ['serverNonce']);
            if (typeof envelope.serverNonce !== 'string'
                || !/^[a-f0-9]{64}$/.test(envelope.serverNonce)) {
                throw new IpcError('IPC_AUTHENTICATION_FAILED', 'invalid authentication challenge');
            }
            authenticatedServerNonce = envelope.serverNonce;
            handshakePhase = 'awaiting-proof';
            await writeFrame(socket, {
                protocolVersion: PROTOCOL_VERSION,
                type: 'authentication-init',
                clientNonce,
            });
            return;
        }
        if (handshakePhase === 'awaiting-proof') {
            requireExactEnvelope(envelope, 'authentication-proof', ['serverProof']);
            if (authenticatedServerNonce === undefined
                || !digestEqual(envelope.serverProof, createProof(options.token, SERVER_DOMAIN, authenticatedServerNonce, clientNonce))) {
                throw new IpcError('IPC_AUTHENTICATION_FAILED', 'invalid server authentication proof');
            }
            const helloCandidate = {
                protocolVersion: PROTOCOL_VERSION,
                type: 'bridge-hello',
                ...options.hello,
                clientNonce,
                clientProof: createProof(options.token, CLIENT_DOMAIN, authenticatedServerNonce, clientNonce),
            };
            // Validate the actual JSON shape: undefined environment values are omitted
            // on wire and never accepted as any other value.
            const hello = decodeBridgeHello(JSON.parse(JSON.stringify(helloCandidate)));
            handshakePhase = 'awaiting-result';
            await writeFrame(socket, hello);
            return;
        }
        if (handshakePhase === 'awaiting-result') {
            requireExactEnvelope(envelope, 'authentication-result', ['ok', 'serverProof']);
            if (envelope.ok !== true
                || authenticatedServerNonce === undefined
                || !digestEqual(envelope.serverProof, createProof(options.token, SERVER_DOMAIN, authenticatedServerNonce, clientNonce))) {
                throw new IpcError('IPC_AUTHENTICATION_FAILED', 'invalid final authentication proof');
            }
            authenticated = true;
            handshakePhase = 'authenticated';
            clearTimeout(authenticationTimer);
            settleAuthentication();
            return;
        }
        const event = decodeSupervisorEvent(envelope);
        if (event.type === 'command-result') {
            const request = pending.get(event.requestId);
            if (request === undefined) {
                throw protocolError(`unknown command result request id: ${event.requestId}`);
            }
            pending.delete(event.requestId);
            rememberRequestId(event.requestId, recent, recentOrder);
            request.resolve(event.error === undefined
                ? { requestId: event.requestId, ok: event.ok }
                : {
                    requestId: event.requestId,
                    ok: event.ok,
                    error: event.error,
                });
            return;
        }
        await options.onEvent?.(event);
    };
    socket.on('data', chunk => enqueue(socket, queue, decoder, chunk, MAX_QUEUED_FRAMES, consume, fail));
    try {
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                socket.off('error', onConnectError);
                socket.off('connect', onConnect);
                socket.off('close', onConnectClose);
            };
            const onConnectError = (error) => {
                cleanup();
                reject(error);
            };
            const onConnectClose = () => {
                cleanup();
                reject(disconnected('IPC socket closed before connecting'));
            };
            const onConnect = () => {
                cleanup();
                resolve();
            };
            socket.once('error', onConnectError);
            socket.once('connect', onConnect);
            socket.once('close', onConnectClose);
        });
    }
    catch (error) {
        clearTimeout(authenticationTimer);
        if (!socket.destroyed)
            socket.destroy();
        throw disconnected('unable to connect to supervisor', error);
    }
    try {
        await authentication;
    }
    catch (error) {
        if (!socket.destroyed)
            socket.destroy();
        throw error;
    }
    let closePromise;
    return {
        get closed() {
            return closed;
        },
        emit(event) {
            if (closed || closing || failed)
                return Promise.reject(disconnected());
            decodeBridgeEvent(event);
            return writeFrame(socket, event);
        },
        request(command) {
            if (closed || closing || failed)
                return Promise.reject(disconnected());
            decodeSupervisorCommand(command);
            if (pending.has(command.requestId) || recent.has(command.requestId)) {
                return Promise.reject(new IpcError('IPC_DUPLICATE_REQUEST', `duplicate IPC request id: ${command.requestId}`));
            }
            if (pending.size >= MAX_IN_FLIGHT_REQUESTS) {
                return Promise.reject(protocolError('too many in-flight IPC requests'));
            }
            return new Promise((resolve, reject) => {
                pending.set(command.requestId, { resolve, reject });
                void writeFrame(socket, command).catch(error => {
                    pending.delete(command.requestId);
                    reject(error instanceof IpcError
                        ? error
                        : disconnected('failed to send IPC request', error));
                });
            });
        },
        close() {
            if (closePromise !== undefined)
                return closePromise;
            closing = true;
            closePromise = (async () => {
                rejectPending(disconnected('IPC client closed'));
                await closeSocket(socket);
                closed = true;
            })();
            return closePromise;
        },
    };
}
//# sourceMappingURL=ipc.js.map