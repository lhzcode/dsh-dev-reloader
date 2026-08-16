import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireSupervisorLock,
  probeLockOwner,
  type LockCriticalSection,
  type SupervisorGuardRecord,
  type SupervisorLockRecord,
} from '../../src/supervisor/lock.js'
import {
  resolveRuntimePaths,
  writePrivateFileAtomic,
  type RuntimePaths,
} from '../../src/supervisor/paths.js'

const temporaryRoots: string[] = []

async function temporaryPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-reloader-lock-'))
  temporaryRoots.push(root)
  return resolveRuntimePaths({ dshHome: root, profile: 'web' })
}

function record(paths: RuntimePaths, overrides: Partial<SupervisorLockRecord> = {}): SupervisorLockRecord {
  return {
    pid: 1234,
    startedAt: 1_700_000_000_000,
    instanceId: 'existing-instance',
    endpoint: paths.endpoint,
    ...overrides,
  }
}

async function writeRecord(paths: RuntimePaths, value: unknown): Promise<void> {
  await writePrivateFileAtomic(paths.lockFile, `${JSON.stringify(value)}\n`, paths.platform)
}

async function readRecord(paths: RuntimePaths): Promise<SupervisorLockRecord> {
  return JSON.parse(await readFile(paths.lockFile, 'utf8')) as SupervisorLockRecord
}

function guardRecord(overrides: Partial<SupervisorGuardRecord> = {}): SupervisorGuardRecord {
  return {
    pid: 2_147_483_647,
    createdAt: 1_700_000_000_000,
    nonce: 'stale-guard',
    ...overrides,
  }
}

async function writeGuard(paths: RuntimePaths, value: SupervisorGuardRecord): Promise<void> {
  await writePrivateFileAtomic(paths.guardFile, `${JSON.stringify(value)}\n`, paths.platform)
}

