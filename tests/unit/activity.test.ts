import { describe, expect, it, vi } from 'vitest'

import type { ActivitySnapshot } from '../../src/shared/protocol.js'
import {
  createActivityObserver,
  type ActivityAgent,
  type ActivityObserverOptions,
} from '../../src/bridge/activity.js'

function agent(status: 'idle' | 'running'): ActivityAgent {
  return { status }
}

function job(id: string, status: 'running' | 'stopping'): { id: string; status: 'running' | 'stopping' } {
  return { id, status }
}

function makeObserver() {
  const roots = vi.fn<() => ActivityAgent[]>(() => [])
  const listAll = vi.fn<() => ActivityAgent[]>(() => [])
  const listJobs = vi.fn<(agent?: ActivityAgent) => { id: string; status: 'running' | 'stopping' }[]>(() => [])
  const publish = vi.fn()
  const sendReload = vi.fn()

  let agentStatusHandler: (() => void) | undefined
  let jobsChangedHandler: (() => void) | undefined
  let reloadHandler: ((m: ReadonlyMap<unknown, { filename: string }>) => void) | undefined
  let agentStatusDisposer: (() => void) | undefined
  let jobsChangedDisposer: (() => void) | undefined
  let reloadDisposer: (() => void) | undefined

  const subscribeAgentStatus = vi.fn<(handler: () => void) => () => void>((handler: () => void) => {
    agentStatusHandler = handler
    agentStatusDisposer = vi.fn()
    return agentStatusDisposer
  })
  const subscribeJobsChanged = vi.fn<(handler: () => void) => () => void>((handler: () => void) => {
    jobsChangedHandler = handler
    jobsChangedDisposer = vi.fn()
    return jobsChangedDisposer
  })
  const subscribeReload = vi.fn<(handler: (m: ReadonlyMap<unknown, { filename: string }>) => void) => () => void>((handler) => {
    reloadHandler = handler
    reloadDisposer = vi.fn()
    return reloadDisposer
  })

  const options: ActivityObserverOptions = {
    roots,
    listAll,
    listJobs,
    publish,
    publishReload: sendReload,
    subscribeAgentStatus,
    subscribeJobsChanged,
    subscribeReload,
    now: () => 1000,
  }

  const observer = createActivityObserver(options)

  return {
    options,
    observer,
    roots,
    listAll,
    listJobs,
    publish,
    sendReload,
    agentStatusHandler: () => agentStatusHandler?.(),
    jobsChangedHandler: () => jobsChangedHandler?.(),
    get reloadHandler() {
      return reloadHandler
    },
    disposers: () => ({
      agentStatus: agentStatusDisposer,
      jobsChanged: jobsChangedDisposer,
      reload: reloadDisposer,
    }),
    triggerReload: (reloads: ReadonlyMap<unknown, { filename: string }>) => reloadHandler?.(reloads),
  }
}

function expectSnapshot(
  snapshot: ActivitySnapshot,
  expected: {
    sequence: number
    runningAgents: number
    runningJobs: number
    stoppingJobs: number
    capturedAt?: number
  },
): void {
  expect(snapshot.sequence).toBe(expected.sequence)
  expect(snapshot.runningAgents).toBe(expected.runningAgents)
  expect(snapshot.runningJobs).toBe(expected.runningJobs)
  expect(snapshot.stoppingJobs).toBe(expected.stoppingJobs)
  if (expected.capturedAt !== undefined) {
    expect(snapshot.capturedAt).toBe(expected.capturedAt)
  }
}

