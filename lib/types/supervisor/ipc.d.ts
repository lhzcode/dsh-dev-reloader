import { type BridgeEvent, type BridgeHello, type SupervisorCommand, type SupervisorEvent } from '../shared/protocol.js';
import { IpcError, privateListenOptions, type IpcErrorCode } from './ipc-transport.js';
export { IpcError, privateListenOptions };
export type { IpcErrorCode };
export interface IpcCommandOutcome {
    readonly ok: boolean;
    readonly error?: string;
}
export interface IpcCommandResult extends IpcCommandOutcome {
    readonly requestId: string;
}
export interface IpcPeer {
    readonly hello: BridgeHello;
    send(event: SupervisorEvent): Promise<void>;
}
export interface ListenForBridgesOptions {
    readonly endpoint: string;
    readonly token: string;
    readonly validateHost: (hello: BridgeHello) => boolean | Promise<boolean>;
    readonly onEvent: (event: BridgeEvent, peer: IpcPeer) => void | Promise<void>;
    readonly onCommand?: (command: SupervisorCommand, peer: IpcPeer) => IpcCommandOutcome | void | Promise<IpcCommandOutcome | void>;
}
export interface IpcServer {
    readonly endpoint: string;
    readonly closed: boolean;
    readonly connectionCount: number;
    broadcast(event: SupervisorEvent): Promise<void>;
    close(): Promise<void>;
}
export interface ConnectToSupervisorOptions {
    readonly endpoint: string;
    readonly token: string;
    readonly hello: Pick<BridgeHello, 'hostPid' | 'bootId' | 'launch'>;
    readonly onEvent?: (event: SupervisorEvent) => void | Promise<void>;
}
export interface IpcClient {
    readonly closed: boolean;
    emit(event: BridgeEvent): Promise<void>;
    request(command: SupervisorCommand): Promise<IpcCommandResult>;
    close(): Promise<void>;
}
export declare function listenForBridges(options: ListenForBridgesOptions): Promise<IpcServer>;
export declare function connectToSupervisor(options: ConnectToSupervisorOptions): Promise<IpcClient>;
//# sourceMappingURL=ipc.d.ts.map