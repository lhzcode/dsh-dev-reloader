import { describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION, type BridgeEvent, type SupervisorCommand } from '../../src/shared/protocol.js'
import type { IpcClient } from '../../src/supervisor/ipc.js'
import {
  createBridgeClient,
  type BridgeClient,
  type BridgeClientOptions,
} from '../../src/bridge/client.js'

function fakeClient(): IpcClient & {
  request: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    closed: false,
    request: vi.fn(async () => ({ requestId: 'req-1', ok: true })),
    emit: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

function makeClient(options: Partial<BridgeClientOptions> = {}): {
  bridge: BridgeClient
  client: IpcClient & {
    request: ReturnType<typeof vi.fn>
    emit: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  connect: ReturnType<typeof vi.fn>
} {
  const client = fakeClient()
  const connect = vi.fn(async () => client)
  const bridge = createBridgeClient({
    connect,
    endpoint: '/tmp/supervisor.sock',
    token: 'a'.repeat(64),
    hello: { hostPid: 1, bootId: 'boot-1', launch: {} as never },
    ...options,
  })
  return { bridge, client, connect }
}

const activityEvent: BridgeEvent = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'activity',
  snapshot: {
    sequence: 1,
    capturedAt: 0,
    runningAgents: 0,
    runningJobs: 0,
    stoppingJobs: 0,
  },
}

const stopCommand: SupervisorCommand = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'stop',
  requestId: 'req-1',
}

describe('bridge client', () => {
  it('tracks connected=true only while an IPC client is open', async () => {
    const { bridge, client } = makeClient()
    expect(bridge.connected).toBe(false)

    await bridge.start()
    expect(bridge.connected).toBe(true)

    // Underlying socket closing marks the bridge as disconnected.
    client.closed = true
    expect(bridge.connected).toBe(false)
  })

  it('is disconnected before start and forwards emit/request once connected', async () => {
    const { bridge, client } = makeClient()
    expect(bridge.connected).toBe(false)

    await bridge.start()
    await bridge.emit(activityEvent)
    await bridge.request(stopCommand)

    expect(client.emit).toHaveBeenCalledWith(activityEvent)
    expect(client.request).toHaveBeenCalledWith(stopCommand)
  })

  it('after close(), emit() rejects instead of throwing synchronously', async () => {
    const { bridge, client } = makeClient()
    await bridge.start()
    await bridge.close()
    expect(bridge.connected).toBe(false)
    // Underlying connection was closed.
    expect(client.close).toHaveBeenCalledTimes(1)

    // Asserting this rejects (not sync-throws): if emit() threw synchronously,
    // this call would throw out of the test before returns a rejected promise.
    const awaited = bridge.emit(activityEvent)
    await expect(awaited).rejects.toThrow('supervisor is not connected')
  })

  it('after close(), request() rejects instead of throwing synchronously', async () => {
    const { bridge } = makeClient()
    await bridge.start()
    await bridge.close()

    const awaited = bridge.request(stopCommand)
    await expect(awaited).rejects.toThrow('supervisor is not connected')
  })

  it('before start(), emit() and request() reject instead of throwing synchronously', async () => {
    const { bridge } = makeClient()

    await expect(bridge.emit(activityEvent)).rejects.toThrow('supervisor is not connected')
    await expect(bridge.request(stopCommand)).rejects.toThrow('supervisor is not connected')
  })

  it('close() is idempotent and stays rejected afterwards', async () => {
    const { bridge, client } = makeClient()
    await bridge.start()
    await bridge.close()
    await bridge.close()

    expect(client.close).toHaveBeenCalledTimes(1)
    await expect(bridge.request(stopCommand)).rejects.toThrow('supervisor is not connected')
  })
})