describe('activity observer', () => {
  it('counts running roots as runningAgents', () => {
    const h = makeObserver()
    h.roots.mockReturnValue([
      agent('running'),
      agent('idle'),
      agent('running'),
    ])

    const snapshot = h.observer.snapshot()

    expectSnapshot(snapshot, {
      sequence: 1,
      runningAgents: 2,
      runningJobs: 0,
      stoppingJobs: 0,
      capturedAt: 1000,
    })
  })

  it('counts running and stopping jobs, deduplicating by job id across agents and unowned jobs', () => {
    const h = makeObserver()
    const agentA = agent('running')
    const agentB = agent('idle')
    h.roots.mockReturnValue([agentA])
    h.listAll.mockReturnValue([agentA, agentB])
    // Per-agent jobs for A and B; the same id appears under both agents.
    h.listJobs.mockImplementation(caller => {
      if (caller === agentA) {
        return [job('build-a', 'running'), job('shared-1', 'running')]
      }
      if (caller === agentB) {
        return [job('build-b', 'stopping'), job('shared-1', 'running')]
      }
      // Unowned jobs list (no caller).
      return [job('shared-1', 'running'), job('unowned-c', 'stopping')]
    })

    const snapshot = h.observer.snapshot()

    // shared-1 appears three times (A, B, unowned) but counts once, running.
    expectSnapshot(snapshot, {
      sequence: 1,
      runningAgents: 1,
      runningJobs: 2, // shared-1 + build-a
      stoppingJobs: 2, // build-b + unowned-c
      capturedAt: 1000,
    })
  })

  it('increments the monotonic snapshot sequence across calls and captures time from the injected clock', () => {
    const h = makeObserver()
    h.roots.mockReturnValue([agent('running')])

    expect(h.observer.snapshot().sequence).toBe(1)
    expect(h.observer.snapshot().sequence).toBe(2)
    expect(h.observer.snapshot().sequence).toBe(3)
    expect(h.observer.snapshot().capturedAt).toBe(1000)
  })

  it('publishes a snapshot on the agent/status subscription', () => {
    const h = makeObserver()
    h.roots.mockReturnValue([agent('running'), agent('running')])
    h.listAll.mockReturnValue([])

    const stop = h.observer.start()
    h.agentStatusHandler()

    expect(h.publish).toHaveBeenCalledTimes(1)
    expectSnapshot(h.publish.mock.calls[0]?.[0] as ActivitySnapshot, {
      sequence: 1,
      runningAgents: 2,
      runningJobs: 0,
      stoppingJobs: 0,
    })

    stop()
  })

  it('publishes a snapshot on the onJobsChanged subscription', () => {
    const h = makeObserver()
    h.roots.mockReturnValue([agent('running')])
    h.listAll.mockReturnValue([agent('running')])
    h.listJobs.mockReturnValue([job('build-a', 'running')])

    const stop = h.observer.start()
    h.jobsChangedHandler()

    expect(h.publish).toHaveBeenCalledTimes(1)
    expectSnapshot(h.publish.mock.calls[0]?.[0] as ActivitySnapshot, {
      sequence: 1,
      runningAgents: 1,
      runningJobs: 1,
      stoppingJobs: 0,
    })

    stop()
  })

  it('starts with all three subscriptions and disposes all of them', () => {
    const h = makeObserver()
    const stop = h.observer.start()

    expect(h.options.subscribeAgentStatus).toHaveBeenCalledTimes(1)
    expect(h.options.subscribeJobsChanged).toHaveBeenCalledTimes(1)
    expect(h.options.subscribeReload).toHaveBeenCalledTimes(1)

    const disposers = h.disposers()
    const agentStop = disposers.agentStatus as ReturnType<typeof vi.fn>
    const jobsStop = disposers.jobsChanged as ReturnType<typeof vi.fn>
    const reloadStop = disposers.reload as ReturnType<typeof vi.fn>

    expect(agentStop).not.toHaveBeenCalled()
    stop()
    expect(agentStop).toHaveBeenCalledTimes(1)
    expect(jobsStop).toHaveBeenCalledTimes(1)
    expect(reloadStop).toHaveBeenCalledTimes(1)
  })

  it('forwards hmr/reload acknowledgements with the reloaded entry filenames', () => {
    const h = makeObserver()
    const stop = h.observer.start()

    const reloads = new Map<unknown, { filename: string }>([
      ['p1', { filename: '/repo/plugin/src/index.ts' }],
      ['p2', { filename: '/repo/plugin/src/client.ts' }],
    ])
    h.triggerReload(reloads)

    expect(h.sendReload).toHaveBeenCalledTimes(1)
    expect(h.sendReload.mock.calls[0]?.[0]).toEqual([
      '/repo/plugin/src/index.ts',
      '/repo/plugin/src/client.ts',
    ])

    stop()
  })

  it('ignores reload maps with no filename-bearing entries', () => {
    const h = makeObserver()
    const stop = h.observer.start()

    h.triggerReload(new Map())

    expect(h.sendReload).not.toHaveBeenCalled()

    stop()
  })

  it('publishes a fresh monotonic snapshot after a start-triggered event', () => {
    const h = makeObserver()
    h.roots.mockReturnValue([agent('running')])
    const stop = h.observer.start()

    h.agentStatusHandler()
    h.jobsChangedHandler()

    expect(h.publish).toHaveBeenCalledTimes(2)
    expect((h.publish.mock.calls[0]?.[0] as ActivitySnapshot).sequence).toBe(1)
    expect((h.publish.mock.calls[1]?.[0] as ActivitySnapshot).sequence).toBe(2)

    stop()
  })
})
