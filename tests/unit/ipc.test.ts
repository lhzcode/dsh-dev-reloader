import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  connectToSupervisor,
  listenForBridges,
  privateListenOptions,
  type IpcClient,
  type IpcServer,
} from '../../src/supervisor/ipc.js'
import { resolveRuntimePaths, type RuntimePaths } from '../../src/supervisor/paths.js'
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type BridgeEvent,
  type SupervisorCommand,
} from '../../src/shared/protocol.js'
import { eventually } from '../helpers/eventually.js'

const TOKEN = '11'.repeat(32)
const roots: string[] = []
const servers: IpcServer[] = []
const netServers: NetServer[] = []
const clients: IpcClient[] = []
const sockets: Socket[] = []

async function temporaryPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-reloader-ipc-'))
  roots.push(root)
  return resolveRuntimePaths({ dshHome: root, profile: 'web' })
}

function helloInput(hostPid = process.pid) {
  return {
    hostPid,
    bootId: `boot-${hostPid}`,
    launch: {
      pid: hostPid,
      bootId: `boot-${hostPid}`,
      nodeExecutable: process.execPath,
      execArgv: [],
      argv: ['fake-dsh', 'web'],
      cwd: process.cwd(),
      env: {},
      profile: 'web',
      webUrl: 'http://127.0.0.1:0',
    },
  } as const
}

function hmac(domain: string, serverNonce: string, clientNonce: string, token = TOKEN): string {
  return createHmac('sha256', token)
    .update(domain).update('\0').update(serverNonce).update('\0').update(clientNonce)
    .digest('hex')
}

function rawHello(serverNonce: string, hostPid = process.pid, protocolVersion: number = PROTOCOL_VERSION, token = TOKEN) {
  const clientNonce = 'ab'.repeat(32)
  return {
    protocolVersion,
    type: 'bridge-hello',
    ...helloInput(hostPid),
    clientNonce,
    clientProof: hmac('dsh-dev-reloader/ipc/client-proof/v1', serverNonce, clientNonce, token),
  }
}

function activity(sequence: number): BridgeEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'activity',
    snapshot: {
      sequence,
      capturedAt: Date.now(),
      runningAgents: 0,
      runningJobs: 0,
      stoppingJobs: 0,
    },
  }
}

function command(requestId: string): SupervisorCommand {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'get-status',
    requestId,
  }
}

const rawLines = new WeakMap<Socket, string[]>()

