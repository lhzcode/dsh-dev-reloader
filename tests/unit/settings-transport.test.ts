import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'

import {
  createSettingsTransport,
  type SettingsEditOp,
} from '../../src/client/settings-transport.js'

interface Config {
  enabled: boolean
  debounceMs: number
  webUrl?: string
}

function officialScope(initial: SettingsScopeSnapshot<Config>) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const scope: SettingsScope<Config> & { setSnapshot(next: SettingsScopeSnapshot<Config>): void } = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
    setSnapshot(next) {
      snapshot = next
      listeners.forEach(listener => listener())
    },
  }
  return scope
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ready: SettingsScopeSnapshot<Config> = {
  status: 'ready',
  value: { enabled: true, debounceMs: 250 },
  base: { enabled: true, debounceMs: 250 },
  user: {},
  writable: true,
  mode: 'host',
}

const unavailable: SettingsScopeSnapshot<Config> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  writable: true,
  mode: 'host',
}

describe('settings transport', () => {
  it('prefers the official ready scope and never starts the compatibility fetch', async () => {
    const scope = officialScope(ready)
    const fetchFn = vi.fn<typeof fetch>()
    const transport = createSettingsTransport(scope, { fetchFn, loopback: true })
    const dispose = transport.subscribe(() => undefined)

    expect(transport.getSnapshot()).toMatchObject({ status: 'ready', mode: 'official' })
    expect(transport.getSnapshot()).toBe(transport.getSnapshot())
    await transport.mutate([
      { op: 'set', path: ['enabled'], value: false },
      { op: 'unset', path: ['webUrl'] },
    ])

    expect(scope.set).toHaveBeenCalledWith('enabled', false)
    expect(scope.unset).toHaveBeenCalledWith('webUrl')
    expect(fetchFn).not.toHaveBeenCalled()
    dispose()
  })

  it('loads one stable compatibility descriptor only after official unavailability on loopback', async () => {
    const scope = officialScope(unavailable)
    const fetchFn = vi.fn(async () => response({
      ok: true,
      descriptor: {
        value: { enabled: true, debounceMs: 300 },
        base: { enabled: true, debounceMs: 250 },
        user: { debounceMs: 300 },
        revision: 4,
        writable: true,
      },
    }))
    const transport = createSettingsTransport(scope, { fetchFn, loopback: true })
    const listener = vi.fn()
    const dispose = transport.subscribe(listener)

    await vi.waitFor(() => expect(transport.getSnapshot().status).toBe('ready'))
    const snapshot = transport.getSnapshot()
    expect(snapshot).toMatchObject({ mode: 'compat', revision: 4, value: { debounceMs: 300 } })
    expect(transport.getSnapshot()).toBe(snapshot)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('/plugins/dsh-dev-reloader/settings', expect.objectContaining({ method: 'GET' }))
    expect(listener).toHaveBeenCalled()
    dispose()
  })

  it('does not expose the loopback compatibility route to a remote browser', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const transport = createSettingsTransport(officialScope(unavailable), { fetchFn, loopback: false })
    const dispose = transport.subscribe(() => undefined)
    expect(transport.getSnapshot().status).toBe('unavailable')
    expect(fetchFn).not.toHaveBeenCalled()
    dispose()
  })

  it('sends one ordered compatibility mutation batch and accepts the returned revision', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (init?.method === 'POST') {
        return response({
          ok: true,
          descriptor: {
            value: { enabled: false, debounceMs: 250 },
            base: { enabled: true, debounceMs: 250 },
            user: { enabled: false },
            revision: 8,
            writable: true,
          },
        })
      }
      return response({
        ok: true,
        descriptor: {
          value: { enabled: true, debounceMs: 250 },
          base: { enabled: true, debounceMs: 250 },
          user: {},
          revision: 7,
          writable: true,
        },
      })
    })
    const transport = createSettingsTransport(officialScope(unavailable), { fetchFn: fetchFn as typeof fetch, loopback: true })
    const dispose = transport.subscribe(() => undefined)
    await vi.waitFor(() => expect(transport.getSnapshot().status).toBe('ready'))

    const ops: SettingsEditOp[] = [{ op: 'set', path: ['enabled'], value: false }]
    await transport.mutate(ops, 6)

    const post = calls.find(call => call.init?.method === 'POST')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ expectedRevision: 6, ops })
    expect(transport.getSnapshot()).toMatchObject({ revision: 8, value: { enabled: false } })
    dispose()
  })

  it('refreshes after a compatibility conflict and retains a bounded error', async () => {
    let gets = 0
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ error: 'settings changed; reload and try again' }, 409)
      gets += 1
      return response({
        ok: true,
        descriptor: {
          value: { enabled: gets === 1, debounceMs: 250 },
          base: ready.base,
          user: {},
          revision: gets,
          writable: true,
        },
      })
    })
    const transport = createSettingsTransport(officialScope(unavailable), { fetchFn: fetchFn as typeof fetch, loopback: true })
    const dispose = transport.subscribe(() => undefined)
    await vi.waitFor(() => expect(transport.getSnapshot().status).toBe('ready'))

    await expect(transport.mutate([{ op: 'set', path: ['enabled'], value: false }])).rejects.toThrow(
      'settings changed; reload and try again',
    )
    expect(gets).toBe(2)
    expect(transport.getSnapshot()).toMatchObject({ status: 'ready', revision: 2, error: 'settings changed; reload and try again' })
    dispose()
  })

  it('does not let an in-flight compatibility write overwrite newly ready official ownership', async () => {
    const scope = officialScope(unavailable)
    let resolvePost!: (value: Response) => void
    const post = new Promise<Response>(resolve => { resolvePost = resolve })
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return post
      return response({
        ok: true,
        descriptor: { value: { enabled: false, debounceMs: 250 }, base: {}, user: {}, revision: 1, writable: true },
      })
    })
    const transport = createSettingsTransport(scope, { fetchFn: fetchFn as typeof fetch, loopback: true })
    const dispose = transport.subscribe(() => undefined)
    await vi.waitFor(() => expect(transport.getSnapshot().mode).toBe('compat'))

    const mutation = transport.mutate([{ op: 'set', path: ['enabled'], value: false }])
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    scope.setSnapshot(ready)
    resolvePost(response({
      ok: true,
      descriptor: { value: { enabled: false, debounceMs: 250 }, base: {}, user: {}, revision: 2, writable: true },
    }))
    await mutation

    expect(transport.getSnapshot()).toMatchObject({ mode: 'official', value: { enabled: true } })
    dispose()
  })

  it('switches back to official ownership when that scope becomes ready', async () => {
    const scope = officialScope(unavailable)
    const fetchFn = vi.fn(async () => response({
      ok: true,
      descriptor: { value: { enabled: false, debounceMs: 250 }, base: {}, user: {}, revision: 1, writable: true },
    }))
    const transport = createSettingsTransport(scope, { fetchFn, loopback: true })
    const dispose = transport.subscribe(() => undefined)
    await vi.waitFor(() => expect(transport.getSnapshot().mode).toBe('compat'))

    scope.setSnapshot(ready)
    expect(transport.getSnapshot()).toMatchObject({ status: 'ready', mode: 'official', revision: undefined })
    dispose()
  })
})
