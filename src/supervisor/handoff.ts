import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SupervisorConfig } from '../shared/config.js'
import {
  PROTOCOL_VERSION,
  decodeLaunchSpec,
  validateSupervisorConfig,
  type HostLaunchSpec,
} from '../shared/protocol.js'
import {
  ByteLineDecoder,
  IpcError,
  closeSocket,
  createInboundQueue,
  decodeEnvelope,
  enqueueInboundFrames,
  privateListenOptions,
  protocolError,
  verifyUnixEndpoint,
  writeFrame,
} from './ipc-transport.js'
import { MAX_UNIX_SOCKET_PATH_BYTES, type RuntimePaths } from './paths.js'

/**
 * An immutable, in-memory description of the launch environment a new
 * supervisor must reproduce after taking over. Never written to disk or argv;
 * it travels only over the one-use authenticated handoff channel.
 */
export interface HandoffSnapshot {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transactionId: string
  readonly generation: number
  readonly launch: HostLaunchSpec
  readonly config: SupervisorConfig
}

export type HandoffPhase = 'idle' | 'prepared' | 'frozen' | 'committed' | 'aborted'

export type HandoffMessage =
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & {
      readonly type: 'handoff-snapshot'
      readonly snapshot: HandoffSnapshot
    })
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & { readonly type: 'handoff-prepared' })
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & { readonly type: 'handoff-freeze' })
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & { readonly type: 'handoff-commit' })
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & { readonly type: 'handoff-committed' })
  | ({ readonly protocolVersion: typeof PROTOCOL_VERSION } & {
      readonly type: 'handoff-abort'
      readonly reason?: string
    })

export interface HandoffChannel {
  send(message: HandoffMessage): Promise<void>
  onMessage(listener: (message: HandoffMessage) => void | Promise<void>): () => void
  /** Optional terminal notification so pending message waits can reject on close. */
  onClose?(listener: () => void): () => void
}

/** Old (lead) side hooks driving the prepare/commit/abort state machine. */
export interface HandoffLeadHooks {
  /** True only while the old supervisor is watching and healthy enough to hand off. */
  readyToPrepare(): boolean | Promise<boolean>
  /** Capture the in-memory launch environment; throws when it cannot be read. */
  createSnapshot(): HandoffSnapshot | Promise<HandoffSnapshot>
  /** Freeze the old supervisor so it stops accepting new mutations. */
  freezeMutations(): void | Promise<void>
  /** Atomically release the old supervisor's lock lease so a new owner can acquire it. */
  transferOwnership(): void | Promise<void>
  /** Resume the old supervisor fully (adapters and lifecycle intact) after an abort. */
  resume(): void | Promise<void>
}

/** State-machine seams a running supervisor exposes for self-handoff. */
export interface SupervisorHandoff {
  readonly phase: HandoffPhase
  prepare(): Promise<HandoffSnapshot>
  freeze(): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

/** Standby (follow) side hooks for accepting ownership and only then serving. */
export interface HandoffFollowHooks {
  /** Validate the incoming snapshot; throws when it is unreadable. */
  acceptSnapshot(snapshot: HandoffSnapshot): void | Promise<void>
  /** Atomically acquire the lock lease so this standby becomes the sole owner. */
  acquireOwnership(): void | Promise<void>
  /** Release the acquired lease after an abort/backoff; must be idempotent. */
  releaseOwnership(): void | Promise<void>
  /** Begin watching and serving only after ownership has committed. */
  beginServing(): void | Promise<void>
  /** True while this standby exclusively owns the endpoint after acquisition. */
  verifyStillOwner(): boolean | Promise<boolean>
}

const CLIENT_PROOF_DOMAIN = 'dsh-dev-reloader/handoff/client-proof/v1'
const SERVER_PROOF_DOMAIN = 'dsh-dev-reloader/handoff/server-proof/v1'
const NONCE_BYTES = 32
const AUTHENTICATION_TIMEOUT_MS = 5_000
const PROTOCOL_TIMEOUT_MS = 15_000

function digestEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) {
    return false
  }
  const actualBytes = Buffer.from(actual, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return actualBytes.length === 32
    && expectedBytes.length === 32
    && timingSafeEqual(actualBytes, expectedBytes)
}

function protocolTimeoutError(): Error {
  return protocolError('handoff protocol timed out')
}

/** Dispatchable endpoint that buffers inbound messages until a waiter claims one. */
interface MessageEndpoint {
  send(message: HandoffMessage): Promise<void>
  next(types: readonly HandoffMessage['type'][]): Promise<HandoffMessage>
}

