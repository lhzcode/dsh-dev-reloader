import type { ChangePlan } from '../../src/supervisor/classifier.js'
import type { BuildCycleResult } from '../../src/supervisor/scheduler.js'

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

export class FakeBuilder {
  readonly plans: ChangePlan[] = []
  private readonly outcomes: Array<BuildCycleResult | Deferred<BuildCycleResult>> = []

  succeed(): void {
    this.outcomes.push({ kind: 'success' })
  }

  fail(error = 'fixture build failed'): void {
    this.outcomes.push({ kind: 'build-failed', error })
  }

  block(): { succeed(): void; fail(error?: string): void } {
    const pending = deferred<BuildCycleResult>()
    this.outcomes.push(pending)
    return {
      succeed: () => pending.resolve({ kind: 'success' }),
      fail: (error = 'fixture build failed') => pending.resolve({ kind: 'build-failed', error }),
    }
  }

  readonly run = async (plan: ChangePlan): Promise<BuildCycleResult> => {
    this.plans.push(plan)
    const outcome = this.outcomes.shift() ?? { kind: 'success' as const }
    return 'promise' in outcome ? outcome.promise : outcome
  }
}
