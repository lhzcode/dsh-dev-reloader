import { describe, expect, it } from 'vitest'

import {
  createSupervisorState,
  toPublicStatus,
  transitionSupervisorState,
} from '../../src/shared/state.js'

describe('supervisor state transitions', () => {
  it('supports the planned full-restart lifecycle', () => {
    let state = createSupervisorState(100)

    state = transitionSupervisorState(state, { type: 'watch-ready', at: 101 })
    expect(state.phase).toBe('watching')

    state = transitionSupervisorState(state, {
      type: 'build-started',
      at: 102,
      projects: ['plugin-a'],
    })
    expect(state.phase).toBe('building')

    state = transitionSupervisorState(state, {
      type: 'restart-pending',
      at: 103,
      reason: 'manifest changed',
    })
    expect(state.phase).toBe('pending-restart')

    state = transitionSupervisorState(state, { type: 'restart-ready', at: 104 })
    expect(state.phase).toBe('restarting')

    state = transitionSupervisorState(state, {
      type: 'host-started',
      at: 105,
      bootId: 'boot-new',
    })
    expect(state.phase).toBe('recovering')

    state = transitionSupervisorState(state, { type: 'recovered', at: 106 })
    expect(state.phase).toBe('watching')
  })

  it('allows manual restart requests while watching or degraded', () => {
    const watching = transitionSupervisorState(createSupervisorState(100), {
      type: 'watch-ready',
      at: 101,
    })
    const pendingFromWatching = transitionSupervisorState(watching, {
      type: 'restart-pending',
      at: 102,
      reason: 'manual restart',
    })
    expect(pendingFromWatching).toMatchObject({
      phase: 'pending-restart',
      reason: 'manual restart',
    })

    const degraded = transitionSupervisorState(watching, {
      type: 'degrade',
      at: 103,
      error: 'recoverable watcher failure',
    })
    const pendingFromDegraded = transitionSupervisorState(degraded, {
      type: 'restart-pending',
      at: 104,
      reason: 'manual restart',
    })
    expect(pendingFromDegraded).toMatchObject({
      phase: 'pending-restart',
      reason: 'manual restart',
    })
  })

  it('rejects paused restart transitions without an explicit resume', () => {
    const paused = transitionSupervisorState(createSupervisorState(100), {
      type: 'pause',
      at: 101,
    })

    expect(() =>
      transitionSupervisorState(paused, {
        type: 'restart-pending',
        at: 102,
        reason: 'manual restart',
      }),
    ).toThrow(/illegal/i)
    expect(() =>
      transitionSupervisorState(paused, { type: 'restart-ready', at: 103 }),
    ).toThrow(/illegal/i)

    const resumed = transitionSupervisorState(paused, {
      type: 'resume',
      at: 104,
    })
    expect(resumed.phase).toBe('starting')
  })

  it('projects only bounded public state fields', () => {
    const watching = transitionSupervisorState(createSupervisorState(100), {
      type: 'watch-ready',
      at: 101,
    })
    const building = transitionSupervisorState(watching, {
      type: 'build-started',
      at: 102,
      projects: ['plugin-a'],
    })

    expect(toPublicStatus(building)).toEqual({
      phase: 'building',
      changedAt: 102,
      projects: ['plugin-a'],
    })
  })

  it('redacts common sensitive text before exposing reason and error', () => {
    const status = toPublicStatus({
      phase: 'degraded',
      changedAt: 200,
      reason:
        'Authorization: Bearer example-sensitive-value; token=example-token; APP_SECRET=example-env-value',
      error:
        'Authorization: Basic example-basic-value password: example-password DSH_API_KEY=example-api-key',
    })

    expect(status.reason).toContain('Authorization: Bearer [REDACTED]')
    expect(status.reason).toContain('token=[REDACTED]')
    expect(status.reason).toContain('APP_SECRET=[REDACTED]')
    expect(status.error).toContain('Authorization: Basic [REDACTED]')
    expect(status.error).toContain('password: [REDACTED]')
    expect(status.error).toContain('DSH_API_KEY=[REDACTED]')
    expect(status.reason).not.toContain('example-sensitive-value')
    expect(status.reason).not.toContain('example-token')
    expect(status.reason).not.toContain('example-env-value')
    expect(status.error).not.toContain('example-basic-value')
    expect(status.error).not.toContain('example-password')
    expect(status.error).not.toContain('example-api-key')
  })
})