function createMessageEndpoint(
  channel: HandoffChannel,
  timeoutMs = PROTOCOL_TIMEOUT_MS,
): MessageEndpoint {
  const inbox: HandoffMessage[] = []
  const waiters: Array<{
    readonly types: Set<string>
    readonly timer: ReturnType<typeof setTimeout> | undefined
    resolve(message: HandoffMessage): void
    reject(error: unknown): void
  }> = []

  const rejectAll = (error: unknown): void => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  const onTerminal = (): void => {
    rejectAll(new IpcError('IPC_DISCONNECTED', 'handoff channel closed before the protocol completed'))
  }
  const unsubscribe = channel.onClose?.(onTerminal)

  channel.onMessage(message => {
    const index = waiters.findIndex(waiter => waiter.types.has(message.type))
    if (index >= 0) {
      const waiter = waiters[index]!
      waiters.splice(index, 1)
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve(message)
      return
    }
    inbox.push(message)
  })

  return {
    send(message) {
      return channel.send(message)
    },
    next(types) {
      const allowed = new Set<string>(types)
      const index = inbox.findIndex(message => allowed.has(message.type))
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]!)
      return new Promise<HandoffMessage>((resolve, reject) => {
        const timer = typeof timeoutMs === 'number' && timeoutMs > 0
          ? setTimeout(() => {
              const waiterIndex = waiters.findIndex(waiter => waiter.resolve === resolve)
              if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)
              reject(protocolTimeoutError())
            }, timeoutMs)
          : undefined
        if (timer !== undefined) timer.unref?.()
        waiters.push({ types: allowed, resolve, reject, timer })
      })
    },
  }

  void unsubscribe
}

/** Await a hook that may return synchronously or as a promise, ignoring rejections. */
async function callHookSettled(hook: (() => void | Promise<void>)): Promise<void> {
  await Promise.resolve(hook()).catch(() => undefined)
}

/** Shared lead-side failure handling: notify the standby, resume, and re-throw. */
async function failHandoff(
  endpoint: MessageEndpoint,
  hooks: HandoffLeadHooks,
  error: unknown,
): Promise<never> {
  try {
    await endpoint.send({
      protocolVersion: PROTOCOL_VERSION,
      type: 'handoff-abort',
      reason: error instanceof Error ? error.message : String(error),
    })
  } catch {
    // The peer may already be gone; resume regardless.
  }
  await callHookSettled(hooks.resume)
  throw error
}

/** Old-supervisor handoff coordinator: validates, freezes, then commits ownership. */
export function createHandoffLead(
  hooks: HandoffLeadHooks,
  channel: HandoffChannel,
  options?: { readonly timeoutMs?: number },
): { readonly handoff: SupervisorHandoff } {
  const endpoint = createMessageEndpoint(channel, options?.timeoutMs)
  let phase: HandoffPhase = 'idle'

  const handoff: SupervisorHandoff = {
    get phase() {
      return phase
    },

    async prepare() {
      if (!(await hooks.readyToPrepare())) {
        await failHandoff(endpoint, hooks, new Error('supervisor is not watching or healthy enough to hand off'))
      }
      const captured = await Promise.resolve()
        .then(() => Promise.resolve(hooks.createSnapshot()))
        .catch((error: unknown) => failHandoff(endpoint, hooks, error))
      phase = 'prepared'
      await endpoint.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-snapshot',
        snapshot: captured,
      })
      const response = await endpoint.next(['handoff-prepared'])
      if (response.type !== 'handoff-prepared') {
        await failHandoff(endpoint, hooks, new Error('standby did not accept the handoff snapshot'))
      }
      return captured
    },

    async freeze() {
      if (phase === 'aborted') return
      try {
        await Promise.resolve(hooks.freezeMutations())
      } catch (error) {
        await failHandoff(endpoint, hooks, error)
      }
      // Release the old lease before the standby acquires so only one owner exists.
      try {
        await Promise.resolve(hooks.transferOwnership())
      } catch (error) {
        await failHandoff(endpoint, hooks, error)
      }
      // Ownership has moved even if the following transport exchange fails. Keep
      // the phase recoverable so the CLI can abort and reacquire rather than
      // leaving the old supervisor frozen and lease-less.
      phase = 'frozen'
      await endpoint.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-freeze' })
      const response = await endpoint.next(['handoff-commit', 'handoff-abort'])
      if (response.type === 'handoff-abort') {
        await callHookSettled(hooks.resume)
        phase = 'aborted'
        return
      }
    },

    async commit() {
      if (phase !== 'frozen') {
        await failHandoff(endpoint, hooks, new Error('ambiguous handoff ownership: old supervisor no longer owns the endpoint'))
      }
      phase = 'committed'
      await endpoint.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-committed' })
    },

    async abort() {
      if (phase === 'committed') return
      await endpoint.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-abort',
        reason: 'lead aborted',
      }).catch(() => undefined)
      await callHookSettled(hooks.resume)
      phase = 'aborted'
    },
  }

  return { handoff }
}

