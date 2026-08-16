import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChangeEvent } from '../../src/supervisor/classifier.js'
import type { ProjectDescriptor } from '../../src/supervisor/discovery.js'
import { createChangeScheduler } from '../../src/supervisor/scheduler.js'
import { FakeBuilder } from '../fixtures/fake-builder.js'

function project(root = '/workspace/packages/plugin'): ProjectDescriptor {
  const workspaceRoot = '/workspace'
  return {
    id: 'linked-plugin:fixture:abc123',
    kind: 'linked-plugin',
    root,
    workspaceRoot,
    packageName: 'fixture-plugin',
    serverEntries: [join(root, 'src', 'index.ts')],
    clientEntries: [join(root, 'src', 'client', 'index.tsx')],
    manifests: [join(root, 'package.json'), join(root, 'tsconfig.json')],
    outputRoots: [join(root, 'lib')],
    build: { executable: 'pnpm', args: ['run', 'build'], cwd: root },
    devWeb: { executable: 'pnpm', args: ['run', 'dev:web'], cwd: root },
  }
}

function event(path: string, origin: ChangeEvent['origin'] = 'project'): ChangeEvent {
  return { project: project(), path, origin }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('serialized change scheduler', () => {
  it('debounces changes into one classified cycle', async () => {
    const builder = new FakeBuilder()
    const ready = vi.fn()
    const scheduler = createChangeScheduler({
      debounceMs: 50,
      runBuilds: builder.run,
      onReady: ready,
    })

    scheduler.enqueue(event('src/index.ts'))
    scheduler.enqueue(event('src/index.ts'))
    scheduler.enqueue(event('src/client/index.tsx'))
    await vi.advanceTimersByTimeAsync(49)
    expect(builder.plans).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const result = await scheduler.waitForIdle()

    expect(result).toEqual({ kind: 'success' })
    expect(builder.plans).toHaveLength(1)
    expect(builder.plans[0]?.actions.map(action => action.kind)).toEqual([
      'build',
      'client-watch',
      'server-hmr',
    ])
    expect(ready).toHaveBeenCalledTimes(1)
    await scheduler.close()
  })

  it('runs one active cycle and coalesces 100 blocked-build changes into one dirty follow-up', async () => {
    const builder = new FakeBuilder()
    const blocked = builder.block()
    builder.succeed()
    const scheduler = createChangeScheduler({
      debounceMs: 25,
      runBuilds: builder.run,
      onReady: () => undefined,
    })

    scheduler.enqueue(event('src/index.ts'))
    await vi.advanceTimersByTimeAsync(25)
    expect(builder.plans).toHaveLength(1)

    for (let index = 0; index < 100; index += 1) {
      scheduler.enqueue(event(`src/generated-${index}.ts`))
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(builder.plans).toHaveLength(1)

    blocked.succeed()
    await vi.runAllTimersAsync()
    await scheduler.waitForIdle()

    expect(builder.plans).toHaveLength(2)
    await scheduler.close()
  })

  it('returns build-failed and never invokes the restart-ready hook', async () => {
    const builder = new FakeBuilder()
    builder.fail('compile error: TOKEN=do-not-copy')
    const ready = vi.fn()
    const scheduler = createChangeScheduler({
      debounceMs: 10,
      runBuilds: builder.run,
      onReady: ready,
    })

    scheduler.enqueue(event('src/index.ts'))
    await vi.advanceTimersByTimeAsync(10)

    await expect(scheduler.waitForIdle()).resolves.toEqual({
      kind: 'build-failed',
      error: 'compile error: TOKEN=[REDACTED]',
    })
    expect(ready).not.toHaveBeenCalled()
    await scheduler.close()
  })

  it('close clears pending work, waits for an active cycle, and resolves idle waiters', async () => {
    const builder = new FakeBuilder()
    const blocked = builder.block()
    const ready = vi.fn()
    const scheduler = createChangeScheduler({
      debounceMs: 10,
      runBuilds: builder.run,
      onReady: ready,
    })

    scheduler.enqueue(event('src/index.ts'))
    await vi.advanceTimersByTimeAsync(10)
    const idle = scheduler.waitForIdle()
    const closing = scheduler.close()
    scheduler.enqueue(event('src/ignored-after-close.ts'))
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)

    blocked.succeed()
    await closing

    await expect(idle).resolves.toEqual({ kind: 'success' })
    expect(builder.plans).toHaveLength(1)
    expect(ready).not.toHaveBeenCalled()
  })

  it('aborts the active build when closing', async () => {
    let observedSignal: AbortSignal | undefined
    const ready = vi.fn()
    const scheduler = createChangeScheduler({
      debounceMs: 10,
      runBuilds: (_plan, signal) => {
        observedSignal = signal
        return new Promise(resolve => {
          signal.addEventListener('abort', () => {
            resolve({ kind: 'build-failed', error: 'aborted' })
          }, { once: true })
        })
      },
      onReady: ready,
    })

    scheduler.enqueue(event('src/index.ts'))
    await vi.advanceTimersByTimeAsync(10)
    await scheduler.close()

    expect(observedSignal?.aborted).toBe(true)
    expect(ready).not.toHaveBeenCalled()
  })

  it('contains classification failures as structured build failures without unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    const builder = new FakeBuilder()
    const ready = vi.fn()
    const scheduler = createChangeScheduler({
      debounceMs: 10,
      runBuilds: builder.run,
      onReady: ready,
    })

    try {
      scheduler.enqueue(event('src/%2f.ts'))
      await vi.advanceTimersByTimeAsync(10)

      await expect(scheduler.waitForIdle()).resolves.toMatchObject({
        kind: 'build-failed',
        error: expect.stringMatching(/POSIX normalized relative path/i),
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toEqual([])
      expect(builder.plans).toEqual([])
      expect(ready).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await scheduler.close()
    }
  })

  it('replaces stale success when a follow-up cycle fails during classification', async () => {
    const builder = new FakeBuilder()
    const blocked = builder.block()
    const scheduler = createChangeScheduler({
      debounceMs: 10,
      runBuilds: builder.run,
      onReady: () => undefined,
    })

    scheduler.enqueue(event('src/index.ts'))
    await vi.advanceTimersByTimeAsync(10)
    scheduler.enqueue(event('src/%2f.ts'))
    blocked.succeed()

    await expect(scheduler.waitForIdle()).resolves.toMatchObject({
      kind: 'build-failed',
      error: expect.stringMatching(/POSIX normalized relative path/i),
    })
    await scheduler.close()
  })

  it('merges project and workspace-origin events into one deterministic plan', async () => {
    const builder = new FakeBuilder()
    const readyPlans: unknown[] = []
    const scheduler = createChangeScheduler({
      debounceMs: 20,
      runBuilds: builder.run,
      onReady: plan => { readyPlans.push(plan) },
    })

    scheduler.enqueue(event('src/index.ts', 'project'))
    scheduler.enqueue(event('pnpm-lock.yaml', 'workspace'))
    await vi.advanceTimersByTimeAsync(20)
    await scheduler.waitForIdle()

    expect(builder.plans).toHaveLength(1)
    expect(builder.plans[0]).toMatchObject({ impact: 'full-restart' })
    expect(builder.plans[0]?.actions.map(action => action.kind)).toEqual([
      'dependency-install',
      'build',
      'server-hmr',
      'full-restart',
    ])
    expect(readyPlans).toEqual([builder.plans[0]])
    await scheduler.close()
  })
})
