import type { CommandTemplate } from './protocol.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ProjectOverride {
  readonly root: string
  readonly build?: CommandTemplate
  readonly devWeb?: CommandTemplate
}

/** Serializable configuration sent from the host bridge to the supervisor. */
export interface SupervisorConfig {
  readonly enabled: boolean
  readonly profile: string
  readonly sourceRoots: readonly string[]
  readonly webUrl?: string
  readonly debounceMs: number
  readonly healthTimeoutMs: number
  readonly shutdownGraceMs: number
  readonly bridgeGraceMs: number
  readonly crashWindowMs: number
  readonly maxCrashRestarts: number
  readonly ignored: readonly string[]
  readonly projectOverrides: readonly ProjectOverride[]
  readonly logLevel: LogLevel
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = Object.freeze({
  enabled: true,
  profile: 'web',
  sourceRoots: Object.freeze([]),
  debounceMs: 250,
  healthTimeoutMs: 60_000,
  shutdownGraceMs: 10_000,
  bridgeGraceMs: 10_000,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  ignored: Object.freeze([]),
  projectOverrides: Object.freeze([]),
  logLevel: 'info',
})
