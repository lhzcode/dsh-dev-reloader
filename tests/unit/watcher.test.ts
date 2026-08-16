import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectDescriptor } from '../../src/supervisor/discovery.js'
import {
  createWatchPlanController,
  type RawWatchEvent,
  type WatchBackend,
  type WatchBackendSession,
} from '../../src/supervisor/watcher.js'
import { eventually } from '../helpers/eventually.js'
import { createTempLayout, type TempLayout } from '../helpers/temp-layout.js'

const layouts: TempLayout[] = []
const controllers: Array<ReturnType<typeof createWatchPlanController>> = []

async function layout(): Promise<TempLayout> {
  const created = await createTempLayout()
  layouts.push(created)
  return created
}

function controller(options: Parameters<typeof createWatchPlanController>[0]) {
  const created = createWatchPlanController(options)
  controllers.push(created)
  return created
}

function fixtureRoot(name: string): string {
  return join(process.cwd(), 'watcher-test-fixture', name)
}

function descriptor(root: string, workspaceRoot = root): ProjectDescriptor {
  return {
    id: `linked-plugin:fixture:${root}`,
    kind: 'linked-plugin',
    root,
    workspaceRoot,
    packageName: 'fixture-plugin',
    serverEntries: [join(root, 'src', 'index.ts')],
    clientEntries: [join(root, 'src', 'client', 'index.tsx')],
    manifests: [join(root, 'package.json')],
    outputRoots: [join(root, 'lib'), join(root, 'dist'), join(root, 'coverage')],
    build: { executable: 'pnpm', args: ['run', 'build'], cwd: root },
    devWeb: { executable: 'pnpm', args: ['run', 'dev:web'], cwd: root },
  }
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(current => current.close()))
  await Promise.all(layouts.splice(0).map(current => current.cleanup()))
})

describe('real Chokidar watch plans', () => {
  it('emits project and workspace-origin events with normalized relative paths', async () => {
    const current = await layout()
    const workspaceRoot = current.path('workspace')
    const projectRoot = join(workspaceRoot, 'packages', 'fixture')
    await current.mkdir(join(projectRoot, 'src'))
    await current.writeText(join(projectRoot, 'package.json'), '{}\n')
    await current.writeText(join(projectRoot, 'src', 'index.ts'), 'export const value = 0\n')
    await current.writeText(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 8\n')
    const events: Array<{ path: string; origin?: string; kind: string }> = []
    const watch = controller({ onEvent: event => events.push(event) })

    await watch.replace({ projects: [descriptor(projectRoot, workspaceRoot)], ignored: [] })
    await current.writeText(join(projectRoot, 'src', 'index.ts'), 'export const value = 1\n')
    await current.writeText(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    await eventually(() => {
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'change', origin: 'project', path: 'src/index.ts' }),
        expect.objectContaining({ kind: 'change', origin: 'workspace', path: 'pnpm-lock.yaml' }),
      ]))
    }, { timeoutMs: 5_000 })
  })

  it('supports an empty watch plan without waiting for Chokidar ready', async () => {
    const watch = controller({ onEvent: () => undefined })

    await watch.replace({ projects: [], ignored: [] })
    await watch.close()
  })

  it('excludes outputs, dependencies, temp/editor, snapshots, logs, and explicit globs', async () => {
    const current = await layout()
    const projectRoot = current.path('plugin')
    await current.mkdir(projectRoot)
    const events: Array<{ path: string }> = []
    const watch = controller({ onEvent: event => events.push(event) })
    const fixturePaths = [
      join(projectRoot, 'src', 'kept.ts'),
      join(projectRoot, 'lib', 'ignored.js'),
      join(projectRoot, '.git', 'HEAD'),
      join(projectRoot, 'node_modules', 'dep', 'index.js'),
      join(projectRoot, 'src', 'scratch.tmp'),
      join(projectRoot, 'src', 'index.ts~'),
      join(projectRoot, 'src', '.index.ts.swp'),
      join(projectRoot, 'src', '.#index.ts'),
      join(projectRoot, 'src', '__snapshots__', 'index.snap'),
      join(projectRoot, 'logs', 'build.log'),
    ]
    for (const path of fixturePaths) await current.writeText(path, 'initial\n')

    await watch.replace({ projects: [descriptor(projectRoot)], ignored: ['**/*.tmp'] })
    for (const path of fixturePaths) await current.writeText(path, 'changed\n')

    await eventually(
      () => expect(events.some(event => event.path === 'src/kept.ts')).toBe(true),
      { timeoutMs: 5_000 },
    )
    expect(events.map(event => event.path)).toEqual(['src/kept.ts'])
  })
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class FakeSession implements WatchBackendSession {
  closed = 0

  constructor(private closeError?: Error) {}

  async close(): Promise<void> {
    this.closed += 1
    if (this.closeError !== undefined) {
      const error = this.closeError
      this.closeError = undefined
      throw error
    }
  }
}