/**
 * Standby coordinator: accepts the snapshot, acquires ownership, and only begins
 * serving after the lead confirms with `handoff-committed`.
 */
export function createHandoffFollow(
  hooks: HandoffFollowHooks,
  channel: HandoffChannel,
  options?: { readonly timeoutMs?: number },
): { start(): Promise<void> } {
  const endpoint = createMessageEndpoint(channel, options?.timeoutMs)

  const start = async (): Promise<void> => {
    // Tracks whether this standby acquired the lease; acquired leases are always
    // released on abort/backoff so the lock is never left poisoned.
    let acquired = false
    const releaseIfAcquired = async (): Promise<void> => {
      if (!acquired) return
      acquired = false
      await callHookSettled(hooks.releaseOwnership)
    }
    const abortWith = async (reason: string): Promise<void> => {
      await endpoint.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-abort',
        reason,
      }).catch(() => undefined)
      await releaseIfAcquired()
    }

    try {
      const intent = await endpoint.next(['handoff-snapshot', 'handoff-abort'])
      if (intent.type !== 'handoff-snapshot') return
      try {
        await hooks.acceptSnapshot(intent.snapshot)
      } catch {
        await abortWith('snapshot unreadable')
        return
      }
      await endpoint.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-prepared' })

      const freezeOrAbort = await endpoint.next(['handoff-freeze', 'handoff-abort'])
      if (freezeOrAbort.type === 'handoff-abort') return
      try {
        await hooks.acquireOwnership()
        acquired = true
      } catch {
        await abortWith('ambiguous ownership')
        return
      }
      if (!(await hooks.verifyStillOwner())) {
        await abortWith('ambiguous ownership')
        return
      }
      await endpoint.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-commit' })

      const result = await endpoint.next(['handoff-committed', 'handoff-abort'])
      if (result.type === 'handoff-abort') {
        await releaseIfAcquired()
        return
      }
      // Ownership committed; stop releasing and begin serving.
      acquired = false
      await hooks.beginServing()
    } finally {
      await releaseIfAcquired()
    }
  }

  return { start }
}

// ---------------------------------------------------------------------------
// One-use authenticated local transport. The standby binds a fresh private
// endpoint; the old supervisor connects to it. Both derive mutual proof from
// the existing private token via HMAC challenge-response, so the token never
// crosses the wire. Each handoff uses a fresh transaction id and server nonce,
// and the endpoint/channel are consumed once after commit.
// ---------------------------------------------------------------------------

export interface HandoffTransportOptions {
  readonly endpoint: string
  readonly token: string
  readonly transactionId: string
}

function validateToken(token: string): void {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new TypeError('handoff token must be 64 lowercase hex characters')
  }
}

/** Fresh one-use handoff socket path keyed by transaction id, bounded for Unix. */
export function resolveHandoffEndpoint(paths: RuntimePaths, transactionId: string): string {
  if (paths.platform === 'win32') {
    return `\\\\.\\pipe\\dsh-dr-handoff-${transactionId}`
  }
  const local = join(paths.stateDir, `handoff-${transactionId}.sock`)
  if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH_BYTES) return local
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join(tmpdir(), `dsh-dr-handoff-${uid}-${transactionId.slice(0, 16)}.sock`)
}

function createProof(
  token: string,
  domain: string,
  transactionId: string,
  serverNonce: string,
  clientNonce: string,
): string {
  return createHmac('sha256', token)
    .update(domain)
    .update('\0')
    .update(transactionId)
    .update('\0')
    .update(serverNonce)
    .update('\0')
    .update(clientNonce)
    .digest('hex')
}

function verifyProof(
  actual: unknown,
  expected: string,
  label: string,
): void {
  if (!digestEqual(actual, expected)) {
    throw new IpcError('IPC_AUTHENTICATION_FAILED', `handoff ${label} authentication failed`)
  }
}