async function readGuard(paths: RuntimePaths): Promise<SupervisorGuardRecord> {
  return JSON.parse(await readFile(paths.guardFile, 'utf8')) as SupervisorGuardRecord
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('acquireSupervisorLock', () => {
  it('creates and releases a validated private, single-link lease', async () => {
    const paths = await temporaryPaths()
    const lease = await acquireSupervisorLock(paths, async () => 'stale')
    const stored = await readRecord(paths)
    const metadata = await stat(paths.lockFile)

    expect(stored).toEqual(lease.record)
    expect(stored.pid).toBe(process.pid)
    expect(stored.startedAt).toEqual(expect.any(Number))
    expect(stored.instanceId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(stored.endpoint).toBe(paths.endpoint)
    expect(metadata.isFile()).toBe(true)
    expect(metadata.nlink).toBe(1)
    if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o600)
    expect(await readdir(paths.stateDir)).toEqual(['supervisor.lock'])

    await lease.release()
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(paths.stateDir)).toEqual([])
  })

  it('holds the guard while probing and preserves a live owner', async () => {
    const paths = await temporaryPaths()
    const existing = record(paths)
    await writeRecord(paths, existing)

    await expect(acquireSupervisorLock(paths, async value => {
      expect(value).toEqual(existing)
      expect(await readdir(paths.stateDir)).toContain('supervisor.lock.guard')
      return 'live'
    })).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })

    expect(await readRecord(paths)).toEqual(existing)
    expect(await readdir(paths.stateDir)).not.toContain('supervisor.lock.guard')
  })

  it('replaces a lock only after the owner is proven stale inside the guard', async () => {
    const paths = await temporaryPaths()
    const existing = record(paths)
    await writeRecord(paths, existing)

    const lease = await acquireSupervisorLock(paths, async () => 'stale')

    expect(lease.record.instanceId).not.toBe(existing.instanceId)
    expect(await readRecord(paths)).toEqual(lease.record)
    await lease.release()
  })

  it('fails closed and preserves a lock when ownership is unknown', async () => {
    const paths = await temporaryPaths()
    const existing = record(paths)
    await writeRecord(paths, existing)

    await expect(acquireSupervisorLock(paths, async () => 'unknown'))
      .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
    expect(await readRecord(paths)).toEqual(existing)
  })

  it('treats malformed and unsafe lock files as unknown ownership without replacing them', async () => {
    const malformedPaths = await temporaryPaths()
    await writeRecord(malformedPaths, { pid: -1, startedAt: 'yesterday', instanceId: '', endpoint: 42 })
    await expect(acquireSupervisorLock(malformedPaths, async () => 'stale'))
      .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
    expect(await readFile(malformedPaths.lockFile, 'utf8')).toContain('yesterday')

    if (process.platform !== 'win32') {
      const modePaths = await temporaryPaths()
      await writeRecord(modePaths, record(modePaths))
      await chmod(modePaths.lockFile, 0o644)
      await expect(acquireSupervisorLock(modePaths, async () => 'stale'))
        .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
      expect((await stat(modePaths.lockFile)).mode & 0o777).toBe(0o644)

      const hardlinkPaths = await temporaryPaths()
      await writeRecord(hardlinkPaths, record(hardlinkPaths))
      const alias = join(hardlinkPaths.stateDir, 'lock-alias')
      await link(hardlinkPaths.lockFile, alias)
      await expect(acquireSupervisorLock(hardlinkPaths, async () => 'stale'))
        .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
      expect((await stat(hardlinkPaths.lockFile)).nlink).toBe(2)

      const symlinkPaths = await temporaryPaths()
      const target = join(symlinkPaths.stateDir, 'target-lock')
      await writePrivateFileAtomic(target, `${JSON.stringify(record(symlinkPaths))}\n`, symlinkPaths.platform)
      await symlink(target, symlinkPaths.lockFile)
      await expect(acquireSupervisorLock(symlinkPaths, async () => 'stale'))
        .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
      expect(await readFile(target, 'utf8')).toContain('existing-instance')
    }

    const directoryPaths = await temporaryPaths()
    await mkdir(directoryPaths.lockFile)
    await expect(acquireSupervisorLock(directoryPaths, async () => 'stale'))
      .rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_UNKNOWN' })
    expect((await stat(directoryPaths.lockFile)).isDirectory()).toBe(true)
  })

  it('fails closed when another participant holds the guard and never deletes the lock', async () => {
    const paths = await temporaryPaths()
    const existing = record(paths)
    await writeRecord(paths, existing)
    const guard = await open(paths.guardFile, 'wx', 0o600)
    await guard.close()

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      guardAttempts: 2,
      guardRetryMs: 1,
    })).rejects.toMatchObject({ code: 'LOCK_CONTENTION' })

    expect(await readRecord(paths)).toEqual(existing)
  })

  it.each(['creation-stat', 'write', 'chmod', 'sync', 'stat'] as const)(
    'identity-safely cleans its newly created guard when %s fails after open',
    async failedStep => {
      const paths = await temporaryPaths()

      await expect(acquireSupervisorLock(paths, async () => 'stale', {
        guardAttempts: 1,
        hooks: {
          async beforeGuardCreateStep(step, candidate) {
            if (step !== failedStep) return
            if (step === 'write') await writeFile(candidate, '{"partial":')
            throw new Error(`injected guard ${failedStep} failure`)
          },
        },
      })).rejects.toThrow(`injected guard ${failedStep} failure`)

      expect(await readdir(paths.stateDir)).toEqual([])
      const lease = await acquireSupervisorLock(paths, async () => 'stale', { guardAttempts: 1 })
      await lease.release()
    },
  )

  it('does not delete a successor published while a malformed private candidate is cleaned', async () => {
    const paths = await temporaryPaths()
    const successor = guardRecord({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: 'failed-create-successor',
    })

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      guardAttempts: 1,
      hooks: {
        async beforeGuardCreateStep(step, candidate) {
          if (step !== 'write') return
          await writeFile(candidate, '{"partial":')
          await writeGuard(paths, successor)
          throw new Error('injected partial guard write failure')
        },
      },
    })).rejects.toThrow(/partial guard write failure/)

    expect(await readGuard(paths)).toEqual(successor)
    expect(await readdir(paths.stateDir)).toEqual(['supervisor.lock.guard'])
  })

  it('recovers a crashed stale guard and leaves no guard residue', async () => {
    const paths = await temporaryPaths()
    const stale = guardRecord()
    await writeGuard(paths, stale)

    const lease = await acquireSupervisorLock(paths, async () => 'stale', {
      guardProbe: async value => {
        expect(value).toEqual(stale)
        return 'stale'
      },
    })

    expect(await readdir(paths.stateDir)).toEqual(['supervisor.lock'])
    await lease.release()
  })

  it('does not consume the sole guard attempt when a stale guard is reclaimed', async () => {
    const paths = await temporaryPaths()
    const stale = guardRecord({ nonce: 'single-attempt-stale' })
    await writeGuard(paths, stale)

    const lease = await acquireSupervisorLock(paths, async () => 'stale', {
      guardAttempts: 1,
      guardProbe: async value => {
        expect(value).toEqual(stale)
        return 'stale'
      },
    })

    expect(await readRecord(paths)).toEqual(lease.record)
    await lease.release()
  })

  it.skipIf(process.platform === 'win32')('recovers a guard by default only when its pid is ESRCH', async () => {
    const paths = await temporaryPaths()
    await writeGuard(paths, guardRecord())

    const lease = await acquireSupervisorLock(paths, async () => 'stale')

    expect(await readRecord(paths)).toEqual(lease.record)
    await lease.release()
  })

  it('fails with contention when a stale guard snapshot changes during recovery', async () => {
    const paths = await temporaryPaths()
    await writeGuard(paths, guardRecord({ nonce: 'observed-stale' }))
    const successor = guardRecord({ pid: process.pid, createdAt: Date.now(), nonce: 'replacement-guard' })

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      guardAttempts: 1,
      guardProbe: async () => 'stale',
      hooks: {
        async afterGuardStaleProbe() {
          await unlink(paths.guardFile)
          await writeGuard(paths, successor)
        },
      },
    })).rejects.toMatchObject({ code: 'LOCK_CONTENTION' })

    expect(await readGuard(paths)).toEqual(successor)
  })

  it.each(['live', 'unknown'] as const)('fails closed for a %s guard owner', async ownership => {
    const paths = await temporaryPaths()
    const existingGuard = guardRecord({ nonce: `${ownership}-guard` })
    await writeGuard(paths, existingGuard)

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      guardAttempts: 2,
      guardRetryMs: 0,
      guardProbe: async () => ownership,
    })).rejects.toMatchObject({ code: 'LOCK_CONTENTION' })

    expect(await readGuard(paths)).toEqual(existingGuard)
  })

  it('allows only one of two concurrent stale-guard reclaimers to install the lock', async () => {
    const paths = await temporaryPaths()
    await writeGuard(paths, guardRecord())
    const guardProbe = async (value: SupervisorGuardRecord) =>
      value.pid === process.pid ? 'live' as const : 'stale' as const

    const attempts = await Promise.allSettled([
      acquireSupervisorLock(paths, async value => value.pid === process.pid ? 'live' : 'stale', {
        guardAttempts: 100,
        guardRetryMs: 1,
        guardProbe,
      }),
      acquireSupervisorLock(paths, async value => value.pid === process.pid ? 'live' : 'stale', {
        guardAttempts: 100,
        guardRetryMs: 1,
        guardProbe,
      }),
    ])
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSupervisorLock>>> =>
        attempt.status === 'fulfilled',
    )
    const rejected = attempts.filter(attempt => attempt.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(await readRecord(paths)).toEqual(fulfilled[0]!.value.record)
    await fulfilled[0]!.value.release()
  })

  it('does not let an old guard lease remove a successor guard', async () => {
    const paths = await temporaryPaths()
    const successor = guardRecord({ pid: process.pid, createdAt: Date.now(), nonce: 'successor-guard' })

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        async afterGuardAcquired(section) {
          if (section !== 'acquire') return
          await unlink(paths.guardFile)
          await writeGuard(paths, successor)
          throw new Error('injected guard owner failure')
        },
      },
    })).rejects.toThrow(/guard owner failure/)

    expect(await readGuard(paths)).toEqual(successor)
  })

  it('serializes stale takeover so a contender cannot unlink the newly installed lease', async () => {
    const paths = await temporaryPaths()
    await writeRecord(paths, record(paths))
    const firstInside = deferred()
    const continueFirst = deferred()

    const probe = async (value: SupervisorLockRecord) =>
      value.pid === process.pid ? 'live' as const : 'stale' as const
    const first = acquireSupervisorLock(paths, probe, {
      hooks: {
        async afterGuardAcquired(section) {
          if (section !== 'acquire') return
          firstInside.resolve()
          await continueFirst.promise
        },
      },
    })
    await firstInside.promise

    const contender = acquireSupervisorLock(paths, probe, {
      guardAttempts: 100,
      guardRetryMs: 1,
    })
    continueFirst.resolve()

    const lease = await first
    await expect(contender).rejects.toMatchObject({ code: 'LOCK_ALREADY_RUNNING' })
    expect(await readRecord(paths)).toEqual(lease.record)
    await lease.release()
  })

  it('allows only one concurrent acquisition', async () => {
    const paths = await temporaryPaths()
    const attempts = await Promise.allSettled([
      acquireSupervisorLock(paths, async value => value.pid === process.pid ? 'live' : 'stale'),
      acquireSupervisorLock(paths, async value => value.pid === process.pid ? 'live' : 'stale'),
    ])

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSupervisorLock>>> =>
        attempt.status === 'fulfilled',
    )
    const rejected = attempts.filter(attempt => attempt.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      reason: { code: expect.stringMatching(/^LOCK_/) },
    })

    await fulfilled[0]!.value.release()
  })

  it('serializes release with successor acquisition and never removes the successor', async () => {
    const paths = await temporaryPaths()
    const releaseInside = deferred()
    const continueRelease = deferred()
    const lease = await acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        async afterGuardAcquired(section: LockCriticalSection) {
          if (section !== 'release') return
          releaseInside.resolve()
          await continueRelease.promise
        },
      },
    })

    const releasing = lease.release()
    await releaseInside.promise
    const successorPromise = acquireSupervisorLock(
      paths,
      async value => value.pid === process.pid ? 'live' : 'stale',
      { guardAttempts: 100, guardRetryMs: 1 },
    )
    continueRelease.resolve()
    await releasing

    const successor = await successorPromise
    await lease.release()
    expect(await readRecord(paths)).toEqual(successor.record)
    await successor.release()
  })

  it('keeps release retryable after an injected unlink failure', async () => {
    const paths = await temporaryPaths()
    let failures = 1
    const lease = await acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        beforeLockUnlink(reason) {
          if (reason === 'release' && failures-- > 0) throw new Error('injected unlink failure')
        },
      },
    })

    await expect(lease.release()).rejects.toThrow(/injected unlink failure/)
    expect(await readRecord(paths)).toEqual(lease.record)

    await lease.release()
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans a candidate when its atomic write fails after rename during directory fsync', async () => {
    const paths = await temporaryPaths()

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        beforeCandidateDirectorySync() {
          throw new Error('injected post-rename directory fsync failure')
        },
      },
    })).rejects.toThrow(/post-rename directory fsync failure/)

    expect(await readdir(paths.stateDir)).toEqual([])
  })

  it('rolls back a newly linked lock when installation fails after link', async () => {
    const paths = await temporaryPaths()

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        afterInstallLinked() {
          throw new Error('injected post-link failure')
        },
      },
    })).rejects.toThrow(/post-link failure/)

    expect(await readdir(paths.stateDir)).toEqual([])
  })

  it('rolls back safely when candidate cleanup fails', async () => {
    const paths = await temporaryPaths()
    let failures = 1

    await expect(acquireSupervisorLock(paths, async () => 'stale', {
      hooks: {
        beforeCandidateCleanup() {
          if (failures-- > 0) throw new Error('injected candidate cleanup failure')
        },
      },
    })).rejects.toThrow(/candidate cleanup failure/)

    expect(await readdir(paths.stateDir)).toEqual([])
  })
})

describe('probeLockOwner', () => {
  it('only trusts the current pid without authenticated endpoint proof', async () => {
    const paths = await temporaryPaths()

    await expect(probeLockOwner(record(paths, { pid: process.pid }))).resolves.toBe('live')
    if (process.platform !== 'win32') {
      await expect(probeLockOwner(record(paths, { pid: 1 }))).resolves.toBe('unknown')
      await expect(probeLockOwner(record(paths, { pid: 2_147_483_647 }))).resolves.toBe('stale')
    }
  })
})
