import { setTimeout as delay } from 'node:timers/promises'

export interface EventuallyOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

/** Retry an assertion until it succeeds or the deadline expires. */
export async function eventually(
  assertion: () => void | Promise<void>,
  options: EventuallyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const intervalMs = options.intervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  do {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  } while (Date.now() < deadline)

  throw lastError
}