interface SocketChannel {
  readonly channel: HandoffChannel
  readonly close: () => Promise<void>
  readonly closed: () => boolean
}

/** Decode an authenticated handoff frame into a handoff message. */
function decodeHandoffMessage(envelope: Record<string, unknown>): HandoffMessage {
  if (envelope.protocolVersion !== PROTOCOL_VERSION || typeof envelope.type !== 'string') {
    throw protocolError('invalid handoff protocol version')
  }
  const base = { protocolVersion: PROTOCOL_VERSION }
  switch (envelope.type) {
    case 'handoff-snapshot':
      return { ...base, type: 'handoff-snapshot', snapshot: decodeSnapshot(envelope.snapshot) }
    case 'handoff-prepared':
    case 'handoff-freeze':
    case 'handoff-commit':
    case 'handoff-committed':
      return { ...base, type: envelope.type }
    case 'handoff-abort':
      return typeof envelope.reason === 'string'
        ? { ...base, type: 'handoff-abort', reason: envelope.reason }
        : { ...base, type: 'handoff-abort' }
    default:
      throw protocolError(`unexpected handoff frame: ${String(envelope.type)}`)
  }
}

function decodeSnapshot(value: unknown): HandoffSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('handoff snapshot must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.protocolVersion !== PROTOCOL_VERSION) throw protocolError('handoff snapshot protocol mismatch')
  if (typeof record.transactionId !== 'string' || record.transactionId.length === 0) {
    throw protocolError('handoff snapshot requires a transaction id')
  }
  if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation)) {
    throw protocolError('handoff snapshot requires a valid generation')
  }
  // Re-decode the launch environment and supervisor config with the shared
  // protocol validators so a malformed or oversized snapshot is rejected on the
  // standby instead of being applied unvalidated.
  const launch = decodeLaunchSpec(record.launch)
  validateSupervisorConfig(record.config)
  return {
    protocolVersion: PROTOCOL_VERSION,
    transactionId: record.transactionId,
    generation: record.generation,
    launch,
    config: record.config as SupervisorConfig,
  }
}

/** Standby-side snapshot validation exposed for tests and the transport hook. */
export { decodeSnapshot as decodeHandoffSnapshot }

function wrapSocketChannel(
  socket: Socket,
  transactionId: string,
): SocketChannel {
  const decoder = new ByteLineDecoder()
  const queue = createInboundQueue()
  const listeners = new Set<(message: HandoffMessage) => void | Promise<void>>()
  const closeHandlerSet = new Set<() => void>()
  const buffered: HandoffMessage[] = []
  let closed = false
  let failed = false

  const notifyTerminal = (): void => {
    for (const listener of [...closeHandlerSet]) {
      try {
        listener()
      } catch {
        // A close listener must never take down the socket teardown path.
      }
    }
  }

  const fail = (error: unknown): void => {
    if (failed) return
    failed = true
    void error
    notifyTerminal()
  }

  const deliver = async (message: HandoffMessage): Promise<void> => {
    if (listeners.size === 0) {
      // Hold a message that arrived before any coordinator subscribed so the
      // one RTT of the handoff protocol can never be lost to a startup race.
      buffered.push(message)
      return
    }
    for (const listener of [...listeners]) {
      await Promise.resolve(listener(message)).then(() => undefined, () => undefined)
    }
  }

  const channel: HandoffChannel = {
    async send(message): Promise<void> {
      if (closed || failed || socket.destroyed || !socket.writable) {
        throw new IpcError('IPC_DISCONNECTED', 'handoff channel is closed')
      }
      await writeFrame(socket, message)
    },
    onMessage(listener) {
      listeners.add(listener)
      const replay = buffered.splice(0)
      for (const message of replay) {
        void Promise.resolve(listener(message)).then(() => undefined, () => undefined)
      }
      return () => listeners.delete(listener)
    },
    onClose(listener) {
      closeHandlerSet.add(listener)
      return () => closeHandlerSet.delete(listener)
    },
  }

  const consume = async (frame: Buffer): Promise<void> => {
    const envelope = decodeEnvelope(frame)
    await deliver(decodeHandoffMessage(envelope))
  }

  socket.on('data', chunk => enqueueInboundFrames(
    socket,
    queue,
    decoder,
    chunk,
    16,
    consume,
    fail,
  ))
  socket.on('error', () => undefined)
  socket.once('close', notifyTerminal)

  return {
    channel,
    closed: () => closed || failed || socket.destroyed || !socket.writable,
    async close() {
      if (socket.destroyed) {
        closed = true
        notifyTerminal()
        return
      }
      await closeSocket(socket).catch(() => undefined)
      closed = true
      notifyTerminal()
    },
  }
}

