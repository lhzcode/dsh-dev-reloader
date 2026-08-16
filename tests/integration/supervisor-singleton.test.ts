import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js'
import { acquireSupervisorLock } from '../../src/supervisor/lock.js'
import { resolveRuntimePaths } from '../../src/supervisor/paths.js'
import { startIntegrationHarness, spawnSecondSupervisor } from '../helpers/integration-harness.js'

describe('supervisor singleton', () => {
  it('holds exactly one supervisor lock for one profile until released', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dev-reloader-singleton-lock-'))
    await resolveRuntimePaths({ dshHome: home, profile: 'web' })
    const paths = await resolveRuntimePaths({ dshHome: home, profile: 'web' })

    const first = await acquireSupervisorLock(paths)
    await expect(acquireSupervisorLock(paths)).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })
    await first.release()

    // After the lease is released the same profile is acquirable again.
    const second = await acquireSupervisorLock(paths)
    await second.release()
  })

  it('serves one supervisor for one profile and reuses it on a duplicate bridge', async () => {
    const h = await startIntegrationHarness()

    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // A second bridge with the same launch identity authenticates against the
      // same serve loop; no further supervisor process is spawned.
      const second = await h.connectDuplicateBridge()
      try {
        const result = await second.request({
          protocolVersion: PROTOCOL_VERSION,
          type: 'get-status',
          requestId: 'dup-status',
        })
        expect(result.ok).toBe(true)
      } finally {
        await second.close()
      }

      // The original bridge is still served by the same supervisor.
      const again = await h.bridge.request({
        protocolVersion: PROTOCOL_VERSION,
        type: 'get-status',
        requestId: 'again-status',
      })
      expect(again.ok).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('makes a second supervisor process for the same profile fail and close', async () => {
    const h = await startIntegrationHarness()
    const pid = h.supervisor.pid
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // A second supervisor CLI against the same DSH home/profile cannot acquire
      // the lock: it must print a failure and exit nonzero.
      const second = await spawnSecondSupervisor(h.dshHome, h.profile)
      expect(second.code).not.toBe(0)
      expect(second.signal).toBeNull()
      expect(second.stderr).toMatch(/already running|already_running|LOCK_ALREADY_RUNNING|supervisor/i)

      // The first supervisor remains healthy throughout.
      expect(h.supervisor.pid).toBe(pid)
      const result = await h.bridge.request({
        protocolVersion: PROTOCOL_VERSION,
        type: 'get-status',
        requestId: 'still-alive',
      })
      expect(result.ok).toBe(true)
    } finally {
      await h.close()
    }
  })
})
