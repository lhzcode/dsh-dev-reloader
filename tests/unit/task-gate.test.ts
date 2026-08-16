import { describe, expect, it, vi } from 'vitest'

import type { ActivitySnapshot } from '../../src/shared/protocol.js'
import { createTaskGate } from '../../src/supervisor/task-gate.js'

function activity(
  sequence: number,
  overrides: Partial<ActivitySnapshot> = {},
): ActivitySnapshot {
  return {
    sequence,
    capturedAt: sequence * 100,
    runningAgents: 0,
    runningJobs: 0,
    stoppingJobs: 0,
    ...overrides,
  }
}

describe('fail-closed task gate', () => {
  it('starts closed until the bridge supplies a known idle snapshot', () => {
    const gate = createTaskGate()

    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })
    expect(gate.updateActivity(activity(1))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })
  })

  it.each([
    ['agents-running', { runningAgents: 2 }],
    ['jobs-running', { runningJobs: 1 }],
    ['jobs-stopping', { stoppingJobs: 3 }],
  ] as const)('closes for %s', (reason, counts) => {
    const gate = createTaskGate()

    gate.updateActivity(activity(1, counts))

    expect(gate.inspect()).toEqual({ open: false, reason })
  })

  it('counts local tasks and makes completion idempotent', () => {
    const gate = createTaskGate()
    gate.updateActivity(activity(1))

    const finishBuild = gate.beginLocalTask('build:plugin-a')
    const finishTests = gate.beginLocalTask('test:plugin-a')
    expect(gate.inspect()).toEqual({ open: false, reason: 'local-tasks' })

    finishBuild()
    finishBuild()
    expect(gate.inspect()).toEqual({ open: false, reason: 'local-tasks' })

    finishTests()
    expect(gate.inspect()).toEqual({ open: true })
  })

  it('disconnects fail closed and requires a strictly newer snapshot to reopen', () => {
    const gate = createTaskGate()
    expect(gate.updateActivity(activity(10))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })

    gate.bridgeDisconnected()
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })
    expect(gate.updateActivity(activity(9))).toBe(false)
    expect(gate.updateActivity(activity(10))).toBe(false)
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })

    expect(gate.updateActivity(activity(11))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })
  })

  it('resets sequence admission for a replacement bridge while keeping waiters fail-closed', async () => {
    const gate = createTaskGate()
    expect(gate.updateActivity(activity(100))).toBe(true)
    gate.bridgeReplaced()
    const resolved = vi.fn()
    void gate.waitUntilOpen().then(resolved)
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })

    expect(gate.updateActivity(activity(1, { runningAgents: 1 }))).toBe(true)
    await Promise.resolve()
    expect(gate.inspect()).toEqual({ open: false, reason: 'agents-running' })
    expect(resolved).not.toHaveBeenCalled()

    expect(gate.updateActivity(activity(2))).toBe(true)
    await gate.waitUntilOpen()
    expect(resolved).toHaveBeenCalledOnce()
  })

  it('accepts a sequence-zero snapshot from a replacement bridge', () => {
    const gate = createTaskGate()
    expect(gate.updateActivity(activity(100))).toBe(true)
    gate.bridgeReplaced()
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })

    expect(gate.updateActivity(activity(0))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })
  })

  it('rejects stale activity while connected without replacing newer state', () => {
    const gate = createTaskGate()
    gate.updateActivity(activity(5, { runningAgents: 1 }))

    expect(gate.updateActivity(activity(4))).toBe(false)
    expect(gate.updateActivity(activity(5))).toBe(false)
    expect(gate.inspect()).toEqual({ open: false, reason: 'agents-running' })
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
  )('fails closed for a malformed direct snapshot %s value %s', (field, value) => {
    const gate = createTaskGate()
    expect(gate.updateActivity(activity(5))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })

    const malformed = activity(100, { [field]: value })
    expect(gate.updateActivity(malformed)).toBe(false)
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })

    expect(gate.updateActivity(activity(6))).toBe(true)
    expect(gate.inspect()).toEqual({ open: true })
  })

  it('does not resolve waiters for malformed activity', async () => {
    const gate = createTaskGate()
    const resolved = vi.fn()
    void gate.waitUntilOpen().then(resolved)

    expect(gate.updateActivity(activity(1, { runningJobs: Number.NaN }))).toBe(false)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    expect(gate.inspect()).toEqual({ open: false, reason: 'bridge-unknown' })

    expect(gate.updateActivity(activity(1))).toBe(true)
    await gate.waitUntilOpen()
    expect(resolved).toHaveBeenCalledTimes(1)
  })

  it('resolves every current waiter only after bridge and local activity are idle', async () => {
    const gate = createTaskGate()
    const finish = gate.beginLocalTask('build:plugin-a')
    const first = vi.fn()
    const second = vi.fn()
    void gate.waitUntilOpen().then(first)
    void gate.waitUntilOpen().then(second)

    gate.updateActivity(activity(1, { runningJobs: 1 }))
    finish()
    await Promise.resolve()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    gate.updateActivity(activity(2))
    await Promise.all([gate.waitUntilOpen(), Promise.resolve()])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('waits again after a later disconnect and resolves immediately while open', async () => {
    const gate = createTaskGate()
    gate.updateActivity(activity(1))
    await expect(gate.waitUntilOpen()).resolves.toBeUndefined()

    gate.bridgeDisconnected()
    let resolved = false
    const waiting = gate.waitUntilOpen().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    gate.updateActivity(activity(2))
    await waiting
    expect(resolved).toBe(true)
  })

  it('supports aborting one waiter without affecting other waiters', async () => {
    const gate = createTaskGate()
    const controller = new AbortController()
    const aborted = gate.waitUntilOpen(controller.signal)
    const remaining = gate.waitUntilOpen()

    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    gate.updateActivity(activity(1))
    await expect(remaining).resolves.toBeUndefined()
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const gate = createTaskGate()
    const controller = new AbortController()
    controller.abort()

    await expect(gate.waitUntilOpen(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('keeps force bypass outside the reusable safety gate', () => {
    const gate = createTaskGate()

    expect('forceOpen' in gate).toBe(false)
    expect('force' in gate).toBe(false)
  })
})
