import type { SupervisorConfig } from './config.js'
import { requireSafeProfileName } from './profile.js'

export const PROTOCOL_VERSION = 1 as const
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_STRING_BYTES = 16 * 1024
export const MAX_LIST_ITEMS = 256
export const MAX_ENV_ENTRIES = 1_024

export type SupervisorPhase =
  | 'starting'
  | 'watching'
  | 'building'
  | 'hmr-wait'
  | 'pending-restart'
  | 'restarting'
  | 'recovering'
  | 'degraded'
  | 'failed'
  | 'paused'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface CommandTemplate {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
}

export interface HostLaunchSpec {
  readonly pid: number
  readonly bootId: string
  readonly nodeExecutable: string
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  readonly cwd: string
  /** In-memory may contain undefined; JSON wire form contains only string values. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly profile: string
  readonly webUrl: string
}

export interface ActivitySnapshot {
  readonly sequence: number
  readonly capturedAt: number
  readonly runningAgents: number
  readonly runningJobs: number
  readonly stoppingJobs: number
}

export interface PublicSupervisorStatus {
  readonly phase: SupervisorPhase
  readonly changedAt: number
  readonly reason?: string
  readonly projects?: readonly string[]
  readonly error?: string
  readonly bootId?: string
}

export interface WireEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly type: string
  readonly [key: string]: unknown
}

export interface BridgeHello extends WireEnvelope {
  readonly type: 'bridge-hello'
  readonly hostPid: number
  readonly bootId: string
  readonly launch: HostLaunchSpec
  readonly clientNonce: string
  readonly clientProof: string
}

export type BridgeEvent =
  | (WireEnvelope & {
      readonly type: 'activity'
      readonly snapshot: ActivitySnapshot
    })
  | (WireEnvelope & {
      readonly type: 'host-disposing'
      readonly hostPid: number
    })
  | (WireEnvelope & {
      readonly type: 'hmr-reload'
      readonly entries: readonly string[]
    })
  | (WireEnvelope & { readonly type: 'heartbeat' })

interface CommandBase extends WireEnvelope {
  readonly requestId: string
}

export type SupervisorCommand =
  | (CommandBase & { readonly type: 'get-status' })
  | (CommandBase & {
      readonly type: 'update-config'
      readonly config: SupervisorConfig
    })
  | (CommandBase & { readonly type: 'rebuild' })
  | (CommandBase & {
      readonly type: 'restart'
      readonly force: boolean
    })
  | (CommandBase & { readonly type: 'pause' })
  | (CommandBase & { readonly type: 'stop' })
  | (CommandBase & { readonly type: 'handoff' })

export type SupervisorEvent =
  | (WireEnvelope & {
      readonly type: 'status'
      readonly status: PublicSupervisorStatus
    })
  | (WireEnvelope & {
      readonly type: 'restart-planned'
      readonly bootId: string
    })
  | (WireEnvelope & {
      readonly type: 'command-result'
      readonly requestId: string
      readonly ok: boolean
      readonly error?: string
    })
  | (WireEnvelope & { readonly type: 'heartbeat' })

const encoder = new TextEncoder()

const PHASES = new Set<SupervisorPhase>([
  'starting',
  'watching',
  'building',
  'hmr-wait',
  'pending-restart',
  'restarting',
  'recovering',
  'degraded',
  'failed',
  'paused',
])

const LOG_LEVELS = new Set<LogLevel>([
  'debug',
  'info',
  'warn',
  'error',
])

function requirePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      throw new Error(`${label} must not contain symbol keys`)
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${label} contains a dangerous key: ${key}`)
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !descriptor.enumerable
    ) {
      throw new Error(`${label}.${key} must be an enumerable data property`)
    }
  }

  return value as Record<string, unknown>
}

function requireExactFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedFields)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unknown field: ${key}`)
    }
  }
}

function requireText(
  value: unknown,
  label: string,
  maxBytes = MAX_STRING_BYTES,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || encoder.encode(value).byteLength > maxBytes
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireText(value, label)
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a bounded integer`)
  }
  return value as number
}

function requireStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must be a bounded string array`)
  }
  return value.map((item, index) => requireText(item, `${label}[${index}]`))
}

function requireEnvelopeBase(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const envelope = requirePlainRecord(value, label)
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `unsupported protocol version: ${String(envelope.protocolVersion)}`,
    )
  }
  requireText(envelope.type, `${label}.type`, 128)
  return envelope
}

function requireNonce(value: unknown, label: string): string {
  const nonce = requireText(value, label, 64)
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    throw new Error(`${label} must be a 32-byte hex digest`)
  }
  return nonce
}

function decodeLaunchEnvironment(
  value: unknown,
): Record<string, string | undefined> {
  const environment = requirePlainRecord(value, 'launch.env')
  if (Object.keys(environment).length > MAX_ENV_ENTRIES) {
    throw new Error('launch.env exceeds entry bound')
  }

  for (const [key, envValue] of Object.entries(environment)) {
    requireText(key, 'launch.env key', 1_024)
    if (envValue === undefined) continue
    if (
      typeof envValue !== 'string'
      || encoder.encode(envValue).byteLength > MAX_STRING_BYTES
    ) {
      throw new Error('launch.env values must be bounded strings or undefined')
    }
  }

  return environment as Record<string, string | undefined>
}

export function decodeLaunchSpec(value: unknown): HostLaunchSpec {
  const launch = requirePlainRecord(value, 'launch')
  requireExactFields(
    launch,
    [
      'pid',
      'bootId',
      'nodeExecutable',
      'execArgv',
      'argv',
      'cwd',
      'env',
      'profile',
      'webUrl',
    ],
    'launch',
  )

  return {
    pid: requireSafeInteger(launch.pid, 'launch.pid', 1),
    bootId: requireText(launch.bootId, 'launch.bootId'),
    nodeExecutable: requireText(
      launch.nodeExecutable,
      'launch.nodeExecutable',
    ),
    execArgv: requireStringList(launch.execArgv, 'launch.execArgv'),
    argv: requireStringList(launch.argv, 'launch.argv'),
    cwd: requireText(launch.cwd, 'launch.cwd'),
    env: decodeLaunchEnvironment(launch.env),
    profile: requireSafeProfileName(launch.profile, 'launch.profile'),
    webUrl: requireText(launch.webUrl, 'launch.webUrl'),
  }
}

export function parseWireEnvelope(line: string): WireEnvelope {
  if (encoder.encode(line).byteLength > MAX_FRAME_BYTES) {
    throw new Error(`wire frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error('invalid JSON wire frame', { cause: error })
  }

  return requireEnvelopeBase(parsed, 'wire frame') as WireEnvelope
}

export function decodeBridgeHello(value: unknown): BridgeHello {
  const hello = requireEnvelopeBase(value, 'bridge hello')
  requireExactFields(
    hello,
    [
      'protocolVersion',
      'type',
      'hostPid',
      'bootId',
      'launch',
      'clientNonce',
      'clientProof',
    ],
    'bridge hello',
  )
  if (hello.type !== 'bridge-hello') {
    throw new Error('expected bridge hello')
  }

  const launch = decodeLaunchSpec(hello.launch)
  const hostPid = requireSafeInteger(hello.hostPid, 'hostPid', 1)
  const bootId = requireText(hello.bootId, 'bootId')
  if (hostPid !== launch.pid) {
    throw new Error('hostPid must equal launch.pid')
  }
  if (bootId !== launch.bootId) {
    throw new Error('bootId must equal launch.bootId')
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'bridge-hello',
    hostPid,
    bootId,
    launch,
    clientNonce: requireNonce(hello.clientNonce, 'clientNonce'),
    clientProof: requireNonce(hello.clientProof, 'clientProof'),
  }
}

function decodeActivitySnapshot(value: unknown): ActivitySnapshot {
  const snapshot = requirePlainRecord(value, 'activity snapshot')
  requireExactFields(
    snapshot,
    [
      'sequence',
      'capturedAt',
      'runningAgents',
      'runningJobs',
      'stoppingJobs',
    ],
    'activity snapshot',
  )

  return {
    sequence: requireSafeInteger(snapshot.sequence, 'sequence'),
    capturedAt: requireSafeInteger(snapshot.capturedAt, 'capturedAt'),
    runningAgents: requireSafeInteger(snapshot.runningAgents, 'runningAgents'),
    runningJobs: requireSafeInteger(snapshot.runningJobs, 'runningJobs'),
    stoppingJobs: requireSafeInteger(snapshot.stoppingJobs, 'stoppingJobs'),
  }
}

export function decodeBridgeEvent(value: unknown): BridgeEvent {
  const event = requireEnvelopeBase(value, 'bridge event')

  switch (event.type) {
    case 'heartbeat':
      requireExactFields(event, ['protocolVersion', 'type'], 'heartbeat')
      return event as BridgeEvent
    case 'activity':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'snapshot'],
        'activity',
      )
      decodeActivitySnapshot(event.snapshot)
      return event as BridgeEvent
    case 'host-disposing':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'hostPid'],
        'host-disposing',
      )
      requireSafeInteger(event.hostPid, 'hostPid', 1)
      return event as BridgeEvent
    case 'hmr-reload':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'entries'],
        'hmr-reload',
      )
      requireStringList(event.entries, 'entries')
      return event as BridgeEvent
    default:
      throw new Error(`unknown bridge event type: ${String(event.type)}`)
  }
}

function validateCommandTemplate(value: unknown, label: string): void {
  const command = requirePlainRecord(value, label)
  requireExactFields(command, ['executable', 'args', 'cwd'], label)
  requireText(command.executable, `${label}.executable`)
  requireStringList(command.args, `${label}.args`)
  optionalText(command.cwd, `${label}.cwd`)
}

function validateProjectOverrides(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error('invalid config.projectOverrides')
  }

  for (const [index, rawProject] of value.entries()) {
    const label = `projectOverrides[${index}]`
    const project = requirePlainRecord(rawProject, label)
    requireExactFields(project, ['root', 'build', 'devWeb'], label)
    requireText(project.root, 'project root')
    if (project.build !== undefined) {
      validateCommandTemplate(project.build, 'build')
    }
    if (project.devWeb !== undefined) {
      validateCommandTemplate(project.devWeb, 'devWeb')
    }
  }
}

export function validateSupervisorConfig(value: unknown): void {
  const config = requirePlainRecord(value, 'config')
  requireExactFields(
    config,
    [
      'enabled',
      'profile',
      'sourceRoots',
      'webUrl',
      'debounceMs',
      'healthTimeoutMs',
      'shutdownGraceMs',
      'bridgeGraceMs',
      'crashWindowMs',
      'maxCrashRestarts',
      'ignored',
      'projectOverrides',
      'logLevel',
    ],
    'config',
  )

  if (typeof config.enabled !== 'boolean') {
    throw new Error('config.enabled must be boolean')
  }
  requireSafeProfileName(config.profile, 'config.profile')
  optionalText(config.webUrl, 'config.webUrl')
  requireStringList(config.sourceRoots, 'config.sourceRoots')
  requireStringList(config.ignored, 'config.ignored')

  const integerFields = [
    'debounceMs',
    'healthTimeoutMs',
    'shutdownGraceMs',
    'bridgeGraceMs',
    'crashWindowMs',
    'maxCrashRestarts',
  ] as const
  for (const field of integerFields) {
    requireSafeInteger(config[field], `config.${field}`)
  }

  if (!LOG_LEVELS.has(config.logLevel as LogLevel)) {
    throw new Error('invalid config.logLevel')
  }
  validateProjectOverrides(config.projectOverrides)
}

function requireRequestId(value: unknown): string {
  return requireText(value, 'requestId', 256)
}

export function decodeSupervisorCommand(value: unknown): SupervisorCommand {
  const command = requireEnvelopeBase(value, 'supervisor command')
  requireRequestId(command.requestId)

  switch (command.type) {
    case 'get-status':
    case 'rebuild':
    case 'pause':
    case 'stop':
    case 'handoff':
      requireExactFields(
        command,
        ['protocolVersion', 'type', 'requestId'],
        String(command.type),
      )
      break
    case 'restart':
      requireExactFields(
        command,
        ['protocolVersion', 'type', 'requestId', 'force'],
        'restart',
      )
      if (typeof command.force !== 'boolean') {
        throw new Error('restart.force must be boolean')
      }
      break
    case 'update-config':
      requireExactFields(
        command,
        ['protocolVersion', 'type', 'requestId', 'config'],
        'update-config',
      )
      validateSupervisorConfig(command.config)
      break
    default:
      throw new Error(
        `unknown supervisor command type: ${String(command.type)}`,
      )
  }

  return command as SupervisorCommand
}

function validatePublicStatus(value: unknown): void {
  const status = requirePlainRecord(value, 'status')
  requireExactFields(
    status,
    ['phase', 'changedAt', 'reason', 'projects', 'error', 'bootId'],
    'status',
  )

  if (!PHASES.has(status.phase as SupervisorPhase)) {
    throw new Error('invalid status.phase')
  }
  requireSafeInteger(status.changedAt, 'status.changedAt')
  optionalText(status.reason, 'status.reason')
  optionalText(status.error, 'status.error')
  optionalText(status.bootId, 'status.bootId')
  if (status.projects !== undefined) {
    requireStringList(status.projects, 'status.projects')
  }
}

export function decodeSupervisorEvent(value: unknown): SupervisorEvent {
  const event = requireEnvelopeBase(value, 'supervisor event')

  switch (event.type) {
    case 'heartbeat':
      requireExactFields(event, ['protocolVersion', 'type'], 'heartbeat')
      break
    case 'status':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'status'],
        'status',
      )
      validatePublicStatus(event.status)
      break
    case 'restart-planned':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'bootId'],
        'restart-planned',
      )
      requireText(event.bootId, 'bootId')
      break
    case 'command-result':
      requireExactFields(
        event,
        ['protocolVersion', 'type', 'requestId', 'ok', 'error'],
        'command-result',
      )
      requireRequestId(event.requestId)
      if (typeof event.ok !== 'boolean') {
        throw new Error('command-result.ok must be boolean')
      }
      optionalText(event.error, 'command-result.error')
      break
    default:
      throw new Error(
        `unknown supervisor event type: ${String(event.type)}`,
      )
  }

  return event as SupervisorEvent
}
