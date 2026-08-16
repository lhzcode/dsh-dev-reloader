import type {
  BridgeEvent,
  PublicSupervisorStatus,
  SupervisorCommand,
  SupervisorEvent,
} from '../shared/protocol.js'
import {
  connectToSupervisor,
  type ConnectToSupervisorOptions,
  type IpcClient,
  type IpcCommandResult,
} from '../supervisor/ipc.js'

export interface BridgeClientOptions {
  /** The actual IPC connector (test seam). */
  readonly connect: (options: ConnectToSupervisorOptions) => Promise<IpcClient>
  readonly endpoint: string
  readonly token: string
  readonly hello: ConnectToSupervisorOptions['hello']
  /** Observer for incoming supervisor status events. */
  readonly onStatus?: (status: PublicSupervisorStatus) => void
}

/** A wrapped supervisor IPC connection plus a latest-status store. */
export interface BridgeClient {
  /** Most recently observed public supervisor status, before any event. */
  readonly status: PublicSupervisorStatus | undefined
  readonly connected: boolean
  /** Connect the underlying IPC client and begin observing events. */
  start(): Promise<void>
  /** Forward an outbound bridge event (activity, hmr-reload, host-disposing). */
  emit(event: BridgeEvent): Promise<void>
  /** Issue a supervisor command and await its result. */
  request(command: SupervisorCommand): Promise<IpcCommandResult>
  /** Close the connection. */
  close(): Promise<void>
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  let client: IpcClient | undefined
  let latestStatus: PublicSupervisorStatus | undefined

  async function start(): Promise<void> {
    if (client !== undefined) return
    const connected = await options.connect({
      endpoint: options.endpoint,
      token: options.token,
      hello: options.hello,
      onEvent: (event: SupervisorEvent) => {
        if (event.type === 'status') {
          latestStatus = event.status
          options.onStatus?.(event.status)
        }
      },
    })
    client = connected
  }

  // Always return a rejected promise (never throw synchronously) so callers
  // such as `void bridge.emit(...).catch(...)` can observe the disconnect.
  const disconnectedError = (): Error => new Error('supervisor is not connected')

  return {
    get status() {
      return latestStatus
    },
    get connected() {
      return client !== undefined && !client.closed
    },
    start,
    emit(event): Promise<void> {
      if (client === undefined) return Promise.reject(disconnectedError())
      return client.emit(event)
    },
    request(command): Promise<IpcCommandResult> {
      if (client === undefined) return Promise.reject(disconnectedError())
      return client.request(command)
    },
    async close(): Promise<void> {
      const current = client
      client = undefined
      if (current !== undefined && !current.closed) {
        await current.close()
      }
    },
  }
}

export { connectToSupervisor }
export type { ConnectToSupervisorOptions, IpcClient }
