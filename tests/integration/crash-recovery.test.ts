import { describe, expect, it } from 'vitest'

import { startIntegrationHarness } from '../helpers/integration-harness.js'

describe('crash recovery (real supervisor)', () => {
  it('runs crash recovery and spawns a replacement on the same URL with a new boot id', async () => {
    const h = await startIntegrationHarness()
    const originalBootId = (await h.fakeHost.ready).bootId
    const url = h.webUrl
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Kill the original host. The supervisor's crash-recovery path spawns a
      // replacement on the released port (backoff + port release + spawn). The
      // replacement serves the SAME URL with a new boot id — proving the path
      // executed even though the supervisor's own health gate can race.
      await h.killHost()
      const newBootId = await h.waitForHostReplacement(originalBootId, 15_000)

      expect(newBootId).not.toBe(originalBootId)
      expect(h.webUrl).toBe(url)
      await expect(h.currentHostBootId()).resolves.toBe(newBootId)
    } finally {
      await h.close()
    }
  })

  it('keeps crash recovery bounded when replacements keep crashing', async () => {
    // Replacements exit immediately after binding, so recovery can never reach a
    // healthy state. The supervisor must reach a terminal degraded state within
    // a bounded time rather than respawn forever.
    const h = await startIntegrationHarness({
      crashImmediate: true,
      config: { healthTimeoutMs: 2_000, crashWindowMs: 4_000, maxCrashRestarts: 2 },
    })
    try {
      await h.waitForStatus(s => s.phase === 'watching')
      await h.killHost()

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const phase = h.status().phase
        if (phase === 'degraded' || phase === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      // Bounded: recovery was attempted and the supervisor settled into a
      // terminal state (degraded/failed); it did not respawn indefinitely by
      // staying in an active recovering/restarting state.
      const terminal = h.status().phase
      expect(['degraded', 'failed']).toContain(terminal)
      expect(['restarting', 'recovering']).not.toContain(terminal)
    } finally {
      await h.close()
    }
  })
})
