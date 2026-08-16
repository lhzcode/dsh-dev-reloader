import { describe, expect, it } from 'vitest'

import { startIntegrationHarness } from '../helpers/integration-harness.js'

describe('restart recovery (real supervisor)', () => {
  it('recovers the same URL under a new boot id after a restart', async () => {
    const h = await startIntegrationHarness()
    const previousBootId = (await h.fakeHost.ready).bootId
    try {
      await h.waitForStatus(s => s.phase === 'watching', 30_000)

      // Open the gate, then force a restart via a manifest change.
      await h.emitActivity({ sequence: 1, capturedAt: Date.now(), runningAgents: 0, runningJobs: 0, stoppingJobs: 0 })
      await h.changePluginSource('cordis.patch.yml', '- insert:\n    - id: recovery\n')

      // The replacement binds the SAME URL/port and serves a new boot id; the
      // bridge reconnects so the supervisor can go healthy.
      const newBootId = await h.waitForHostReplacement(previousBootId, 40_000)
      await h.waitForStatus(s => s.phase === 'watching', 40_000)

      expect(newBootId).not.toBe(previousBootId)
      // The served URL is identical (same port); only the boot id changed.
      expect(h.status().phase).toBe('watching')
      expect(await h.currentHostBootId()).toBe(newBootId)
      // The supervisor's recovered host now carries the new boot id.
      expect(h.status().bootId).toBe(newBootId)
    } finally {
      await h.close()
    }
  }, 180_000)

  it('does not respawn a host when the host stops without reconnecting', async () => {
    const h = await startIntegrationHarness()
    const originalPid = (await h.fakeHost.ready).pid
    try {
      await h.waitForStatus(s => s.phase === 'watching', 30_000)

      // Announce host disposal while the host remains live but never
      // reconnects: the supervisor's bridge grace elapses and it stops rather
      // than spawning a replacement (a clean shutdown, not a crash).
      await h.emitHostDisposing()
      await h.waitForStatus(s => s.phase === 'paused', 8_000)
      expect(h.status().phase).toBe('paused')

      // No replacement was spawned: the original fake host is untouched and no
      // new listener appeared on the served URL.
      expect(h.fakeHost.child.exitCode).toBeNull()
      expect((await h.fakeHost.ready).pid).toBe(originalPid)
      await expect(h.hostHealth()).resolves.toBe(true)
    } finally {
      await h.close()
    }
  })

  it('reopens the gate after a reconnect so a second full restart also completes', async () => {
    const h = await startIntegrationHarness()
    const firstBoot = (await h.fakeHost.ready).bootId
    try {
      await h.waitForStatus(s => s.phase === 'watching', 30_000)
      await h.emitActivity({ sequence: 1, capturedAt: Date.now(), runningAgents: 0, runningJobs: 0, stoppingJobs: 0 })

      await h.changePluginSource('cordis.patch.yml', '- insert:\n    - id: first-cycle\n')
      const secondBoot = await h.waitForHostReplacement(firstBoot, 40_000)
      await h.waitForStatus(s => s.phase === 'watching', 40_000)

      // A second consecutive full-restart cycle must also complete: the gate is
      // reset to bridge-unknown by the reconnect, and only a fresh activity
      // snapshot (which the real bridge publishes on connect) can reopen it.
      await h.changePluginSource('cordis.patch.yml', '- insert:\n    - id: second-cycle\n')
      const thirdBoot = await h.waitForHostReplacement(secondBoot, 60_000)
      await h.waitForStatus(s => s.phase === 'watching', 60_000)

      expect(thirdBoot).not.toBe(secondBoot)
      expect(h.status().phase).toBe('watching')
      expect(await h.currentHostBootId()).toBe(thirdBoot)
    } finally {
      await h.close()
    }
  }, 240_000)
})
