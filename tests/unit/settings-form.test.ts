import { describe, expect, it } from 'vitest'
import type { SupervisorConfig } from '../../src/shared/config.js'
import {
  createSettingsDraft,
  parseSettingsDraft,
  resetSettingsOps,
  settingsOpsFromDraft,
} from '../../src/client/settings-form.js'

const config: SupervisorConfig = {
  enabled: true,
  profile: 'web',
  sourceRoots: ['/repo/a'],
  webUrl: 'http://127.0.0.1:3080',
  debounceMs: 250,
  healthTimeoutMs: 60_000,
  shutdownGraceMs: 10_000,
  bridgeGraceMs: 10_000,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  ignored: ['**/dist/**'],
  projectOverrides: [],
  logLevel: 'info',
}

describe('settings form model', () => {
  it('round-trips the complete editable supervisor config', () => {
    const parsed = parseSettingsDraft(createSettingsDraft(config))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(config)
  })

  it('validates natural numbers, log level, URL, and project override JSON', () => {
    const draft = {
      ...createSettingsDraft(config),
      debounceMs: '-1',
      logLevel: 'verbose',
      webUrl: 'not a url',
      projectOverrides: '{}',
    }
    const parsed = parseSettingsDraft(draft)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors).toMatchObject({
        debounceMs: expect.any(String),
        logLevel: expect.any(String),
        webUrl: expect.any(String),
        projectOverrides: expect.any(String),
      })
    }
  })

  it('emits only changed fields and unsets a cleared optional URL', () => {
    const draft = {
      ...createSettingsDraft(config),
      enabled: false,
      debounceMs: '500',
      webUrl: '',
    }
    const result = settingsOpsFromDraft(config, draft)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ops).toEqual([
      { op: 'set', path: ['enabled'], value: false },
      { op: 'unset', path: ['webUrl'] },
      { op: 'set', path: ['debounceMs'], value: 500 },
    ])
  })

  it('resets every editable field without touching immutable profile', () => {
    const ops = resetSettingsOps()
    expect(ops).toHaveLength(12)
    expect(ops.some(op => op.path[0] === 'profile')).toBe(false)
  })
})
