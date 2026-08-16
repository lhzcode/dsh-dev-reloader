import type { BridgeEvent, PublicSupervisorStatus, SupervisorCommand } from '../shared/protocol.js';
import { connectToSupervisor, type ConnectToSupervisorOptions, type IpcClient, type IpcCommandResult } from '../supervisor/ipc.js';
export interface BridgeClientOptions {
    /** The actual IPC connector (test seam). */
    readonly connect: (options: ConnectToSupervisorOptions) => Promise<IpcClient>;
    readonly endpoint: string;
    readonly token: string;
    readonly hello: ConnectToSupervisorOptions['hello'];
    /** Observer for incoming supervisor status events. */
    readonly onStatus?: (status: PublicSupervisorStatus) => void;
}
/** A wrapped supervisor IPC connection plus a latest-status store. */
export interface BridgeClient {
    /** Most recently observed public supervisor status, before any event. */
    readonly status: PublicSupervisorStatus | undefined;
    readonly connected: boolean;
    /** Connect the underlying IPC client and begin observing events. */
    start(): Promise<void>;
    /** Forward an outbound bridge event (activity, hmr-reload, host-disposing). */
    emit(event: BridgeEvent): Promise<void>;
    /** Issue a supervisor command and await its result. */
    request(command: SupervisorCommand): Promise<IpcCommandResult>;
    /** Close the connection. */
    close(): Promise<void>;
}
export declare function createBridgeClient(options: BridgeClientOptions): BridgeClient;
export { connectToSupervisor };
export type { ConnectToSupervisorOptions, IpcClient };
//# sourceMappingURL=client.d.ts.map