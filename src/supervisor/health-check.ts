import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface HealthCheckRequest {
  readonly webUrl: string
  readonly expectedBootId: string
  readonly timeoutMs: number
  readonly pollIntervalMs?: number
  readonly observeBridgeBootId: () => string | undefined | Promise<string | undefined>
  readonly signal?: AbortSignal
  readonly request?: (url: string, signal: AbortSignal) => Promise<boolean>
}

export interface HealthObservation {
  readonly healthy: boolean
  readonly httpReady: boolean
  readonly bridgeReady: boolean
  readonly expectedBootId: string
  readonly observedBootId?: string
}

const DEFAULT_POLL_INTERVAL_MS = 100

export async function waitForHostHealth(
  request: HealthCheckRequest,
): Promise<HealthObservation> {
  requireDuration(request.timeoutMs, 'timeoutMs')
  const interval = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  requireDuration(interval, 'pollIntervalMs')
  throwIfAborted(request.signal)

  const deadline = Date.now() + request.timeoutMs
  let httpReady = false
  let observedBootId: string | undefined
  const probe = request.request ?? probeHttp

  while (true) {
    throwIfAborted(request.signal)
    const remaining = Math.max(0, deadline - Date.now())
    if (remaining === 0) {
      const bridgeReady = observedBootId === request.expectedBootId
      return observation(false, httpReady, bridgeReady, request.expectedBootId, observedBootId)
    }
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), remaining)
    timeout.unref?.()
    let currentHttpReady = false
    let currentObservedBootId: string | undefined
    try {
      const results = await Promise.all([
        boundedHttpProbe(
          () => probe(request.webUrl, controller.signal),
          remaining,
          request.signal,
        ),
        boundedBridgeObservation(
          request.observeBridgeBootId,
          remaining,
          request.signal,
        ),
      ] as const)
      currentHttpReady = results[0]
      currentObservedBootId = results[1]
      httpReady = currentHttpReady
      observedBootId = currentObservedBootId
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }

    const currentBridgeReady = currentObservedBootId === request.expectedBootId
    const bridgeReady = observedBootId === request.expectedBootId
    if (currentHttpReady && currentBridgeReady) {
      return observation(true, httpReady, bridgeReady, request.expectedBootId, observedBootId)
    }
    if (Date.now() >= deadline) {
      return observation(false, httpReady, bridgeReady, request.expectedBootId, observedBootId)
    }
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), request.signal)
  }
}

function observation(
  healthy: boolean,
  httpReady: boolean,
  bridgeReady: boolean,
  expectedBootId: string,
  observedBootId: string | undefined,
): HealthObservation {
  return observedBootId === undefined
    ? { healthy, httpReady, bridgeReady, expectedBootId }
    : { healthy, httpReady, bridgeReady, expectedBootId, observedBootId }
}

function probeHttp(value: string, signal: AbortSignal): Promise<boolean> {
  const url = new URL(value)
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: 'GET',
      headers: { 'cache-control': 'no-cache' },
      signal,
    }, response => {
      response.resume()
      response.once('end', () => resolve(
        response.statusCode !== undefined
        && response.statusCode >= 200
        && response.statusCode < 300,
      ))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function boundedHttpProbe(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return boundedObservation(probe, false, timeoutMs, signal)
}

function boundedBridgeObservation(
  observe: () => string | undefined | Promise<string | undefined>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return boundedObservation(observe, undefined, timeoutMs, signal)
}

function boundedObservation<T>(
  observe: () => T | Promise<T>,
  fallback: T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    timer.unref?.()
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError())
    }
    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    signal?.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(observe)
      .then(finish, () => finish(fallback))
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    function finish(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function requireDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}
