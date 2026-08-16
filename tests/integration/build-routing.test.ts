import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { startIntegrationHarness, type IntegrationHarness } from '../helpers/integration-harness.js'

afterAll(async () => {
  // Integration teardown is enforced by each close(); leaks are verified at the
  // end of the full suite. No per-file process scan (would false-positive across
  // vitest workers).
})

describe('build routing (real supervisor subprocess + real watcher)', () => {
  it('routes a server source change through build and an explicit HMR acknowledgement', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Change a server entry -> classify server-hmr -> build runs -> hmr-wait.
      await h.changePluginSource('src/index.ts', 'export const x = 21\n')
      await h.waitForStatus(s => s.phase === 'hmr-wait')

      // The real fixture build produced its marker under the ignored glob.
      const built = await readFile(join(h.pluginRoot(), 'generated', 'build.generated'), 'utf8')
      expect(built).toBe('ok')

      // No acknowledgement yet leaves the supervisor waiting for a reload.
      await h.emitHmrReload(['unrelated.ts'])
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(h.status().phase).toBe('hmr-wait')

      // The matching acknowledgement completes the route back to watching.
      await h.emitHmrReload(['src/index.ts'])
      await h.waitForStatus(s => s.phase === 'watching')
    } finally {
      await h.close()
    }
  })

  it('ensures a persistent client watcher process with the dev:web command', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Change a client entry -> client-hmr -> ensurePersistent(dev:web) runs.
      await h.changePluginSource('src/client/index.tsx', 'export const y = 3\n')
      await h.waitForStatus(s => s.phase === 'watching')

      // The dev:web child writes its PID shortly after spawning.
      let ready = ''
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        try {
          ready = await readFile(join(h.pluginRoot(), 'generated', 'dev-web.ready'), 'utf8')
          break
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      const watcherPid = Number(ready)
      expect(Number.isInteger(watcherPid) && watcherPid > 1).toBe(true)
      expect(pidIsRunning(watcherPid)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('routes a manifest change to a full host restart on a new boot id', async () => {
    const h = await startIntegrationHarness()
    const previousBootId = (await h.fakeHost.ready).bootId
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Open the restart gate (idle agent/job snapshot).
      await h.emitActivity({ sequence: 1, capturedAt: Date.now(), runningAgents: 0, runningJobs: 0, stoppingJobs: 0 })

      // A manifest change is classified full-restart -> a real restart occurs.
      await h.changePluginSource('cordis.patch.yml', '- insert:\n    - id: extra\n')
      const newBootId = await h.waitForHostReplacement(previousBootId)
      await h.waitForStatus(s => s.phase === 'watching')

      expect(newBootId).not.toBe(previousBootId)
      // The original fake host was terminated by the lifecycle restart.
      expect(h.fakeHost.child.exitCode !== null).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('produces no build cycle for changes under an ignored glob', async () => {
    const h = await startIntegrationHarness()
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Write under the configured ignored glob 'generated/**'.
      await h.changePluginSource('generated/ignored-output.txt', 'ignored\n')

      // Allow a full debounce + build window; the supervisor must stay watching.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(h.status().phase).toBe('watching')

      // No build ran (no marker), so no work was scheduled from this output.
      await expect(access(join(h.pluginRoot(), 'generated', 'build.generated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await h.close()
    }
  })

  it('leaves the host running and degrades when the build fails', async () => {
    const h = await startIntegrationHarness()
    const previousBootId = (await h.fakeHost.ready).bootId
    try {
      await h.waitForStatus(s => s.phase === 'watching')

      // Force the next build to fail, then change a server entry.
      await h.setBuildMode('fail')
      await h.changePluginSource('src/index.ts', 'export const x = 99\n')
      await h.waitForStatus(s => s.phase === 'degraded')
      expect(h.status().error).toMatch(/integration build failed/)

      // The host was NOT restarted: the served boot id is unchanged and the
      // original fake host process is still alive.
      expect(h.fakeHost.child.exitCode).toBeNull()
      expect(await currentHealthBootId(h)).toBe(previousBootId)
    } finally {
      await h.close()
    }
  })
})

async function currentHealthBootId(h: IntegrationHarness): Promise<string> {
  return h.currentHostBootId()
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