class BlockingCloseSession implements WatchBackendSession {
  closed = 0
  readonly closeStarted = deferred<void>()
  readonly allowClose = deferred<void>()

  async close(): Promise<void> {
    this.closed += 1
    this.closeStarted.resolve()
    await this.allowClose.promise
  }
}

class ControlledBackend implements WatchBackend {
  readonly starts: Array<{
    readonly roots: readonly string[]
    readonly ready: Deferred<WatchBackendSession>
    emit?: (event: RawWatchEvent) => void
    fail?: (error: Error) => void
    signal?: AbortSignal
  }> = []

  start(
    roots: readonly string[],
    _ignored: (path: string) => boolean,
    onEvent: (event: RawWatchEvent) => void,
    onError?: (error: Error) => void,
    signal?: AbortSignal,
  ): Promise<WatchBackendSession> {
    const record = {
      roots: [...roots],
      ready: deferred<WatchBackendSession>(),
      emit: onEvent,
      ...(onError === undefined ? {} : { fail: onError }),
      ...(signal === undefined ? {} : { signal }),
    }
    this.starts.push(record)
    signal?.addEventListener('abort', () => {
      const error = new Error('controlled watch setup aborted')
      error.name = 'AbortError'
      record.ready.reject(error)
    }, { once: true })
    return record.ready.promise
  }
}

