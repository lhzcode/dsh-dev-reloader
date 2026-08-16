import { describe, expect, it } from 'vitest'

import { startIntegrationHarness } from '../helpers/integration-harness.js'

function snapshot(runningAgents: number, sequence: number): import('../../src/shared/protocol.js').ActivitySnapshot {
  return { sequence, capturedAt: Date.now(), runningAgents, runningJobs: 0, stoppingJobs: 0 }
}
const busy = snapshot(1, 1)
const idle = snapshot(0, 2)

async function triggerFullRestart(h: ReturnType<typeof startIntegrationHarness> extends Promise<infer T> ? T : never): Promise<void> {
  // A manifest change is classified full-restart; the supervisor runs a build
  // then asks for a (gated) restart.
  await h.changePluginSource('cordis.patch.yml', '- insert:\n    - id: gate-extra\n')
}

describe('restart gate (real supervisor)', () => {
  it('holds a manifest full-restart pending while bridge activity is unknown', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')
      // No activity sent: the gate is bridge-unknown, so the restart stays pending.
      await triggerFullRestart(h)
      await h.waitForStatus(s => s.phase === 'pending-restart')
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(h.status().phase).toBe('pending-restart')
      expect(h.fakeHost.child.exitCode).toBeNull()
    } finally {
      await h.close()
    }
  })

  it('holds a manifest full-restart pending while an agent runs, then releases it when idle', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')
      await h.emitActivity(busy)

      await triggerFullRestart(h)
      await h.waitForStatus(s => s.phase === 'pending-restart')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(h.status().phase).toBe('pending-restart')
      expect(h.fakeHost.child.exitCode).toBeNull()

      // Idle activity opens the gate: the pending restart leaves pending and
      // begins restarting (full recovery to a new host is covered separately).
      await h.emitActivity(idle)
      await h.waitForStatus(s => s.phase === 'restarting')
    } finally {
      await h.close()
    }
  })

  it('a forced restart command bypasses a closed gate', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')
      await h.emitActivity(busy)

      // A forced restart must not pause at pending-restart; it goes straight to
      // restarting even though the gate is closed.
      const forced = h.fireRestart(true)
      await h.waitForStatus(s => s.phase === 'restarting')
      // It never sat in the gated pending state.
      expect(h.status().phase).toBe('restarting')
      forced.catch(() => undefined)
    } finally {
      await h.close()
    }
  })
})
