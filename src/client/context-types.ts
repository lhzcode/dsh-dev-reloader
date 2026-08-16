/** Shared client-side types for the dev-reloader settings card. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SupervisorPhase } from '../shared/protocol.js'
import type { SupervisorConfig } from '../shared/config.js'
import type {
  SettingsEditOp,
  SettingsTransportSnapshot,
} from './settings-transport.js'

export type CardPhase = SupervisorPhase | 'unknown'
export type DevReloaderCardState = SettingsTransportSnapshot<SupervisorConfig>

export type CommandType =
  | 'get-status'
  | 'update-config'
  | 'rebuild'
  | 'restart'
  | 'pause'
  | 'stop'

export interface CommandOptions {
  readonly force?: boolean
  readonly config?: unknown
}

export interface CommandResult {
  readonly ok: boolean
  readonly error?: string
}

export interface HealthProbe {
  readonly ok: boolean
  readonly bootId: string
}

export interface StatusResult {
  readonly phase: SupervisorPhase
  readonly error?: string
}

export interface SettingsCardFace {
  readonly hooks: {
    readonly devReloader: HostObservable<DevReloaderCardState>
  }
  /** Persist one staged form in one compatibility mutation batch. */
  readonly mutateSettings: (ops: readonly SettingsEditOp[], expectedRevision?: number) => Promise<void>
  /** Refresh the active official or compatibility settings source. */
  readonly refreshSettings: () => Promise<void>
  readonly command: (
    type: CommandType,
    options?: CommandOptions,
  ) => Promise<CommandResult>
  readonly getStatus: () => Promise<StatusResult>
  readonly getHealth: () => Promise<HealthProbe>
}

export type { HostObservable }
