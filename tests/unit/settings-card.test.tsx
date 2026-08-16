// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SupervisorConfig } from '../../src/shared/config.js'
import { SettingsCard } from '../../src/client/SettingsCard.js'
import { apply } from '../../src/client/index.js'
import { en } from '../../src/client/locales.js'
import type { DevReloaderCardState, SettingsCardFace } from '../../src/client/context-types.js'

const config: SupervisorConfig = {
  enabled: true,
  profile: 'web',
  sourceRoots: ['/repo/plugin'],
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

function state(overrides: Partial<DevReloaderCardState> = {}): DevReloaderCardState {
  return {
    status: 'ready',
    value: config,
    base: config,
    user: {},
    writable: true,
    mode: 'compat',
    revision: 1,
    error: undefined,
    ...overrides,
  }
}

function props(overrides: Partial<SettingsCardFace> = {}, snapshot = state()) {
  const face: SettingsCardFace = {
    hooks: { devReloader: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
    mutateSettings: vi.fn(async () => undefined),
    refreshSettings: vi.fn(async () => undefined),
    command: vi.fn(async () => ({ ok: true })),
    getStatus: vi.fn(async () => ({ phase: 'watching' as const })),
    getHealth: vi.fn(async () => ({ ok: true, bootId: 'boot-1' })),
    ...overrides,
  }
  return {
    ...face,
    useDevReloader: (selector: (value: DevReloaderCardState) => unknown) => selector(snapshot),
    t: (key: keyof typeof en) => en[key],
  } as never
}

describe('SettingsCard standard configuration form', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders every supervisor configuration group through the compatibility transport', async () => {
    render(<SettingsCard {...props()} />)

    expect(screen.getByTestId('dev-reloader-card')).toBeTruthy()
    expect(screen.getByText('Using the local rc.6 compatibility channel')).toBeTruthy()
    for (const label of [
      'Enable daemon', 'DSH profile', 'Web URL', 'Log level', 'Source roots',
      'Ignored paths', 'Debounce (ms)', 'Health timeout (ms)', 'Shutdown grace (ms)',
      'Bridge grace (ms)', 'Crash window (ms)', 'Maximum crash restarts',
      'Project command overrides (JSON)',
    ]) expect(screen.getByLabelText(label)).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).not.toBeTruthy()
    await waitFor(() => expect(screen.getByText('watching')).toBeTruthy())
  })

  it('stages edits and sends one changed-field batch on Save', async () => {
    const mutateSettings = vi.fn(async () => undefined)
    render(<SettingsCard {...props({ mutateSettings })} />)

    fireEvent.change(screen.getByLabelText('Debounce (ms)'), { target: { value: '500' } })
    expect(screen.getByText('Unsaved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateSettings).toHaveBeenCalledWith([
      { op: 'set', path: ['debounceMs'], value: 500 },
    ], 1))
  })

  it('clears a reverted draft without issuing an empty mutation batch', async () => {
    const mutateSettings = vi.fn(async () => undefined)
    render(<SettingsCard {...props({ mutateSettings })} />)
    const input = screen.getByLabelText('Debounce (ms)')
    fireEvent.change(input, { target: { value: '500' } })
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull())
    expect(mutateSettings).not.toHaveBeenCalled()
  })

  it('does not overwrite unrelated external changes while a draft is dirty', async () => {
    const mutateSettings = vi.fn(async () => undefined)
    const view = render(<SettingsCard {...props({ mutateSettings })} />)
    fireEvent.change(screen.getByLabelText('Debounce (ms)'), { target: { value: '500' } })

    const externalConfig = { ...config, sourceRoots: ['/repo/external-change'] }
    view.rerender(<SettingsCard {...props({ mutateSettings }, state({ value: externalConfig, revision: 2 }))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateSettings).toHaveBeenCalledWith([
      { op: 'set', path: ['debounceMs'], value: 500 },
    ], 1))
  })

  it('validates staged fields before issuing a write', async () => {
    const mutateSettings = vi.fn(async () => undefined)
    render(<SettingsCard {...props({ mutateSettings })} />)
    fireEvent.change(screen.getByLabelText('Debounce (ms)'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Correct the highlighted settings.')).toBeTruthy()
    expect(mutateSettings).not.toHaveBeenCalled()
  })

  it('resets all editable fields without mutating immutable profile', async () => {
    const mutateSettings = vi.fn(async () => undefined)
    render(<SettingsCard {...props({ mutateSettings })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    await waitFor(() => expect(mutateSettings).toHaveBeenCalled())
    const ops = mutateSettings.mock.calls[0]![0]
    expect(ops).toHaveLength(12)
    expect(ops.some((op: { path: string[] }) => op.path[0] === 'profile')).toBe(false)
  })

  it('keeps the card and all supervisor commands available when both settings transports fail', async () => {
    const command = vi.fn(async () => ({ ok: true }))
    const unavailable = state({
      status: 'unavailable', value: undefined, base: undefined, user: undefined,
      mode: 'unavailable', revision: undefined, writable: true,
      error: 'settings namespace is unavailable',
    })
    render(<SettingsCard {...props({ command }, unavailable)} />)

    expect(screen.getByTestId('dev-reloader-card')).toBeTruthy()
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    for (const name of ['Rebuild', 'Restart', 'Force restart']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('rebuild'))
  })

  it('disables form and command mutations for a read-only Host document', () => {
    render(<SettingsCard {...props({}, state({ writable: false }))} />)
    expect((screen.getByLabelText('Enable daemon') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Rebuild' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('requires confirmation for normal and force restarts', async () => {
    const command = vi.fn(async () => ({ ok: true }))
    render(<SettingsCard {...props({ command })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('restart', { force: false }))

    fireEvent.click(screen.getByRole('button', { name: 'Force restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Force' }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm again/ }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('restart', { force: true }))
  })
})

describe('client apply registration', () => {
  it('registers the locale and standard card with a ready official settings scope', () => {
    const localeDisposer = vi.fn()
    const effectFns: Array<() => unknown> = []
    const registerCard = vi.fn(() => vi.fn())
    const scopeSnapshot = {
      status: 'ready' as const,
      value: config,
      base: config,
      user: {},
      writable: true,
      mode: 'host' as const,
    }
    const scope = {
      getSnapshot: () => scopeSnapshot,
      subscribe: vi.fn(() => vi.fn()),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const ctx = {
      effect: vi.fn((fn: () => unknown) => { effectFns.push(fn) }),
      locale: { register: vi.fn(() => localeDisposer) },
      settingsScope: { bind: vi.fn(() => scope) },
      get: vi.fn((name: string) => name === 'connection' ? { isLoopback: true } : undefined),
      slots: {
        inject: vi.fn((_name: string, fn: () => unknown) => fn()),
        register: registerCard,
      },
    }

    apply(ctx as never)
    expect(ctx.settingsScope.bind).toHaveBeenCalledWith({ namespace: 'dsh-dev-reloader' })
    expect(registerCard).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'settings.plugin.item', id: 'dsh-dev-reloader' }),
      SettingsCard,
    )
    expect(ctx.locale.register).not.toHaveBeenCalled()
    const disposer = effectFns[0]!() as () => void
    expect(ctx.locale.register).toHaveBeenCalledWith('dev-reloader.card', expect.any(Object))
    disposer()
    expect(localeDisposer).toHaveBeenCalledOnce()
  })
})
