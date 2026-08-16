import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import {
  PROTOCOL_VERSION,
  type PublicSupervisorStatus,
  type SupervisorCommand,
} from '../shared/protocol.js'
import type { IpcCommandResult } from '../supervisor/ipc.js'

/** Route URL prefix shared by the host status/health/command surfaces. */
export const BRIDGE_PREFIX = '/plugins/dsh-dev-reloader'

const STATUS_PATH = `${BRIDGE_PREFIX}/status`
const HEALTH_PATH = `${BRIDGE_PREFIX}/health`
const COMMAND_PATH = `${BRIDGE_PREFIX}/command`

export const MAX_COMMAND_BODY_BYTES = 64 * 1024

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8' }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, jsonHeaders())
  res.end(JSON.stringify(body))
}

/** Authorization metadata extracted from an incoming command request. */
export interface CommandRequestMeta {
  readonly remoteAddress: string | undefined
  /** True when a proxy/forwarded header was present; loopback trust must not extend. */
  readonly forwarded: boolean
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly contentType: string | undefined
}

export type CommandRequestAuth =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string }

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  // Accept the bare loopback literals and the IPv4-mapped IPv6 loopback.
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/**
 * Authorize an administrative command request: it must arrive directly from a
 * loopback peer, never through a proxy, never from another origin, and carry a
 * JSON content type.
 */
export function authorizeCommandRequest(
  meta: CommandRequestMeta,
): CommandRequestAuth {
  if (!isLoopbackAddress(meta.remoteAddress)) {
    return { ok: false, status: 403, error: 'forbidden: non-loopback peer' }
  }
  if (meta.forwarded) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden: forwarded request is not accepted',
    }
  }
  if (meta.origin !== undefined) {
    if (meta.host === undefined) {
      return { ok: false, status: 403, error: 'forbidden: origin without host' }
    }
    const expected = `http://${meta.host}`
    if (meta.origin !== expected) {
      return { ok: false, status: 403, error: 'forbidden: cross-origin request' }
    }
  }
  if (meta.contentType === undefined || meta.contentType.split(';')[0]!.trim() !== 'application/json') {
    return { ok: false, status: 415, error: 'unsupported media type' }
  }
  return { ok: true }
}

export type BodyReadResult =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too-large' }

/** Read a request body up to a byte bound, rejecting early on overflow. */
export async function readRequestBody(
  source: AsyncIterable<unknown> | Iterable<unknown>,
  maxBytes: number,
): Promise<BodyReadResult> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of source) {
    let buffer: Buffer
    if (typeof chunk === 'string') {
      buffer = Buffer.from(chunk, 'utf8')
    } else if (Buffer.isBuffer(chunk)) {
      buffer = chunk
    } else {
      const view = chunk as ArrayBufferView
      buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    }
    total += buffer.length
    if (total > maxBytes) return { kind: 'too-large' }
    chunks.push(buffer)
  }

  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }
}

export type ParsedCommand =
  | { readonly ok: true; readonly command: SupervisorCommand }
  | { readonly ok: false; readonly status: number; readonly error: string }

const KNOWN_COMMAND_TYPES = new Set([
  'get-status',
  'update-config',
  'rebuild',
  'restart',
  'pause',
  'stop',
])

/** Parse and validate a JSON command body against the known supervisor commands. */
export function parseCommandBody(body: string): ParsedCommand {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'command body must be an object' }
  }

  const record = parsed as Record<string, unknown>
  if (
    record.protocolVersion !== PROTOCOL_VERSION
    || typeof record.type !== 'string'
    || !KNOWN_COMMAND_TYPES.has(record.type)
    || typeof record.requestId !== 'string'
    || record.requestId.length === 0
  ) {
    return { ok: false, status: 400, error: 'unknown or malformed command' }
  }

  const command = record as unknown as SupervisorCommand
  return { ok: true, command }
}

export interface BridgeRouteDependencies {
  readonly status: () => PublicSupervisorStatus | undefined
  readonly bootId: () => string
  readonly sendCommand: (command: SupervisorCommand) => Promise<IpcCommandResult>
  readonly createRequestId?: () => string
}

export interface BridgeRoutes {
  readonly status: WebRoute
  readonly health: WebRoute
  readonly command: WebRoute
}

function fromRequest(req: IncomingMessage): CommandRequestMeta {
  const headers = req.headers
  const forwarded = headers['x-forwarded-for'] !== undefined
    || headers['x-forwarded-host'] !== undefined
    || headers['forwarded'] !== undefined
  const contentType = typeof headers['content-type'] === 'string'
    ? headers['content-type']
    : undefined
  const origin = typeof headers['origin'] === 'string'
    ? headers['origin']
    : undefined
  const host = typeof headers['host'] === 'string'
    ? headers['host']
    : undefined
  return {
    remoteAddress: req.socket.remoteAddress,
    forwarded,
    origin,
    host,
    contentType,
  }
}

export function createBridgeRoutes(deps: BridgeRouteDependencies): BridgeRoutes {
  const statusHandler: WebRoute['handler'] = (_req, res) => {
    const status = deps.status()
    sendJson(res, 200, status ?? { phase: 'starting', changedAt: Date.now() })
  }

  const healthHandler: WebRoute['handler'] = (_req, res) => {
    sendJson(res, 200, { ok: true, bootId: deps.bootId() })
  }

  const commandHandler: WebRoute['handler'] = async (req, res) => {
    const auth = authorizeCommandRequest(fromRequest(req))
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error })
      return
    }
    const body = await readRequestBody(req, MAX_COMMAND_BODY_BYTES)
    if (body.kind === 'too-large') {
      sendJson(res, 413, { error: `request body exceeds ${MAX_COMMAND_BODY_BYTES} bytes` })
      return
    }
    const parsed = parseCommandBody(body.text)
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error })
      return
    }
    let result: IpcCommandResult
    try {
      result = await deps.sendCommand(parsed.command)
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { ok: result.ok, error: result.error })
  }

  return {
    status: { kind: 'exact', path: STATUS_PATH, handler: statusHandler },
    health: { kind: 'exact', path: HEALTH_PATH, handler: healthHandler },
    command: { kind: 'exact', path: COMMAND_PATH, handler: commandHandler },
  }
}
