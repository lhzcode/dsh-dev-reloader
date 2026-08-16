import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { waitForHostHealth } from '../../src/supervisor/health-check.js'

const servers: Server[] = []

async function webServer(status = 200): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP address')
  return `http://127.0.0.1:${address.port}/health`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('host health check', () => {
  it('does not accept HTTP readiness without the expected bridge boot', async () => {
    const webUrl = await webServer()

    await expect(waitForHostHealth({
      webUrl,
      expectedBootId: 'new',
      timeoutMs: 250,
      pollIntervalMs: 5,
      observeBridgeBootId: () => undefined,
    })).resolves.toMatchObject({ healthy: false, bridgeReady: false })
  })

  it('does not accept bridge readiness without HTTP readiness', async () => {
    const unavailable = await webServer()
    await new Promise<void>(resolve => servers[0]!.close(() => resolve()))
    servers.splice(0)

    await expect(waitForHostHealth({
      webUrl: unavailable,
      expectedBootId: 'new',
      timeoutMs: 250,
      pollIntervalMs: 5,
      observeBridgeBootId: () => 'new',
    })).resolves.toMatchObject({ healthy: false, httpReady: false, bridgeReady: true })
  })

  it('rejects an old or wrong bridge bootId even when HTTP is ready', async () => {
    const webUrl = await webServer()

    await expect(waitForHostHealth({
      webUrl,
      expectedBootId: 'new',
      timeoutMs: 250,
      pollIntervalMs: 5,
      observeBridgeBootId: () => 'old',
    })).resolves.toMatchObject({
      healthy: false,
      bridgeReady: false,
      observedBootId: 'old',
    })
  })

  it('succeeds only when HTTP and the expected bridge bootId are both ready', async () => {
    const webUrl = await webServer()
    let observations = 0

    const result = await waitForHostHealth({
      webUrl,
      expectedBootId: 'new',
      timeoutMs: 500,
      pollIntervalMs: 2,
      observeBridgeBootId: () => ++observations < 2 ? undefined : 'new',
    })

    expect(result).toMatchObject({
      healthy: true,
      httpReady: true,
      bridgeReady: true,
      expectedBootId: 'new',
      observedBootId: 'new',
    })
  })

  it('races a noncompliant HTTP probe against the global deadline', async () => {
    const startedAt = Date.now()

    const result = await waitForHostHealth({
      webUrl: 'http://127.0.0.1:1/health',
      expectedBootId: 'new',
      timeoutMs: 25,
      pollIntervalMs: 2,
      request: () => new Promise<boolean>(() => undefined),
      observeBridgeBootId: () => 'new',
    })

    expect(result).toMatchObject({ healthy: false, httpReady: false })
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('requires HTTP and bridge readiness in the same polling iteration', async () => {
    const http = [true, false]
    const bridge = [undefined, 'new']

    const result = await waitForHostHealth({
      webUrl: 'http://127.0.0.1:1/health',
      expectedBootId: 'new',
      timeoutMs: 20,
      pollIntervalMs: 1,
      request: async () => http.shift() ?? false,
      observeBridgeBootId: () => bridge.shift(),
    })

    expect(result.healthy).toBe(false)
    expect(http).toHaveLength(0)
    expect(bridge).toHaveLength(0)
  })

  it('contains bridge observation failures and enforces the global deadline', async () => {
    const webUrl = await webServer()
    const startedAt = Date.now()

    const result = await waitForHostHealth({
      webUrl,
      expectedBootId: 'new',
      timeoutMs: 30,
      pollIntervalMs: 2,
      observeBridgeBootId: () => new Promise<string>(() => undefined),
    })

    expect(result).toMatchObject({ healthy: false, httpReady: true, bridgeReady: false })
    expect(Date.now() - startedAt).toBeLessThan(200)

    await expect(waitForHostHealth({
      webUrl,
      expectedBootId: 'new',
      timeoutMs: 10,
      pollIntervalMs: 2,
      observeBridgeBootId: () => { throw new Error('bridge unavailable') },
    })).resolves.toMatchObject({ healthy: false, bridgeReady: false })
  })

  it('aborts pending health checks promptly', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(waitForHostHealth({
      webUrl: 'http://127.0.0.1:1/health',
      expectedBootId: 'new',
      timeoutMs: 1_000,
      observeBridgeBootId: () => undefined,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