export interface HandoffChannelHandle {
  readonly channel: HandoffChannel
  close(): Promise<void>
}

/** Standby side: bind a fresh one-use private endpoint and authenticate the lead. */
export async function listenForHandoff(options: HandoffTransportOptions): Promise<HandoffChannelHandle> {
  validateToken(options.token)
  const isWindows = process.platform === 'win32'
  let settled = false
  // resolve/reject are captured ahead of time so an early failing handshake can
  // never race past an unassigned `established` (F3 hang-close bug).
  let establishResolve!: (handle: HandoffChannelHandle) => void
  let establishReject!: (error: Error) => void
  const established = new Promise<HandoffChannelHandle>((resolve, reject) => {
    establishResolve = resolve
    establishReject = reject
  })
  // Guard the internal deferred from the instant it is created, and re-surface
  // its settle result on the caller-facing promise below, so an auth failure that
  // lands while this function is still awaiting server listening can never fire
  // as an orphaned rejection.
  established.catch(() => undefined)

  const server: Server = createServer(socket => {
    if (settled) {
      socket.destroy()
      return
    }
    const serverNonce = randomBytes(NONCE_BYTES).toString('hex')
    const decoder = new ByteLineDecoder()
    const queue = createInboundQueue()
    let channel: SocketChannel | undefined
    let clientNonce: string | undefined
    const timer = setTimeout(() => socket.destroy(), AUTHENTICATION_TIMEOUT_MS)
    timer.unref()
    socket.on('error', () => undefined)
    socket.once('close', () => clearTimeout(timer))

    const rejectAuth = (): void => {
      if (settled) return
      fail(new Error('handoff authentication failed'))
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      establishReject(error)
      void socket.destroy()
      void server.close()
    }

    const consume = async (frame: Buffer): Promise<void> => {
      const envelope = decodeEnvelope(frame)
      if (envelope.type !== 'handoff-auth') throw protocolError('expected handoff authentication')
      if (typeof envelope.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.nonce)) {
        throw protocolError('handoff authentication requires a client nonce')
      }
      clientNonce = envelope.nonce
      // The lead must prove it knows the token, keyed to its nonce.
      verifyProof(
        envelope.proof,
        createProof(options.token, CLIENT_PROOF_DOMAIN, options.transactionId, serverNonce, clientNonce),
        'client',
      )
      // Hand the socket over to the application channel; stop reading auth frames.
      socket.off('data', onAuthData)
      channel = wrapSocketChannel(socket, options.transactionId)
      // The standby proves it knows the token too, so authentication is mutual.
      await writeFrame(socket, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-auth-ok',
        serverNonce,
        proof: createProof(options.token, SERVER_PROOF_DOMAIN, options.transactionId, serverNonce, clientNonce),
      })
      if (!settled) {
        settled = true
        establishResolve({
          channel: channel.channel,
          close: async () => {
            server.unref()
            await Promise.allSettled([channel!.close(), closeServer()])
            await unlinkHandoffSocket()
          },
        })
      }
    }

    const onAuthData = (chunk: Buffer): void => {
      enqueueInboundFrames(
        socket,
        queue,
        decoder,
        chunk,
        1,
        consume,
        rejectAuth,
      )
    }
    socket.on('data', onAuthData)
    // Issue the challenge immediately; the lead replies with a proof derived only
    // from the shared token, so the token never crosses the wire.
    writeFrame(socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: 'handoff-auth-challenge',
      serverNonce,
    }).catch(() => fail(new Error('handoff authentication failed on write')))
  })

  let serverClosing = false
  const closeServer = (): Promise<void> => new Promise<void>(resolve => {
    if (serverClosed) { resolve(); return }
    if (serverClosing) {
      server.once('close', () => resolve())
      return
    }
    serverClosing = true
    server.close(error => {
      serverClosed = true
      if (error !== undefined) resolve()
      else resolve()
    })
  })
  let serverClosed = false

  const unlinkHandoffSocket = async (): Promise<void> => {
    if (isWindows) return
    await unlink(options.endpoint).catch(() => undefined)
  }

  server.on('error', () => undefined)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
    const onListening = (): void => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(privateListenOptions(options.endpoint))
  })
  if (!isWindows) {
    // The freshly created socket node can lag filesystem visibility briefly on
    // some platforms; retry the permission check so a transient ENOENT race right
    // after `server.listen` acknowledges is not mistaken for a broken one-use
    // endpoint. When a connection has already failed authentication, `fail()`
    // closes the server which unlinks the socket node — in that case ENOENT is
    // expected and the caller will receive the auth rejection from `established`.
    let verifyError: unknown
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await verifyUnixEndpoint(options.endpoint)
        verifyError = undefined
        break
      } catch (candidate) {
        verifyError = candidate
        if ((candidate as NodeJS.ErrnoException).code !== 'ENOENT') break
        if (settled) break // auth already failed and unlinked; established is rejected
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
    }
    if (verifyError !== undefined && !settled) {
      await closeServer()
      await unlinkHandoffSocket()
      throw verifyError
    }
  }

  // resolve/reject were captured before `listen()`, and the internal `established`
  // deferred is already guarded; the caller-facing promise re-surfaces its result.
  return new Promise<HandoffChannelHandle>((resolve, reject) => {
    established.then(resolve, reject)
  })
}

