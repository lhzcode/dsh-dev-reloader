import type { LogLevel, ProjectOverride, SupervisorConfig } from '../shared/config.js'
import type { SettingsEditOp } from './settings-transport.js'

export interface SupervisorSettingsDraft {
  enabled: boolean
  profile: string
  sourceRoots: string
  webUrl: string
  debounceMs: string
  healthTimeoutMs: string
  shutdownGraceMs: string
  bridgeGraceMs: string
  crashWindowMs: string
  maxCrashRestarts: string
  ignored: string
  projectOverrides: string
  logLevel: string
}

export type DraftErrors = Partial<Record<keyof SupervisorSettingsDraft, string>>

export type ParsedSettingsDraft =
  | { readonly ok: true; readonly value: SupervisorConfig }
  | { readonly ok: false; readonly errors: DraftErrors }

export type SettingsOpsResult =
  | { readonly ok: true; readonly value: SupervisorConfig; readonly ops: readonly SettingsEditOp[] }
  | { readonly ok: false; readonly errors: DraftErrors }

export const EDITABLE_SETTINGS_FIELDS = [
  'enabled',
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
] as const

const NATURAL_FIELDS = [
  'debounceMs',
  'healthTimeoutMs',
  'shutdownGraceMs',
  'bridgeGraceMs',
  'crashWindowMs',
  'maxCrashRestarts',
] as const

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(entry => entry.trim()).filter(Boolean)
}

function natural(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^\d+$/u.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validCommand(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (value.executable === undefined || typeof value.executable === 'string')
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')))
}

function validProjectOverrides(value: unknown): value is ProjectOverride[] {
  return Array.isArray(value) && value.every(entry => (
    isRecord(entry)
    && typeof entry.root === 'string'
    && entry.root.length > 0
    && (entry.build === undefined || validCommand(entry.build))
    && (entry.devWeb === undefined || validCommand(entry.devWeb))
  ))
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createSettingsDraft(config: SupervisorConfig): SupervisorSettingsDraft {
  return {
    enabled: config.enabled,
    profile: config.profile,
    sourceRoots: config.sourceRoots.join('\n'),
    webUrl: config.webUrl ?? '',
    debounceMs: String(config.debounceMs),
    healthTimeoutMs: String(config.healthTimeoutMs),
    shutdownGraceMs: String(config.shutdownGraceMs),
    bridgeGraceMs: String(config.bridgeGraceMs),
    crashWindowMs: String(config.crashWindowMs),
    maxCrashRestarts: String(config.maxCrashRestarts),
    ignored: config.ignored.join('\n'),
    projectOverrides: JSON.stringify(config.projectOverrides, null, 2),
    logLevel: config.logLevel,
  }
}

export function parseSettingsDraft(draft: SupervisorSettingsDraft): ParsedSettingsDraft {
  const errors: DraftErrors = {}
  const numbers = {} as Record<(typeof NATURAL_FIELDS)[number], number>
  for (const field of NATURAL_FIELDS) {
    const value = natural(draft[field])
    if (value === undefined) errors[field] = 'Enter a non-negative integer.'
    else numbers[field] = value
  }

  let webUrl: string | undefined
  const rawUrl = draft.webUrl.trim()
  if (rawUrl !== '') {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      webUrl = rawUrl
    } catch {
      errors.webUrl = 'Enter an absolute HTTP or HTTPS URL.'
    }
  }

  let projectOverrides: ProjectOverride[] = []
  try {
    const parsed = JSON.parse(draft.projectOverrides.trim() || '[]') as unknown
    if (!validProjectOverrides(parsed)) throw new Error('shape')
    projectOverrides = parsed
  } catch {
    errors.projectOverrides = 'Enter a JSON array of project override objects.'
  }

  if (!LOG_LEVELS.has(draft.logLevel as LogLevel)) {
    errors.logLevel = 'Choose debug, info, warn, or error.'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const value: SupervisorConfig = {
    enabled: draft.enabled,
    profile: draft.profile,
    sourceRoots: lines(draft.sourceRoots),
    ...(webUrl === undefined ? {} : { webUrl }),
    debounceMs: numbers.debounceMs,
    healthTimeoutMs: numbers.healthTimeoutMs,
    shutdownGraceMs: numbers.shutdownGraceMs,
    bridgeGraceMs: numbers.bridgeGraceMs,
    crashWindowMs: numbers.crashWindowMs,
    maxCrashRestarts: numbers.maxCrashRestarts,
    ignored: lines(draft.ignored),
    projectOverrides,
    logLevel: draft.logLevel as LogLevel,
  }
  return { ok: true, value }
}

export function settingsOpsFromDraft(
  current: SupervisorConfig,
  draft: SupervisorSettingsDraft,
): SettingsOpsResult {
  const parsed = parseSettingsDraft(draft)
  if (!parsed.ok) return parsed
  const next = parsed.value
  const ops: SettingsEditOp[] = []
  for (const field of EDITABLE_SETTINGS_FIELDS) {
    if (equalJson(current[field], next[field])) continue
    if (field === 'webUrl' && next.webUrl === undefined) {
      ops.push({ op: 'unset', path: [field] })
    } else {
      ops.push({ op: 'set', path: [field], value: next[field] })
    }
  }
  return { ok: true, value: next, ops }
}

export function resetSettingsOps(): readonly SettingsEditOp[] {
  return EDITABLE_SETTINGS_FIELDS.map(field => ({ op: 'unset' as const, path: [field] as const }))
}
