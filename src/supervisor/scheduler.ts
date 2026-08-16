import {
  classifyChange,
  mergeActions,
  type ChangeEvent,
  type ChangePlan,
} from './classifier.js'
import { redactSensitiveText } from './runner.js'

export type BuildCycleResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'build-failed'; readonly error: string }

export interface ChangeSchedulerOptions {
  readonly debounceMs: number
  readonly runBuilds: (
    plan: ChangePlan,
    signal: AbortSignal,
  ) => Promise<BuildCycleResult>
  readonly onReady: (plan: ChangePlan) => void | Promise<void>
}

export interface ChangeScheduler {
  enqueue(event: ChangeEvent): void
  waitForIdle(): Promise<BuildCycleResult>
  close(): Promise<void>
}

function eventKey(event: ChangeEvent): string {
  return `${event.project.id}\u0000${event.origin ?? 'project'}\u0000${event.path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createChangeScheduler(options: ChangeSchedulerOptions): ChangeScheduler {
  const pending = new Map<string, ChangeEvent>()
  const idleWaiters: Array<(result: BuildCycleResult) => void> = []

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let activeCycle: Promise<void> | undefined
  let activeAbortController: AbortController | undefined
  let lastResult: BuildCycleResult = { kind: 'success' }
  let closed = false
  let closePromise: Promise<void> | undefined

  function isIdle(): boolean {
    return debounceTimer === undefined && activeCycle === undefined && pending.size === 0
  }

  function resolveIdleWaiters(): void {
    if (!isIdle()) return
    for (const resolve of idleWaiters.splice(0)) resolve(lastResult)
  }

  async function executeCycle(
    events: readonly ChangeEvent[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const plan = mergeActions(events.flatMap(event => classifyChange(event)))
      if (plan.actions.length === 0) {
        lastResult = { kind: 'success' }
        return
      }

      const result = await options.runBuilds(plan, signal)
      lastResult = result.kind === 'build-failed'
        ? { kind: 'build-failed', error: redactSensitiveText(result.error) }
        : result
      if (lastResult.kind === 'success' && !closed) await options.onReady(plan)
    } catch (error) {
      lastResult = {
        kind: 'build-failed',
        error: redactSensitiveText(errorMessage(error)),
      }
    }
  }

  function startCycle(): void {
    if (closed || activeCycle !== undefined || pending.size === 0) {
      resolveIdleWaiters()
      return
    }

    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }

    const events = [...pending.values()]
    pending.clear()
    const abortController = new AbortController()
    activeAbortController = abortController
    const cycle = executeCycle(events, abortController.signal)
    activeCycle = cycle

    const settleCycle = (unexpectedError?: unknown): void => {
      if (unexpectedError !== undefined) {
        lastResult = {
          kind: 'build-failed',
          error: redactSensitiveText(errorMessage(unexpectedError)),
        }
      }
      if (activeCycle === cycle) {
        activeCycle = undefined
        activeAbortController = undefined
      }

      if (closed) {
        pending.clear()
        resolveIdleWaiters()
        return
      }

      // Events received during the active cycle form one immediate dirty follow-up.
      if (pending.size > 0) startCycle()
      else resolveIdleWaiters()
    }
    void cycle.then(
      () => settleCycle(),
      error => settleCycle(error),
    )
  }

  function enqueue(event: ChangeEvent): void {
    if (closed) return

    pending.set(eventKey(event), event)
    if (activeCycle !== undefined) return

    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      startCycle()
    }, options.debounceMs)
  }

  function waitForIdle(): Promise<BuildCycleResult> {
    if (isIdle()) return Promise.resolve(lastResult)
    return new Promise(resolve => idleWaiters.push(resolve))
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise

    closed = true
    activeAbortController?.abort()
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    pending.clear()
    resolveIdleWaiters()

    closePromise = (async () => {
      if (activeCycle !== undefined) await activeCycle
      resolveIdleWaiters()
    })()
    return closePromise
  }

  return { enqueue, waitForIdle, close }
}