/** Old (lead) side: connect to the standby's one-use endpoint and authenticate. */
export async function connectForHandoff(options: HandoffTransportOptions): Promise<HandoffChannelHandle> {
  validateToken(options.token)
  const socket = createConnection(options.endpoint)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('error', onConnectError)
      socket.off('connect', onConnect)
      socket.off('close', onConnectClose)
    }
    const onConnectError = (error: Error): void => { cleanup(); reject(error) }
    const onConnectClose = (): void => { cleanup(); reject(new Error('handoff socket closed before connecting')) }
    const onConnect = (): void => { cleanup(); resolve() }
    socket.once('error', onConnectError)
    socket.once('connect', onConnect)
    socket.once('close', onConnectClose)
  })

  const decoder = new ByteLineDecoder()
  const queue = createInboundQueue()
  await new Promise<void>((resolve, reject) => {
    const clientNonce = randomBytes(NONCE_BYTES).toString('hex')
    let serverNonce: string | undefined
    let phase: 'challenge' | 'authed' = 'challenge'
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); reject(new Error('handoff authentication timed out')) }
    }, AUTHENTICATION_TIMEOUT_MS)
    timer.unref()
    socket.on('error', error => {
      if (!settled) { settled = true; reject(error) }
    })
    socket.once('close', () => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new Error('handoff socket closed during authentication'))
      }
    })

    const consume = async (frame: Buffer): Promise<void> => {
      const envelope = decodeEnvelope(frame)
      if (phase === 'challenge') {
        if (envelope.type !== 'handoff-auth-challenge' || typeof envelope.serverNonce !== 'string') {
          throw protocolError('expected handoff authentication challenge')
        }
        serverNonce = envelope.serverNonce
        phase = 'authed'
        // Prove the lead knows the token, bound to both a fresh client nonce and
        // the server's nonce so the derivation can never replay across endpoints.
        await writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          type: 'handoff-auth',
          nonce: clientNonce,
          proof: createProof(options.token, CLIENT_PROOF_DOMAIN, options.transactionId, envelope.serverNonce, clientNonce),
        })
        return
      }
      if (!settled && envelope.type === 'handoff-auth-ok') {
        if (typeof envelope.serverNonce !== 'string' || typeof envelope.proof !== 'string') {
          throw protocolError('handoff authentication response was malformed')
        }
        if (envelope.serverNonce !== serverNonce) {
          throw protocolError('handoff authentication was replayed')
        }
        // Mutual proof: the standby must also prove it knows the token.
        verifyProof(
          envelope.proof,
          createProof(options.token, SERVER_PROOF_DOMAIN, options.transactionId, envelope.serverNonce, clientNonce),
          'server',
        )
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        resolve()
        return
      }
      throw protocolError('handoff authentication was rejected')
    }

    const onData = (chunk: Buffer): void => {
      enqueueInboundFrames(
        socket,
        queue,
        decoder,
        chunk,
        1,
        consume,
        () => { if (!settled) { settled = true; socket.destroy(); reject(new Error('handoff channel read failed')) } },
      )
    }
    socket.on('data', onData)
  })

  const channel = wrapSocketChannel(socket, options.transactionId)
  return { channel: channel.channel, close: channel.close }
}
