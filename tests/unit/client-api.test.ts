import { describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js'
import {
  ApiError,
  MAX_COMMAND_BODY_BYTES,
  createDevReloaderApi,
  STATUS_PATH,
  HEALTH_PATH,
  COMMAND_PATH,
} from '../../src/client/api.js'

const BASE = 'http://127.0.0.1:3080'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(handler)
  const api = createDevReloaderApi(fetchImpl as unknown as typeof fetch, BASE)
  return { api, fetchImpl }
}

const statusBody = {
  phase: 'watching',
  changedAt: 1_700_000,
  bootId: 'boot-a',
}

describe('dev reloader api', () => {
  it('getStatus fetches the status route and returns a typed status', async () => {
    const { api, fetchImpl } = mockFetch((url, init) => {
      expect(url).toBe(`${BASE}${STATUS_PATH}`)
      expect(init.method ?? 'GET').toBe('GET')
      expect(init.cache).toBe('no-store')
      return jsonResponse(statusBody)
    })

    await expect(api.getStatus()).resolves.toMatchObject({ phase: 'watching', bootId: 'boot-a' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('getHealth fetches the health route and returns healthy plus boot id', async () => {
    const { api, fetchImpl } = mockFetch((url, init) => {
      expect(url).toBe(`${BASE}${HEALTH_PATH}`)
      expect(init.cache).toBe('no-store')
      return jsonResponse({ ok: true, bootId: 'boot-b' })
    })

    await expect(api.getHealth()).resolves.toEqual({ ok: true, bootId: 'boot-b' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('command POSTs a protocol envelope to the command route', async () => {
    const { api, fetchImpl } = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}${COMMAND_PATH}`)
      expect(init.method).toBe('POST')
      const headers = init.headers as Record<string, string>
      expect(headers['content-type']).toContain('application/json')
      const body = JSON.parse(init.body as string)
      expect(body.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(body.type).toBe('rebuild')
      expect(typeof body.requestId).toBe('string')
      expect(body.requestId.length).toBeGreaterThan(0)
      return jsonResponse({ ok: true })
    })

    await expect(api.command('rebuild')).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('restart command carries the force flag', async () => {
    const { api } = mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body.type).toBe('restart')
      expect(body.force).toBe(true)
      return jsonResponse({ ok: true })
    })

    await expect(api.command('restart', { force: true })).resolves.toEqual({ ok: true })
  })

  it('update-config body stays under the command body bound', async () => {
    const { api } = mockFetch(async (_url, init) => {
      const byteLength = new TextEncoder().encode(String(init.body)).byteLength
      expect(byteLength).toBeLessThanOrEqual(MAX_COMMAND_BODY_BYTES)
      return jsonResponse({ ok: true })
    })

    const config = {
      enabled: true,
      profile: 'web',
      sourceRoots: [] as string[],
      debounceMs: 250,
      healthTimeoutMs: 60_000,
      shutdownGraceMs: 10_000,
      bridgeGraceMs: 10_000,
      crashWindowMs: 60_000,
      maxCrashRestarts: 3,
      ignored: [] as string[],
      projectOverrides: [] as never[],
      logLevel: 'info' as const,
    }
    await expect(api.command('update-config', { config } as never)).resolves.toEqual({ ok: true })
  })

  it('pauses, stops and issues get-status through the same command helper', async () => {
    const calls: string[] = []
    const { api } = mockFetch(async (_url, init) => {
      calls.push((JSON.parse(String(init.body)) as { type: string }).type)
      return jsonResponse({ ok: true })
    })

    await api.command('pause')
    await api.command('stop')
    await api.command('get-status')
    expect(calls).toEqual(['pause', 'stop', 'get-status'])
  })

  it('maps a non-ok HTTP status into an ApiError carrying status and body', async () => {
    const { api } = mockFetch(() => jsonResponse({ error: 'forbidden: non-loopback peer' }, 403))
    const error = await api.command('rebuild').then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(403)
    expect((error as ApiError).body).toContain('forbidden')
  })

  it('maps an unexpected network failure into an ApiError', async () => {
    const { api } = mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    await expect(api.getStatus()).rejects.toBeInstanceOf(ApiError)
  })
})
