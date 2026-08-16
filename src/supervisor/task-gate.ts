import type { ActivitySnapshot } from '../shared/protocol.js'

export type GateClosedReason =
  | 'bridge-unknown'
  | 'agents-running'
  | 'jobs-running'
  | 'jobs-stopping'
  | 'local-tasks'

export type GateDecision =
  | { readonly open: true }
  | { readonly open: false; readonly reason: GateClosedReason }

export interface TaskGate {
  inspect(): GateDecision
  updateActivity(snapshot: ActivitySnapshot): boolean
  bridgeDisconnected(): void
  bridgeReplaced(): void
  beginLocalTask(label: string): () => void
  waitUntilOpen(signal?: AbortSignal): Promise<void>
}

type Waiter =
  | { readonly resolve: () => void }
  | {
      readonly resolve: () => void
      readonly signal: AbortSignal
      readonly onAbort: () => void
    }

function abortError(): Error {
  const error = new Error('Task gate wait aborted')
  error.name = 'AbortError'
  return error
}

function readValidActivitySnapshot(value: unknown): ActivitySnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  try {
    const candidate = value as Record<keyof ActivitySnapshot, unknown>
    const sequence = candidate.sequence
    const capturedAt = candidate.capturedAt
    const runningAgents = candidate.runningAgents
    const runningJobs = candidate.runningJobs
    const stoppingJobs = candidate.stoppingJobs
    const values = [
      sequence,
      capturedAt,
      runningAgents,
      runningJobs,
      stoppingJobs,
    ]
    if (!values.every(item => Number.isSafeInteger(item) && (item as number) >= 0)) {
      return undefined
    }

    return {
      sequence: sequence as number,
      capturedAt: capturedAt as number,
      runningAgents: runningAgents as number,
      runningJobs: runningJobs as number,
      stoppingJobs: stoppingJobs as number,
    }
  } catch {
    return undefined
  }
}

export function createTaskGate(): TaskGate {
  const localTasks = new Set<symbol>()
  const waiters = new Set<Waiter>()

  let bridgeKnown = false
  let latestSequence = -1
  let snapshot: ActivitySnapshot | undefined

  function inspect(): GateDecision {
    if (!bridgeKnown || snapshot === undefined) {
      return { open: false, reason: 'bridge-unknown' }
    }
    if (snapshot.runningAgents > 0) {
      return { open: false, reason: 'agents-running' }
    }
    if (snapshot.runningJobs > 0) {
      return { open: false, reason: 'jobs-running' }
    }
    if (snapshot.stoppingJobs > 0) {
      return { open: false, reason: 'jobs-stopping' }
    }
    if (localTasks.size > 0) {
      return { open: false, reason: 'local-tasks' }
    }
    return { open: true }
  }

  function removeWaiter(waiter: Waiter): void {
    if (!waiters.delete(waiter)) return
    if ('signal' in waiter) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  function resolveWaitersIfOpen(): void {
    if (!inspect().open) return
    for (const waiter of [...waiters]) {
      removeWaiter(waiter)
      waiter.resolve()
    }
  }

  function updateActivity(next: ActivitySnapshot): boolean {
    const validated = readValidActivitySnapshot(next)
    if (validated === undefined) {
      bridgeKnown = false
      return false
    }
    if (validated.sequence <= latestSequence) return false

    latestSequence = validated.sequence
    snapshot = validated
    bridgeKnown = true
    resolveWaitersIfOpen()
    return true
  }

  function bridgeDisconnected(): void {
    bridgeKnown = false
  }

  function bridgeReplaced(): void {
    latestSequence = -1
    snapshot = undefined
    bridgeKnown = false
  }

  function beginLocalTask(_label: string): () => void {
    const token = Symbol()
    localTasks.add(token)
    let finished = false

    return () => {
      if (finished) return
      finished = true
      localTasks.delete(token)
      resolveWaitersIfOpen()
    }
  }

  function waitUntilOpen(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError())
    if (inspect().open) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      if (signal === undefined) {
        waiters.add({ resolve })
        return
      }

      let waiter: Waiter
      const onAbort = () => {
        removeWaiter(waiter)
        reject(abortError())
      }
      waiter = { resolve, signal, onAbort }
      waiters.add(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    inspect,
    updateActivity,
    bridgeDisconnected,
    bridgeReplaced,
    beginLocalTask,
    waitUntilOpen,
  }
}
