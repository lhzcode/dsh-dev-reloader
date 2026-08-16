import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeBridgeEvent,
  decodeBridgeHello,
  decodeSupervisorCommand,
  decodeSupervisorEvent,
  parseWireEnvelope,
} from '../../src/shared/protocol.js'

describe('parseWireEnvelope', () => {
  it('parses a valid version-1 envelope', () => {
    expect(parseWireEnvelope('{"protocolVersion":1,"type":"heartbeat"}')).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: 'heartbeat',
    })
  })

  it('rejects unknown protocol versions', () => {
    expect(() =>
      parseWireEnvelope('{"protocolVersion":2,"type":"heartbeat"}'),
    ).toThrow(/protocol/i)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseWireEnvelope('{not-json')).toThrow(/json/i)
  })

  it('rejects frames larger than 64 KiB by UTF-8 byte length', () => {
    const prefix = '{"protocolVersion":1,"type":"heartbeat","padding":"'
    const suffix = '"}'
    const paddingBytes = MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix) + 1
    const frame = prefix + 'x'.repeat(paddingBytes) + suffix

    expect(Buffer.byteLength(frame)).toBeGreaterThan(MAX_FRAME_BYTES)
    expect(() => parseWireEnvelope(frame)).toThrow(/frame/i)
  })

  it('rejects envelopes without a non-empty type', () => {
    expect(() => parseWireEnvelope('{"protocolVersion":1}')).toThrow(/type/i)
    expect(() =>
      parseWireEnvelope('{"protocolVersion":1,"type":""}'),
    ).toThrow(/type/i)
  })
})

describe('strict runtime protocol decoders', () => {
  const launch = {
    pid: 123,
    bootId: 'boot-123',
    nodeExecutable: '/usr/bin/node',
    execArgv: [],
    argv: ['dsh', 'web'],
    cwd: '/tmp/project',
    env: { PATH: '/bin' },
    profile: 'web',
    webUrl: 'http://127.0.0.1:3080',
  }

  it('fully validates bridge hello identity and launch shape', () => {
    const valid = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'bridge-hello',
      hostPid: 123,
      bootId: 'boot-123',
      launch,
      clientNonce: 'a'.repeat(64),
      clientProof: 'b'.repeat(64),
    } as const
    expect(decodeBridgeHello(valid)).toEqual(valid)
    expect(() => decodeBridgeHello({ ...valid, hostPid: 124 })).toThrow(/hostPid|pid/i)
    expect(() => decodeBridgeHello({ ...valid, bootId: 'stale' })).toThrow(/bootId/i)
    expect(decodeBridgeHello({
      ...valid,
      launch: { ...launch, env: { OK: 'yes', OMITTED: undefined } },
    }).launch.env).toEqual({ OK: 'yes', OMITTED: undefined })
    expect(() => decodeBridgeHello({ ...valid, launch: { ...launch, env: [] } })).toThrow(/env/i)
    expect(() => decodeBridgeHello({ ...valid, launch: { ...launch, env: { OK: 'yes', BAD: 1 } } })).toThrow(/env/i)
    expect(() => decodeBridgeHello({ ...valid, launch: { ...launch, argv: ['x'.repeat(16_385)] } })).toThrow(/argv|length|bound/i)
  })

  it('rejects accessors and symbol keys before reading message fields', () => {
    let getterCalls = 0
    const accessor = { protocolVersion: PROTOCOL_VERSION } as Record<string, unknown>
    Object.defineProperty(accessor, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'heartbeat'
      },
    })
    expect(() => decodeBridgeEvent(accessor)).toThrow(/data propert|accessor/i)
    expect(getterCalls).toBe(0)

    const symbolShape = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'heartbeat',
      [Symbol('hidden')]: true,
    }
    expect(() => decodeBridgeEvent(symbolShape)).toThrow(/symbol/i)
  })

  it('rejects unknown and dangerous extra shapes for every message family', () => {
    expect(() => decodeBridgeEvent({ protocolVersion: 1, type: 'heartbeat', extra: { polluted: true } })).toThrow()
    expect(() => decodeBridgeEvent({ protocolVersion: 1, type: 'activity', snapshot: { sequence: 1 } })).toThrow()
    expect(() => decodeSupervisorCommand({ protocolVersion: 1, type: 'restart', requestId: 'r', force: 'yes' })).toThrow()
    expect(() => decodeSupervisorCommand({ protocolVersion: 1, type: 'unknown', requestId: 'r' })).toThrow()
    expect(() => decodeSupervisorEvent({ protocolVersion: 1, type: 'command-result', requestId: 'r', ok: true, extra: {} })).toThrow()
    expect(() => decodeSupervisorEvent({ protocolVersion: 1, type: 'status', status: { phase: 'evil', changedAt: 1 } })).toThrow()
  })

  it.each(
    (['sequence', 'capturedAt', 'runningAgents', 'runningJobs', 'stoppingJobs'] as const)
      .flatMap(field => [
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
      ].map(value => [field, value] as const)),
  )('rejects an invalid activity snapshot %s value %s', (field, value) => {
    const snapshot = {
      sequence: 1,
      capturedAt: 100,
      runningAgents: 0,
      runningJobs: 0,
      stoppingJobs: 0,
      [field]: value,
    }

    expect(() => decodeBridgeEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: 'activity',
      snapshot,
    })).toThrow(new RegExp(field, 'i'))
  })

  it('accepts fully discriminated valid event and command variants', () => {
    expect(decodeBridgeEvent({ protocolVersion: 1, type: 'host-disposing', hostPid: 1 })).toMatchObject({ type: 'host-disposing' })
    expect(decodeBridgeEvent({ protocolVersion: 1, type: 'hmr-reload', entries: ['src/a.ts'] })).toMatchObject({ type: 'hmr-reload' })
    expect(decodeSupervisorCommand({ protocolVersion: 1, type: 'restart', requestId: 'r', force: false })).toMatchObject({ type: 'restart' })
    expect(decodeSupervisorEvent({ protocolVersion: 1, type: 'restart-planned', bootId: 'next' })).toMatchObject({ type: 'restart-planned' })
  })

  it.each(['../escape', '/absolute', '..\\escape'])(
    'rejects an unsafe SupervisorConfig profile: %s',
    profile => {
      const config = {
        enabled: true,
        profile,
        sourceRoots: [],
        debounceMs: 250,
        healthTimeoutMs: 60_000,
        shutdownGraceMs: 10_000,
        bridgeGraceMs: 10_000,
        crashWindowMs: 60_000,
        maxCrashRestarts: 3,
        ignored: [],
        projectOverrides: [],
        logLevel: 'info',
      }
      expect(() => decodeSupervisorCommand({
        protocolVersion: 1,
        type: 'update-config',
        requestId: 'unsafe-profile',
        config,
      })).toThrow(/profile/i)
    },
  )
})
