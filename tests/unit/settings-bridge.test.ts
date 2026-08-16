import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'

import {
  MAX_SETTINGS_BODY_BYTES,
  createSettingsRoute,
  parseSettingsMutation,
  type SettingsBridgeDependencies,
} from '../../src/bridge/settings.js'

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    value: { enabled: true, debounceMs: 250 },
    base: { enabled: true },
    user: { debounceMs: 250 },
    revision: 3,
    writable: true,
    ...overrides,
  }
}

function deps(overrides: Partial<SettingsBridgeDependencies> = {}): SettingsBridgeDependencies {
  return {
    describe: vi.fn(() => descriptor()),
    mutate: vi.fn(async () => undefined),
    ...overrides,
  }
}

function request(options: {
  method?: string
  remoteAddress?: string
  headers?: Record<string, string | undefined>
  body?: string
} = {}): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage
  stream.method = options.method ?? 'GET'
  stream.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' } as typeof stream.socket
  stream.headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
    ...options.headers,
  } as typeof stream.headers
  stream.end(options.body ?? '')
  return stream
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>): void {
      this.statusCode = status
      this.headers = headers
    },
    end(raw: string | Buffer = ''): void {
      this.body = typeof raw === 'string' ? raw : raw.toString()
    },
  }
}

async function invoke(
  bridgeDeps: SettingsBridgeDependencies,
  options: Parameters<typeof request>[0] = {},
) {
  const res = response()
  await createSettingsRoute(bridgeDeps).handler(request(options) as never, res as never)
  return { res, body: JSON.parse(res.body) as Record<string, unknown> }
}

describe('settings bridge route', () => {
  it('returns the current redacted descriptor on a loopback GET without requiring Origin or Content-Type', async () => {
    const bridgeDeps = deps({ describe: vi.fn(() => descriptor({ writable: false })) })
    const { res, body } = await invoke(bridgeDeps, {
      headers: { origin: undefined, 'content-type': undefined },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(body).toEqual({ ok: true, descriptor: descriptor({ writable: false }) })
  })

  it.each([
    [{ remoteAddress: '10.0.0.2' }, 403],
    [{ headers: { 'x-forwarded-for': '10.0.0.2' } }, 403],
    [{ method: 'DELETE' }, 405],
  ] as const)('rejects an unauthorized or unsupported read', async (options, status) => {
    const { res } = await invoke(deps(), options)
    expect(res.statusCode).toBe(status)
  })

  it('returns 503 when the registered namespace is unavailable', async () => {
    const { res } = await invoke(deps({ describe: () => undefined }))
    expect(res.statusCode).toBe(503)
  })

  it('forwards one ordered set/unset batch with the optimistic revision', async () => {
    const bridgeDeps = deps()
    const ops = [
      { op: 'set', path: ['enabled'], value: false },
      { op: 'unset', path: ['webUrl'] },
    ]
    const { res } = await invoke(bridgeDeps, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 3, ops }),
    })

    expect(res.statusCode).toBe(200)
    expect(bridgeDeps.mutate).toHaveBeenCalledWith(ops, 3)
    expect(bridgeDeps.describe).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ headers: { origin: 'http://evil.example' }, body: '{}' }, 403],
    [{ headers: { 'content-type': 'text/plain' }, body: '{}' }, 415],
    [{ body: 'not-json' }, 400],
    [{ body: JSON.stringify({ expectedRevision: -1, ops: [] }) }, 400],
    [{ body: JSON.stringify({ ops: [{ op: 'set', path: ['profile'], value: 'other' }] }) }, 400],
    [{ body: JSON.stringify({ ops: [{ op: 'set', path: ['enabled', 'nested'], value: true }] }) }, 400],
    [{ body: JSON.stringify({ ops: [{ op: 'unset', path: ['unknown'] }] }) }, 400],
    [{ body: JSON.stringify({ ops: Array.from({ length: 65 }, () => ({ op: 'unset', path: ['webUrl'] })) }) }, 413],
  ] as const)('rejects invalid writes', async (extra, status) => {
    const { res } = await invoke(deps(), { method: 'POST', ...extra })
    expect(res.statusCode).toBe(status)
  })

  it('rejects an oversized request body', async () => {
    const { res } = await invoke(deps(), {
      method: 'POST',
      body: 'x'.repeat(MAX_SETTINGS_BODY_BYTES + 1),
    })
    expect(res.statusCode).toBe(413)
  })

  it('maps optimistic revision conflicts without exposing exception details', async () => {
    const conflict = new SettingsConflictError('dsh-dev-reloader' as never, 2, 3)
    const { res, body } = await invoke(deps({ mutate: vi.fn(async () => { throw conflict }) }), {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2, ops: [{ op: 'set', path: ['enabled'], value: false }] }),
    })
    expect(res.statusCode).toBe(409)
    expect(body.error).toBe('settings changed; reload and try again')
  })

  it('bounds internal failures and never serializes secret values or stacks', async () => {
    const error = new Error('token=super-secret')
    error.stack = 'STACK token=super-secret'
    const { res, body } = await invoke(deps({ mutate: vi.fn(async () => { throw error }) }), {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'set', path: ['enabled'], value: false }] }),
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(body)).toBe('{"error":"settings update failed"}')
  })
})

describe('parseSettingsMutation', () => {
  it('rejects extra body and operation keys and non-JSON-shaped values', () => {
    expect(parseSettingsMutation(JSON.stringify({ ops: [], extra: true })).ok).toBe(false)
    expect(parseSettingsMutation(JSON.stringify({ ops: [{ op: 'unset', path: ['enabled'], extra: true }] })).ok).toBe(false)
    expect(parseSettingsMutation(JSON.stringify({ ops: [{ op: 'set', path: ['enabled'] }] })).ok).toBe(false)
  })
})