async function connectRaw(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint)
  sockets.push(socket)
  socket.on('error', () => undefined)
  const lines: string[] = []
  let pending = ''
  rawLines.set(socket, lines)
  socket.on('data', chunk => {
    pending += chunk.toString('utf8')
    const parts = pending.split('\n')
    pending = parts.pop()!
    lines.push(...parts)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function nextRaw(socket: Socket): Promise<Record<string, unknown>> {
  let value: string | undefined
  await eventually(() => {
    value = rawLines.get(socket)?.shift()
    expect(value).toBeDefined()
  })
  return JSON.parse(value!) as Record<string, unknown>
}

async function authenticateRaw(socket: Socket, hostPid = process.pid): Promise<void> {
  const challenge = await nextRaw(socket)
  expect(challenge.type).toBe('authentication-challenge')
  const clientNonce = 'ab'.repeat(32)
  socket.write(line({
    protocolVersion: PROTOCOL_VERSION,
    type: 'authentication-init',
    clientNonce,
  }))
  const serverProof = await nextRaw(socket)
  expect(serverProof).toEqual({
    protocolVersion: PROTOCOL_VERSION,
    type: 'authentication-proof',
    serverProof: hmac(
      'dsh-dev-reloader/ipc/server-proof/v1',
      challenge.serverNonce as string,
      clientNonce,
    ),
  })
  socket.write(line(rawHello(challenge.serverNonce as string, hostPid)))
  const result = await nextRaw(socket)
  expect(result).toMatchObject({ type: 'authentication-result', ok: true })
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

async function expectDisconnected(socket: Socket): Promise<void> {
  await eventually(() => expect(socket.destroyed).toBe(true))
}

async function startServer(
  paths: RuntimePaths,
  overrides: Partial<Parameters<typeof listenForBridges>[0]> = {},
): Promise<IpcServer> {
  const server = await listenForBridges({
    endpoint: paths.endpoint,
    token: TOKEN,
    validateHost: async hello => {
      try {
        process.kill(hello.hostPid, 0)
        return true
      } catch {
        return false
      }
    },
    onEvent: () => undefined,
    ...overrides,
  })
  servers.push(server)
  return server
}

async function startClient(paths: RuntimePaths): Promise<IpcClient> {
  const client = await connectToSupervisor({
    endpoint: paths.endpoint,
    token: TOKEN,
    hello: helloInput(),
  })
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined)
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await server.close().catch(() => undefined)
  for (const server of netServers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
})

describe('authenticated local IPC framing', () => {
  it('requires a fixed 32-byte lowercase-hex authentication token', async () => {
    const paths = await temporaryPaths()
    await expect(listenForBridges({
      endpoint: paths.endpoint,
      token: 'too-short',
      validateHost: () => true,
      onEvent: () => undefined,
    })).rejects.toThrow(/32 random bytes/i)
    await expect(connectToSupervisor({
      endpoint: paths.endpoint,
      token: 'AA'.repeat(32),
      hello: helloInput(),
    })).rejects.toThrow(/lowercase hex/i)
  })

  it('does not widen the current-user default named-pipe DACL on Windows', () => {
    expect(privateListenOptions('\\\\.\\pipe\\test', 'win32')).toEqual({
      path: '\\\\.\\pipe\\test',
      readableAll: false,
      writableAll: false,
    })
  })

  it('accepts fragmented hello/event NDJSON frames over a real local endpoint', async () => {
    const paths = await temporaryPaths()
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: event => events.push(event) })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)
    const expected = activity(1)
    const payload = Buffer.from(line(expected))

    socket.write(payload.subarray(0, 7))
    socket.write(payload.subarray(7, 41))
    socket.write(payload.subarray(41, payload.length - 3))
    socket.write(payload.subarray(payload.length - 3))

    await eventually(() => expect(events).toEqual([expected]))
  })

  it('processes multiple complete frames delivered in one read', async () => {
    const paths = await temporaryPaths()
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: event => events.push(event) })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)

    socket.write(line(activity(1)) + line(activity(2)))

    await eventually(() => expect(events.map(event =>
      event.type === 'activity' ? event.snapshot.sequence : -1,
    )).toEqual([1, 2]))
  })

  it('rejects application frames pre-sent with the authenticated hello', async () => {
    const paths = await temporaryPaths()
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: event => events.push(event) })
    const socket = await connectRaw(paths.endpoint)
    const challenge = await nextRaw(socket)
    const clientNonce = 'ab'.repeat(32)
    socket.write(line({ protocolVersion: PROTOCOL_VERSION, type: 'authentication-init', clientNonce }))
    await expect(nextRaw(socket)).resolves.toMatchObject({ type: 'authentication-proof' })

    socket.write(
      line(rawHello(challenge.serverNonce as string))
      + line(activity(7)),
    )

    await expectDisconnected(socket)
    expect(events).toEqual([])
  })

  it('keeps the socket paused while host validation is pending', async () => {
    const paths = await temporaryPaths()
    let releaseValidation!: () => void
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve })
    let validationStarted = false
    const events: BridgeEvent[] = []
    await startServer(paths, {
      validateHost: async () => {
        validationStarted = true
        await validationGate
        return true
      },
      onEvent: event => events.push(event),
    })
    const socket = await connectRaw(paths.endpoint)
    const challenge = await nextRaw(socket)
    const clientNonce = 'ab'.repeat(32)
    socket.write(line({ protocolVersion: PROTOCOL_VERSION, type: 'authentication-init', clientNonce }))
    await expect(nextRaw(socket)).resolves.toMatchObject({ type: 'authentication-proof' })
    socket.write(line(rawHello(challenge.serverNonce as string)))
    await eventually(() => expect(validationStarted).toBe(true))

    const bufferedEvent = activity(8)
    await new Promise<void>((resolve, reject) => {
      socket.write(line(bufferedEvent), error => error ? reject(error) : resolve())
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events).toEqual([])

    releaseValidation()
    await expect(nextRaw(socket)).resolves.toMatchObject({
      type: 'authentication-result',
      ok: true,
    })
    await eventually(() => expect(events).toEqual([bufferedEvent]))
  })

  it('rejects a UTF-8 byte-oversize frame before parsing it', async () => {
    const paths = await temporaryPaths()
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: event => events.push(event) })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)

    const prefix = '{"protocolVersion":1,"type":"heartbeat","padding":"'
    const suffix = '"}\n'
    const emoji = '🙂'
    const count = Math.ceil((MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix) + 1) / Buffer.byteLength(emoji))
    const oversized = prefix + emoji.repeat(count) + suffix
    expect(oversized.length).toBeLessThan(MAX_FRAME_BYTES)
    expect(Buffer.byteLength(oversized) - 1).toBeGreaterThan(MAX_FRAME_BYTES)

    socket.write(oversized)
    await expectDisconnected(socket)
    expect(events).toEqual([])
  })

  it('rejects malformed JSON after authentication', async () => {
    const paths = await temporaryPaths()
    await startServer(paths)
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)
    socket.write('{not-json}\n')
    await expectDisconnected(socket)
  })

  it('rejects wrong tokens, protocol versions, and stale host pids', async () => {
    const tokenPaths = await temporaryPaths()
    await startServer(tokenPaths)
    await expect(connectToSupervisor({
      endpoint: tokenPaths.endpoint,
      token: '22'.repeat(32),
      hello: helloInput(),
    })).rejects.toMatchObject({ code: 'IPC_AUTHENTICATION_FAILED' })

    const versionPaths = await temporaryPaths()
    await startServer(versionPaths)
    const versionSocket = await connectRaw(versionPaths.endpoint)
    const challenge = await nextRaw(versionSocket)
    versionSocket.write(line({
      protocolVersion: PROTOCOL_VERSION,
      type: 'authentication-init',
      clientNonce: 'ab'.repeat(32),
    }))
    await expect(nextRaw(versionSocket)).resolves.toMatchObject({ type: 'authentication-proof' })
    versionSocket.write(line(rawHello(challenge.serverNonce as string, process.pid, 2)))
    await expectDisconnected(versionSocket)

    const stalePaths = await temporaryPaths()
    await startServer(stalePaths)
    await expect(connectToSupervisor({
      endpoint: stalePaths.endpoint,
      token: TOKEN,
      hello: helloInput(2_147_483_647),
    })).rejects.toMatchObject({ code: 'IPC_AUTHENTICATION_FAILED' })
  })

  it('omits undefined environment entries before runtime hello validation', async () => {
    const paths = await temporaryPaths()
    let received: Parameters<Parameters<typeof listenForBridges>[0]['validateHost']>[0] | undefined
    await startServer(paths, { validateHost: hello => { received = hello; return true } })
    const input = helloInput()
    const client = await connectToSupervisor({
      endpoint: paths.endpoint,
      token: TOKEN,
      hello: { ...input, launch: { ...input.launch, env: { PRESENT: 'yes', OMITTED: undefined } } },
    })
    clients.push(client)
    expect(received?.launch.env).toEqual({ PRESENT: 'yes' })
  })

  it('uses proof fields without placing the bearer token on the wire', async () => {
    const paths = await temporaryPaths()
    await startServer(paths)
    const socket = await connectRaw(paths.endpoint)
    const challenge = await nextRaw(socket)
    const clientNonce = 'ab'.repeat(32)
    const init = { protocolVersion: PROTOCOL_VERSION, type: 'authentication-init', clientNonce }
    expect(JSON.stringify(init)).not.toContain(TOKEN)
    socket.write(line(init))
    await expect(nextRaw(socket)).resolves.toMatchObject({ type: 'authentication-proof' })
    const hello = rawHello(challenge.serverNonce as string)
    expect(hello).not.toHaveProperty('token')
    expect(JSON.stringify(hello)).not.toContain(TOKEN)
    socket.write(line(hello))
    await expect(nextRaw(socket)).resolves.toMatchObject({ ok: true })
  })

  it('authenticates the server before disclosing launch metadata', async () => {
    const paths = await temporaryPaths()
    let resolveFirst!: (frame: Record<string, unknown>) => void
    const firstFrame = new Promise<Record<string, unknown>>(resolve => { resolveFirst = resolve })
    const fake = createNetServer(socket => {
      socket.write(line({
        protocolVersion: PROTOCOL_VERSION,
        type: 'authentication-challenge',
        serverNonce: 'cd'.repeat(32),
      }))
      socket.once('data', chunk => {
        resolveFirst(JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>)
        socket.write(line({
          protocolVersion: PROTOCOL_VERSION,
          type: 'authentication-proof',
          serverProof: '00'.repeat(32),
        }))
      })
    })
    netServers.push(fake)
    await new Promise<void>((resolve, reject) => {
      fake.once('error', reject)
      fake.listen(paths.endpoint, resolve)
    })
    await expect(connectToSupervisor({
      endpoint: paths.endpoint,
      token: TOKEN,
      hello: { ...helloInput(), launch: { ...helloInput().launch, env: { SECRET: 'must-not-leak' } } },
    })).rejects.toMatchObject({ code: 'IPC_AUTHENTICATION_FAILED' })
    const first = await firstFrame
    expect(first).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: 'authentication-init',
      clientNonce: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(first)).not.toContain('must-not-leak')
  })

  it('accepts a coalesced authentication result and first supervisor event', async () => {
    const paths = await temporaryPaths()
    const serverNonce = 'cd'.repeat(32)
    const fake = createNetServer(socket => {
      socket.write(line({ protocolVersion: PROTOCOL_VERSION, type: 'authentication-challenge', serverNonce }))
      socket.once('data', initChunk => {
        const init = JSON.parse(initChunk.toString('utf8').trim()) as { clientNonce: string }
        const serverProof = hmac('dsh-dev-reloader/ipc/server-proof/v1', serverNonce, init.clientNonce)
        socket.write(line({ protocolVersion: PROTOCOL_VERSION, type: 'authentication-proof', serverProof }))
        socket.once('data', () => socket.write(
          line({ protocolVersion: PROTOCOL_VERSION, type: 'authentication-result', ok: true, serverProof })
          + line({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }),
        ))
      })
    })
    netServers.push(fake)
    await new Promise<void>((resolve, reject) => {
      fake.once('error', reject)
      fake.listen(paths.endpoint, resolve)
    })
    const events: unknown[] = []
    const client = await connectToSupervisor({
      endpoint: paths.endpoint,
      token: TOKEN,
      hello: helloInput(),
      onEvent: event => events.push(event),
    })
    clients.push(client)
    await eventually(() => expect(events).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }]))
  })

  it('sets and verifies POSIX Unix socket mode 0600', async () => {
    if (process.platform === 'win32') return
    const paths = await temporaryPaths()
    await startServer(paths)
    const metadata = await lstat(paths.endpoint)
    expect(metadata.isSocket()).toBe(true)
    expect(metadata.mode & 0o777).toBe(0o600)
    if (typeof process.getuid === 'function') expect(metadata.uid).toBe(process.getuid())
  })

  it('rejects malformed UTF-8 with the fatal decoder', async () => {
    const paths = await temporaryPaths()
    await startServer(paths)
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)
    socket.write(Buffer.from([0xc3, 0x28, 0x0a]))
    await expectDisconnected(socket)
  })

  it('applies socket backpressure while a slow event handler consumes frames', async () => {
    const paths = await temporaryPaths()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: async event => { events.push(event); await gate } })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)
    socket.write(Array.from({ length: 8 }, (_, index) => line(activity(index))).join(''))
    await eventually(() => expect(events).toHaveLength(1))
    expect(events).toHaveLength(1)
    release()
    await eventually(() => expect(events).toHaveLength(8))
  })

  it('fails closed when the bounded inbound frame queue is exceeded', async () => {
    const paths = await temporaryPaths()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: async event => { events.push(event); await gate } })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)

    socket.write(Array.from({ length: 17 }, (_, index) => line(activity(index))).join(''))

    await expectDisconnected(socket)
    expect(events).toEqual([])
    release()
  })

  it('fails closed when the bounded outbound frame queue is exceeded', async () => {
    const paths = await temporaryPaths()
    let writeResults: Promise<PromiseSettledResult<void>[]> | undefined
    await startServer(paths, {
      onEvent: (_event, peer) => {
        const writes = Array.from({ length: 17 }, () => peer.send({
          protocolVersion: PROTOCOL_VERSION,
          type: 'heartbeat',
        }))
        writeResults = Promise.allSettled(writes)
      },
    })
    const client = await startClient(paths)

    await client.emit({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' })

    await eventually(() => expect(writeResults).toBeDefined())
    const results = await writeResults!
    expect(results).toHaveLength(17)
    expect(results.some(result =>
      result.status === 'rejected'
      && result.reason instanceof Error
      && 'code' in result.reason
      && result.reason.code === 'IPC_PROTOCOL_ERROR'
      && /outbound queue limit/i.test(result.reason.message),
    )).toBe(true)
    await eventually(() => expect(client.closed).toBe(true))
  })

  it('keeps accepting bounded commands while a slow command handler is in flight', async () => {
    const paths = await temporaryPaths()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const started: string[] = []
    await startServer(paths, {
      onCommand: async incoming => {
        started.push(incoming.requestId)
        if (incoming.requestId === 'first') await firstGate
        return { ok: true }
      },
    })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)

    socket.write(line(command('first')))
    await eventually(() => expect(started).toEqual(['first']))
    await new Promise<void>((resolve, reject) => {
      socket.write(
        line(command('second')),
        error => error ? reject(error) : resolve(),
      )
    })
    await eventually(() => expect(started).toEqual(['first', 'second']))

    releaseFirst()
  })

  it('requires bridge hello as the first frame', async () => {
    const paths = await temporaryPaths()
    const events: BridgeEvent[] = []
    await startServer(paths, { onEvent: event => events.push(event) })
    const socket = await connectRaw(paths.endpoint)
    const challenge = await nextRaw(socket)
    socket.write(
      line({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' })
      + line(rawHello(challenge.serverNonce as string))
      + line(activity(1)),
    )

    await expectDisconnected(socket)
    expect(events).toEqual([])
  })
})

describe('IPC request lifecycle', () => {
  it('correlates concurrent command responses completed out of order', async () => {
    const paths = await temporaryPaths()
    const resolutions = new Map<string, (result: { ok: boolean; error?: string }) => void>()
    await startServer(paths, {
      onCommand: incoming => new Promise(resolve => resolutions.set(incoming.requestId, resolve)),
    })
    const client = await startClient(paths)

    const first = client.request(command('first'))
    await eventually(() => expect([...resolutions.keys()]).toEqual(['first']))

    // Send the second command only after the first frame is being handled. The
    // transport must not pause later frames behind an unresolved command.
    const second = client.request(command('second'))
    const results = Promise.all([first, second])
    void results.catch(() => undefined)
    await eventually(() => expect([...resolutions.keys()].sort()).toEqual(['first', 'second']))
    resolutions.get('second')!({ ok: false, error: 'second failed' })
    resolutions.get('first')!({ ok: true })

    await expect(results).resolves.toEqual([
      { requestId: 'first', ok: true },
      { requestId: 'second', ok: false, error: 'second failed' },
    ])
  })

  it('rejects duplicate request ids on the server, including the recent cache', async () => {
    const paths = await temporaryPaths()
    await startServer(paths, { onCommand: () => ({ ok: true }) })
    const socket = await connectRaw(paths.endpoint)
    await authenticateRaw(socket)
    socket.write(line(command('duplicate')))
    await expect(nextRaw(socket)).resolves.toMatchObject({ type: 'command-result', requestId: 'duplicate' })
    socket.write(line(command('duplicate')))
    await expectDisconnected(socket)
  })

  it('rejects recently completed request ids locally without disconnecting the client', async () => {
    const paths = await temporaryPaths()
    await startServer(paths, { onCommand: () => ({ ok: true }) })
    const client = await startClient(paths)

    await expect(client.request(command('duplicate'))).resolves.toEqual({
      requestId: 'duplicate',
      ok: true,
    })
    await expect(client.request(command('duplicate')))
      .rejects.toMatchObject({ code: 'IPC_DUPLICATE_REQUEST' })
    expect(client.closed).toBe(false)
  })

  it('treats an unknown command-result id as a protocol error', async () => {
    const paths = await temporaryPaths()
    await startServer(paths, {
      onEvent: async (_event, peer) => peer.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'command-result',
        requestId: 'not-pending',
        ok: true,
      }),
    })
    const client = await startClient(paths)
    await client.emit({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' })
    await eventually(() => expect(client.closed).toBe(true))
    await expect(client.emit({ protocolVersion: PROTOCOL_VERSION, type: 'heartbeat' }))
      .rejects.toMatchObject({ code: 'IPC_DISCONNECTED' })
  })

  it('rejects every pending RPC with IPC_DISCONNECTED when the peer closes', async () => {
    const paths = await temporaryPaths()
    const server = await startServer(paths, {
      onCommand: async () => new Promise(() => undefined),
    })
    const client = await startClient(paths)
    const first = client.request(command('first'))
    const second = client.request(command('second'))

    await server.close()

    await expect(first).rejects.toMatchObject({ code: 'IPC_DISCONNECTED' })
    await expect(second).rejects.toMatchObject({ code: 'IPC_DISCONNECTED' })
  })

  it('does not leave an unhandled authentication rejection on connect failure', async () => {
    const paths = await temporaryPaths()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(connectToSupervisor({
        endpoint: paths.endpoint,
        token: TOKEN,
        hello: helloInput(),
      })).rejects.toMatchObject({ code: 'IPC_DISCONNECTED' })
      await new Promise<void>(resolve => setImmediate(resolve))
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('closes authenticated clients and server without retained handles', async () => {
    const paths = await temporaryPaths()
    const server = await startServer(paths)
    const client = await startClient(paths)

    await client.close()
    await server.close()
    await client.close()
    await server.close()

    expect(client.closed).toBe(true)
    expect(server.closed).toBe(true)
    expect(server.connectionCount).toBe(0)
  })
})
