import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js'
import {
  authorizeCommandRequest,
  createBridgeRoutes,
  parseCommandBody,
  readRequestBody,
  type BridgeRouteDependencies,
  type CommandRequestMeta,
} from '../../src/bridge/routes.js'

const MAX_BODY = 64 * 1024

function meta(overrides: Partial<CommandRequestMeta> = {}): CommandRequestMeta {
  return {
    remoteAddress: '127.0.0.1',
    forwarded: false,
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    contentType: 'application/json',
    ...overrides,
  }
}

function commandDeps(overrides: Partial<BridgeRouteDependencies> = {}): BridgeRouteDependencies {
  return {
    status: () => ({ phase: 'watching' as const, changedAt: 123 }),
    bootId: () => 'boot-1',
    sendCommand: vi.fn(async () => ({ ok: true, requestId: 'req-1' })),
    createRequestId: () => 'req-1',
    ...overrides,
  }
}

describe('bridge routes authorization', () => {
  it('accepts a loopback remote address', () => {
    expect(authorizeCommandRequest(meta({ remoteAddress: '127.0.0.1' }))).toEqual({ ok: true })
    expect(authorizeCommandRequest(meta({ remoteAddress: '::1' }))).toEqual({ ok: true })
  })

  it('rejects a non-loopback remote address', () => {
    const result = authorizeCommandRequest(meta({ remoteAddress: '10.0.0.2' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('rejects a request carrying a forwarded remote address', () => {
    const result = authorizeCommandRequest(meta({ forwarded: true, remoteAddress: '127.0.0.1' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('rejects a request with no remote address', () => {
    const result = authorizeCommandRequest(meta({ remoteAddress: undefined }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('rejects a cross-origin request', () => {
    const result = authorizeCommandRequest(meta({ origin: 'http://evil.example' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('accepts a same-origin request and a missing origin header', () => {
    expect(authorizeCommandRequest(meta())).toEqual({ ok: true })
    expect(authorizeCommandRequest(meta({ origin: undefined }))).toEqual({ ok: true })
  })

  it('rejects a non-JSON content type', () => {
    const result = authorizeCommandRequest(meta({ contentType: 'text/plain' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(415)
  })
})

describe('parseCommandBody', () => {
  it('accepts a known command with a requestId', async () => {
    const result = await parseCommandBody(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'rebuild',
      requestId: 'req-9',
    }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.command.type).toBe('rebuild')
      expect(result.command.requestId).toBe('req-9')
    }
  })

  it("rejects invalid JSON", async () => {
    const result = await parseCommandBody('not-json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it("rejects an unknown command type", async () => {
    const result = await parseCommandBody(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'make-coffee',
      requestId: 'req-9',
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it("rejects a command missing a requestId", async () => {
    const result = await parseCommandBody(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'rebuild',
    }))
    expect(result.ok).toBe(false)
  })
})

describe('readRequestBody', () => {
  it('accepts a body at or below 64 KiB', async () => {
    const body = 'x'.repeat(70_000 / 2)
    const stream = new PassThrough()
    stream.end(body)

    const result = await readRequestBody(stream, MAX_BODY)

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.text.length).toBe(body.length)
  })

  it('rejects a body larger than 64 KiB once the bound is exceeded', async () => {
    const stream = new PassThrough()
    // Write more than the bound in chunks so the reader trips mid-stream.
    for (const chunk of ['a'.repeat(40 * 1024), 'b'.repeat(40 * 1024)]) {
      stream.write(chunk)
    }
    stream.end()

    const result = await readRequestBody(stream, MAX_BODY)

    expect(result.kind).toBe('too-large')
  })
})

describe('command route handler', () => {
  function request(overrides: { remoteAddress?: string; forwarded?: boolean; headers?: Record<string, string | undefined>; body?: string } = {}): IncomingMessage {
    const stream = new PassThrough() as unknown as IncomingMessage
    stream.socket = { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' } as typeof stream.socket
    stream.headers = {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
      ...overrides.headers,
    } as typeof stream.headers
    if (overrides.forwarded) stream.headers['x-forwarded-for'] = '10.0.0.2'
    const body = overrides.body ?? JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'rebuild',
      requestId: 'req-1',
    })
    stream.end(body)
    return stream
  }

  function response() {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, unknown>,
      body: '',
      writeHead(status: number, headers: Record<string, string>): void {
        this.statusCode = status
        this.headers = headers
      },
      end(raw: string | Buffer): void {
        this.body = typeof raw === 'string' ? raw : raw.toString()
      },
    }
    return res
  }

  it('registers exact routes for status, health, and command', () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)

    expect(routes.status.kind).toBe('exact')
    expect(routes.status.path).toBe('/plugins/dsh-dev-reloader/status')
    expect(routes.health.path).toBe('/plugins/dsh-dev-reloader/health')
    expect(routes.command.path).toBe('/plugins/dsh-dev-reloader/command')
  })

  it('health returns the current bootId and a healthy flag without env or token data', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.health.handler(request({ body: '' }) as any, res as any)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ ok: true, bootId: 'boot-1' })
    expect(JSON.stringify(body)).not.toContain('token')
  })

  it('status returns a redacted public status without environment data', async () => {
    const deps = commandDeps({
      status: () => ({ phase: 'watching' as const, changedAt: 123, projects: ['/repo/plugin'] }),
    })
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.status.handler(request({ body: '' }) as any, res as any)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ phase: 'watching', changedAt: 123 })
    expect(JSON.stringify(body)).not.toContain('token')
    expect(JSON.stringify(body)).not.toContain('env')
  })

  it('command forwards a valid rebuild command to the supervisor', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.command.handler(request() as any, res as any)

    expect(res.statusCode).toBe(200)
    expect(deps.sendCommand).toHaveBeenCalledTimes(1)
    const sent = (deps.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(sent).toMatchObject({ protocolVersion: PROTOCOL_VERSION, type: 'rebuild', requestId: 'req-1' })
  })

  it('command returns 503 instead of hanging when the supervisor bridge is disconnected', async () => {
    const deps = commandDeps({
      sendCommand: vi.fn(async () => { throw new Error('supervisor is not connected') }),
    })
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.command.handler(request() as any, res as any)

    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('supervisor is not connected')
  })

  it('command returns 403 for a non-loopback remote address', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.command.handler(request({ remoteAddress: '203.0.113.5' }) as any, res as any)

    expect(res.statusCode).toBe(403)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it('command returns 403 for a forwarded request', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.command.handler(request({ forwarded: true }) as any, res as any)

    expect(res.statusCode).toBe(403)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it('command returns 400 for an invalid or unknown command body', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    await routes.command.handler(request({ body: '{"type":"make-coffee"}' }) as any, res as any)

    expect(res.statusCode).toBe(400)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it('command returns 413 for an oversized body', async () => {
    const deps = commandDeps()
    const routes = createBridgeRoutes(deps)
    const res = response()

    const bigBody = 'a'.repeat(70 * 1024)
    await routes.command.handler(request({ body: bigBody }) as any, res as any)

    expect(res.statusCode).toBe(413)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })
})