describe('atomic watch plan replacement', () => {
  it('deduplicates Windows-equivalent roots without removing both variants', async () => {
    const backend = new ControlledBackend()
    const watch = controller({ backend, onEvent: () => undefined })
    const session = new FakeSession()
    const replacement = watch.replace({
      projects: [descriptor('C:\\Repo'), descriptor('c:\\repo')],
      ignored: [],
    })
    backend.starts[0]!.ready.resolve(session)
    await replacement

    expect(backend.starts[0]!.roots).toHaveLength(1)
  })

  it('starts and readies a replacement before closing the previous plan', async () => {
    const backend = new ControlledBackend()
    const watch = controller({ backend, onEvent: () => undefined })
    const firstSession = new FakeSession()
    const firstReplace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(firstSession)
    await firstReplace

    const secondSession = new FakeSession()
    const secondReplace = watch.replace({ projects: [descriptor(fixtureRoot('second'))], ignored: [] })
    expect(firstSession.closed).toBe(0)
    backend.starts[1]!.ready.resolve(secondSession)
    await secondReplace

    expect(firstSession.closed).toBe(1)
    expect(secondSession.closed).toBe(0)
  })

  it('buffers candidate-root events until the replacement is promoted', async () => {
    const backend = new ControlledBackend()
    const events: string[] = []
    const watch = controller({ backend, onEvent: event => events.push(event.path) })
    const firstReplace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(new FakeSession())
    await firstReplace

    const replacement = watch.replace({ projects: [descriptor(fixtureRoot('second'))], ignored: [] })
    backend.starts[1]!.emit?.({ kind: 'add', absolutePath: join(fixtureRoot('second'), 'src', 'new.ts') })
    expect(events).toEqual([])
    backend.starts[1]!.ready.resolve(new FakeSession())
    await replacement

    expect(events).toEqual(['src/new.ts'])
  })

  it('promotes healthy roots while returning typed degraded setup accounting', async () => {
    const backend = new ControlledBackend()
    const degraded: Array<{ root: string; phase: string; error: Error }> = []
    const events: string[] = []
    const watch = controller({
      backend,
      onEvent: event => events.push(`${event.project.root}:${event.path}`),
      onDegradedRoot: root => degraded.push(root),
    })
    const replacement = watch.replace({
      projects: [descriptor(fixtureRoot('healthy')), descriptor(fixtureRoot('broken'))],
      ignored: [],
    })
    expect(backend.starts.map(start => start.roots)).toEqual([[fixtureRoot('broken')], [fixtureRoot('healthy')]])
    backend.starts[0]!.emit?.({ kind: 'add', absolutePath: join(fixtureRoot('broken'), 'src', 'stale.ts') })
    backend.starts[1]!.emit?.({ kind: 'add', absolutePath: join(fixtureRoot('healthy'), 'src', 'kept.ts') })
    backend.starts[0]!.ready.reject(new Error('permission denied'))
    backend.starts[1]!.ready.resolve(new FakeSession())

    await expect(replacement).resolves.toMatchObject({
      promoted: true,
      watchedRoots: [fixtureRoot('healthy')],
      degradedRoots: [{
        root: fixtureRoot('broken'),
        phase: 'setup',
        error: expect.objectContaining({ message: 'permission denied' }),
      }],
    })
    expect(degraded).toMatchObject([{ root: fixtureRoot('broken'), phase: 'setup' }])
    expect(watch.inspect()).toMatchObject({
      watchedRoots: [fixtureRoot('healthy')],
      degradedRoots: [{ root: fixtureRoot('broken'), phase: 'setup' }],
    })
    expect(events).toEqual([`${fixtureRoot('healthy')}:src/kept.ts`])
  })

  it('contains observer exceptions without leaking a ready candidate session', async () => {
    const backend = new ControlledBackend()
    const errors: string[] = []
    const watch = controller({
      backend,
      onEvent: () => { throw new Error('event observer failed') },
      onDegradedRoot: () => { throw new Error('degraded observer failed') },
      onError: error => errors.push(error.message),
    })
    const replacement = watch.replace({
      projects: [descriptor(fixtureRoot('broken')), descriptor(fixtureRoot('healthy'))],
      ignored: [],
    })
    const healthySession = new FakeSession()
    backend.starts[0]!.ready.reject(new Error('setup failed'))
    backend.starts[1]!.emit?.({ kind: 'add', absolutePath: join(fixtureRoot('healthy'), 'src', 'index.ts') })
    backend.starts[1]!.ready.resolve(healthySession)

    await expect(replacement).resolves.toMatchObject({
      promoted: true,
      watchedRoots: [fixtureRoot('healthy')],
      degradedRoots: [{ root: fixtureRoot('broken'), phase: 'setup' }],
    })
    expect(errors).toEqual(['degraded observer failed', 'event observer failed'])
    await watch.close()
    expect(healthySession.closed).toBe(1)
  })

  it('records a candidate runtime failure before promotion and never promotes its dead root', async () => {
    const backend = new ControlledBackend()
    const watch = controller({ backend, onEvent: () => undefined })
    const first = watch.replace({ projects: [descriptor(fixtureRoot('old'))], ignored: [] })
    backend.starts[0]!.ready.resolve(new FakeSession())
    await first

    const queued = watch.replace({ projects: [descriptor(fixtureRoot('queued'))], ignored: [] })
    const candidateSession = new FakeSession()
    const candidate = watch.replace({ projects: [descriptor(fixtureRoot('candidate'))], ignored: [] })
    backend.starts[2]!.ready.resolve(candidateSession)
    await Promise.resolve()
    backend.starts[2]!.fail?.(new Error('candidate died before promotion'))
    backend.starts[1]!.ready.resolve(new FakeSession())

    await queued
    await expect(candidate).resolves.toMatchObject({
      promoted: false,
      watchedRoots: [],
      degradedRoots: [{ root: fixtureRoot('candidate'), phase: 'runtime' }],
    })
    await eventually(() => expect(candidateSession.closed).toBe(1))
    expect(watch.inspect().watchedRoots).toEqual([fixtureRoot('queued')])
  })

  it('fails closed when the sole candidate session dies while the old plan is closing', async () => {
    const backend = new ControlledBackend()
    const watch = controller({ backend, onEvent: () => undefined })
    const oldSession = new BlockingCloseSession()
    const first = watch.replace({ projects: [descriptor(fixtureRoot('old'))], ignored: [] })
    backend.starts[0]!.ready.resolve(oldSession)
    await first

    const candidateSession = new FakeSession()
    const replacement = watch.replace({ projects: [descriptor(fixtureRoot('candidate'))], ignored: [] })
    backend.starts[1]!.ready.resolve(candidateSession)
    await oldSession.closeStarted.promise

    backend.starts[1]!.fail?.(new Error('candidate died during old close'))
    await eventually(() => expect(candidateSession.closed).toBe(1))
    oldSession.allowClose.resolve()

    await expect(replacement).resolves.toMatchObject({
      promoted: false,
      watchedRoots: [],
      degradedRoots: [{ root: fixtureRoot('candidate'), phase: 'runtime' }],
    })
    expect(oldSession.closed).toBe(1)
    expect(watch.inspect()).toMatchObject({ promoted: false, watchedRoots: [] })
  })

  it('times out one never-ready root and promotes healthy roots without queue deadlock', async () => {
    const backend = new ControlledBackend()
    const watch = controller({
      backend,
      setupTimeoutMs: 25,
      onEvent: () => undefined,
    })
    const replacement = watch.replace({
      projects: [descriptor(fixtureRoot('healthy')), descriptor(fixtureRoot('stuck'))],
      ignored: [],
    })
    backend.starts[0]!.ready.resolve(new FakeSession())

    await expect(replacement).resolves.toMatchObject({
      promoted: true,
      watchedRoots: [fixtureRoot('healthy')],
      degradedRoots: [{
        root: fixtureRoot('stuck'),
        phase: 'setup',
        error: expect.objectContaining({ name: 'WatchSetupTimeoutError' }),
      }],
    })
    expect(backend.starts[1]!.signal?.aborted).toBe(true)
  })

  it('preserves the old plan when every replacement root fails', async () => {
    const backend = new ControlledBackend()
    const events: string[] = []
    const watch = controller({ backend, onEvent: event => events.push(event.path) })
    const firstSession = new FakeSession()
    const firstReplace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(firstSession)
    await firstReplace

    const replacement = watch.replace({
      projects: [descriptor(fixtureRoot('second')), descriptor(fixtureRoot('third'))],
      ignored: [],
    })
    backend.starts[1]!.ready.reject(new Error('second failed'))
    backend.starts[2]!.ready.reject(new Error('third failed'))

    await expect(replacement).resolves.toMatchObject({
      promoted: false,
      watchedRoots: [],
      degradedRoots: [
        { root: fixtureRoot('second'), phase: 'setup' },
        { root: fixtureRoot('third'), phase: 'setup' },
      ],
    })
    backend.starts[0]!.emit?.({ kind: 'change', absolutePath: join(fixtureRoot('first'), 'src', 'index.ts') })
    expect(firstSession.closed).toBe(0)
    expect(events).toEqual(['src/index.ts'])
    expect(watch.inspect().watchedRoots).toEqual([fixtureRoot('first')])
  })

  it('retains the previous plan when replacement setup fails', async () => {
    const backend = new ControlledBackend()
    const events: string[] = []
    const watch = controller({ backend, onEvent: event => events.push(event.path) })
    const firstSession = new FakeSession()
    const firstReplace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(firstSession)
    await firstReplace

    const failedReplace = watch.replace({ projects: [descriptor(fixtureRoot('second'))], ignored: [] })
    backend.starts[1]!.ready.reject(new Error('watch setup failed'))
    await expect(failedReplace).resolves.toMatchObject({
      promoted: false,
      degradedRoots: [{ root: fixtureRoot('second'), phase: 'setup' }],
    })
    backend.starts[0]!.emit?.({ kind: 'change', absolutePath: join(fixtureRoot('first'), 'src', 'index.ts') })

    expect(firstSession.closed).toBe(0)
    expect(events).toEqual(['src/index.ts'])
  })

  it('fails closed instead of retaining a partially closed old plan', async () => {
    const backend = new ControlledBackend()
    const events: string[] = []
    const watch = controller({ backend, onEvent: event => events.push(event.path) })
    const failingSession = new FakeSession(new Error('old close failed'))
    const closedSession = new FakeSession()
    const firstReplace = watch.replace({
      projects: [descriptor(fixtureRoot('first')), descriptor(fixtureRoot('second'))],
      ignored: [],
    })
    backend.starts[0]!.ready.resolve(failingSession)
    backend.starts[1]!.ready.resolve(closedSession)
    await firstReplace

    const candidateSession = new FakeSession()
    const replacement = watch.replace({ projects: [descriptor(fixtureRoot('third'))], ignored: [] })
    backend.starts[2]!.ready.resolve(candidateSession)
    await expect(replacement).rejects.toThrow(/old close failed/)
    backend.starts[0]!.emit?.({ kind: 'change', absolutePath: join(fixtureRoot('first'), 'src', 'index.ts') })

    expect(failingSession.closed).toBe(1)
    expect(closedSession.closed).toBe(1)
    expect(candidateSession.closed).toBe(1)
    expect(events).toEqual([])
    expect(watch.inspect()).toMatchObject({ promoted: false, watchedRoots: [] })
  })

  it('forwards runtime watcher errors only while the plan is active', async () => {
    const backend = new ControlledBackend()
    const errors: string[] = []
    const watch = controller({
      backend,
      onEvent: () => undefined,
      onError: error => errors.push(error.message),
    })
    const session = new FakeSession()
    const replace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(session)
    await replace

    backend.starts[0]!.fail?.(new Error('watcher failed'))
    await watch.close()
    backend.starts[0]!.fail?.(new Error('late failure'))

    expect(errors).toEqual(['watcher failed'])
  })

  it('isolates runtime failure to its root and updates typed degraded accounting', async () => {
    const backend = new ControlledBackend()
    const degraded: Array<{ root: string; phase: string; error: Error }> = []
    const events: string[] = []
    const watch = controller({
      backend,
      onEvent: event => events.push(`${event.project.root}:${event.path}`),
      onDegradedRoot: root => degraded.push(root),
    })
    const replacement = watch.replace({
      projects: [descriptor(fixtureRoot('first')), descriptor(fixtureRoot('second'))],
      ignored: [],
    })
    const firstSession = new FakeSession()
    const secondSession = new FakeSession()
    backend.starts[0]!.ready.resolve(firstSession)
    backend.starts[1]!.ready.resolve(secondSession)
    await replacement

    backend.starts[0]!.fail?.(new Error('root watcher crashed'))
    backend.starts[1]!.emit?.({ kind: 'change', absolutePath: join(fixtureRoot('second'), 'src', 'index.ts') })

    expect(degraded).toMatchObject([{
      root: fixtureRoot('first'),
      phase: 'runtime',
      error: { message: 'root watcher crashed' },
    }])
    expect(watch.inspect()).toMatchObject({
      watchedRoots: [fixtureRoot('second')],
      degradedRoots: [{ root: fixtureRoot('first'), phase: 'runtime' }],
    })
    await eventually(() => expect(firstSession.closed).toBe(1))
    expect(events).toEqual([`${fixtureRoot('second')}:src/index.ts`])
    await watch.close()
    expect(firstSession.closed).toBe(1)
    expect(secondSession.closed).toBe(1)
  })

  it('close is idempotent and suppresses late backend events', async () => {
    const backend = new ControlledBackend()
    const events: string[] = []
    const watch = controller({ backend, onEvent: event => events.push(event.path) })
    const session = new FakeSession()
    const replace = watch.replace({ projects: [descriptor(fixtureRoot('first'))], ignored: [] })
    backend.starts[0]!.ready.resolve(session)
    await replace

    await Promise.all([watch.close(), watch.close()])
    backend.starts[0]!.emit?.({ kind: 'change', absolutePath: join(fixtureRoot('first'), 'src', 'index.ts') })

    expect(session.closed).toBe(1)
    expect(events).toEqual([])
  })

  it('closes a late replacement session even when its backend ignores abort', async () => {
    const ready = deferred<WatchBackendSession>()
    const backend: WatchBackend = {
      start() {
        return ready.promise
      },
    }
    const watch = controller({ backend, onEvent: () => undefined })
    const session = new FakeSession()
    const replacement = watch.replace({ projects: [descriptor(fixtureRoot('pending'))], ignored: [] })
    const closing = watch.close()

    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' })
    ready.resolve(session)
    await eventually(() => expect(session.closed).toBe(1))
    await closing
  })

  it('aborts a backend that never reaches ready during shutdown', async () => {
    let aborted = false
    const backend: WatchBackend = {
      start(_roots, _ignored, _onEvent, _onError, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    }
    const watch = controller({ backend, onEvent: () => undefined })
    const replacement = watch.replace({ projects: [descriptor(fixtureRoot('pending'))], ignored: [] })
    const closing = watch.close()

    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' })
    await closing
    expect(aborted).toBe(true)
  })
})
