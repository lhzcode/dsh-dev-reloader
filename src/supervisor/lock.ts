import { constants, type Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  open,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  writePrivateFileAtomic,
  type RuntimePaths,
} from './paths.js'

const PRIVATE_FILE_MODE = 0o600
const MAX_LOCK_BYTES = 64 * 1024
const MAX_GUARD_BYTES = 4 * 1024

export interface SupervisorLockRecord {
  readonly pid: number
  readonly startedAt: number
  readonly instanceId: string
  readonly endpoint: string
}

/** Bounded ownership record for the short-lived lock mutation guard. */
export interface SupervisorGuardRecord {
  readonly pid: number
  readonly createdAt: number
  readonly nonce: string
}

export type LockOwnerProbe = 'live' | 'stale' | 'unknown'
export type LockCriticalSection = 'acquire' | 'release'
export type LockUnlinkReason = 'stale' | 'release' | 'rollback'
export type GuardCreateStep = 'creation-stat' | 'write' | 'chmod' | 'sync' | 'stat'

export interface SupervisorLockHooks {
  /** Fault-injection/test seam for operations on the private guard candidate. */
  beforeGuardCreateStep?(step: GuardCreateStep, candidate: string): void | Promise<void>
  afterGuardAcquired?(section: LockCriticalSection): void | Promise<void>
  afterGuardStaleProbe?(record: SupervisorGuardRecord): void | Promise<void>
  afterInstallLinked?(record: SupervisorLockRecord): void | Promise<void>
  beforeCandidateDirectorySync?(directory: string): void | Promise<void>
  beforeCandidateCleanup?(candidate: string): void | Promise<void>
  beforeLockUnlink?(reason: LockUnlinkReason, lockFile: string): void | Promise<void>
}

export interface SupervisorLockOptions {
  readonly guardAttempts?: number
  readonly guardRetryMs?: number
  readonly guardProbe?: (record: SupervisorGuardRecord) => Promise<LockOwnerProbe>
  readonly hooks?: SupervisorLockHooks
}

export interface LockLease {
  readonly record: SupervisorLockRecord
  release(): Promise<void>
}

export type SupervisorLockErrorCode =
  | 'LOCK_ALREADY_RUNNING'
  | 'LOCK_OWNERSHIP_UNKNOWN'
  | 'LOCK_CONTENTION'

export class SupervisorLockError extends Error {
  readonly code: SupervisorLockErrorCode

  constructor(code: SupervisorLockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SupervisorLockError'
    this.code = code
  }
}

interface LockSnapshot {
  readonly raw: string
  readonly record?: SupervisorLockRecord
  readonly device: number
  readonly inode: number
}

interface GuardSnapshot {
  readonly raw: string
  readonly record?: SupervisorGuardRecord
  readonly device: number
  readonly inode: number
}

interface CreatedGuardIdentity {
  readonly device: number
  readonly inode: number
  readonly nonce: string
}

class UnsafeLockFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UnsafeLockFileError'
  }
}

function parseRecord(raw: string): SupervisorLockRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined

  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return undefined
  if (typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt) || candidate.startedAt <= 0) {
    return undefined
  }
  if (
    typeof candidate.instanceId !== 'string'
    || candidate.instanceId.length === 0
    || candidate.instanceId.length > 256
  ) return undefined
  if (
    typeof candidate.endpoint !== 'string'
    || candidate.endpoint.length === 0
    || candidate.endpoint.length > 4_096
  ) return undefined

  return {
    pid: candidate.pid as number,
    startedAt: candidate.startedAt,
    instanceId: candidate.instanceId,
    endpoint: candidate.endpoint,
  }
}

function parseGuardRecord(raw: string): SupervisorGuardRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined

  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return undefined
  if (
    typeof candidate.createdAt !== 'number'
    || !Number.isFinite(candidate.createdAt)
    || candidate.createdAt <= 0
  ) return undefined
  if (
    typeof candidate.nonce !== 'string'
    || candidate.nonce.length === 0
    || candidate.nonce.length > 256
  ) return undefined

  return {
    pid: candidate.pid as number,
    createdAt: candidate.createdAt,
    nonce: candidate.nonce,
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function validateLockMetadata(
  paths: RuntimePaths,
  metadata: Stats,
): void {
  if (!metadata.isFile()) throw new UnsafeLockFileError('supervisor lock is not a regular file')
  if (metadata.nlink !== 1) throw new UnsafeLockFileError('supervisor lock has an unsafe link count')
  if (metadata.size > MAX_LOCK_BYTES) throw new UnsafeLockFileError('supervisor lock is too large')

  if (paths.platform !== 'win32') {
    const uid = currentUid()
    if (uid !== undefined && metadata.uid !== uid) {
      throw new UnsafeLockFileError('supervisor lock is not owned by the current user')
    }
    if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new UnsafeLockFileError('supervisor lock mode is not 0600')
    }
  }
}

function validateGuardMetadata(paths: RuntimePaths, metadata: Stats): void {
  if (!metadata.isFile()) throw new UnsafeLockFileError('supervisor lock guard is not a regular file')
  if (metadata.nlink !== 1) throw new UnsafeLockFileError('supervisor lock guard has an unsafe link count')
  if (metadata.size > MAX_GUARD_BYTES) throw new UnsafeLockFileError('supervisor lock guard is too large')

  if (paths.platform !== 'win32') {
    const uid = currentUid()
    if (uid !== undefined && metadata.uid !== uid) {
      throw new UnsafeLockFileError('supervisor lock guard is not owned by the current user')
    }
    if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new UnsafeLockFileError('supervisor lock guard mode is not 0600')
    }
  }
}

async function readSnapshot(paths: RuntimePaths): Promise<LockSnapshot | undefined> {
  let handle
  try {
    const flags = paths.platform === 'win32'
      ? 'r'
      : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(paths.lockFile, flags)
    const before = await handle.stat()
    validateLockMetadata(paths, before)
    const raw = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    validateLockMetadata(paths, after)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
    ) {
      throw new UnsafeLockFileError('supervisor lock changed while it was read')
    }

    const record = parseRecord(raw)
    const identity = {
      raw,
      device: after.dev,
      inode: after.ino,
    }
    return record === undefined ? identity : { ...identity, record }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (error instanceof UnsafeLockFileError) throw error
    if (code === 'ELOOP') {
      throw new UnsafeLockFileError('supervisor lock must not be a symlink', { cause: error })
    }
    throw error
  } finally {
    await handle?.close()
  }
}

async function readGuardSnapshot(paths: RuntimePaths): Promise<GuardSnapshot | undefined> {
  let handle
  try {
    const flags = paths.platform === 'win32'
      ? 'r'
      : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(paths.guardFile, flags)
    const before = await handle.stat()
    validateGuardMetadata(paths, before)
    const raw = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    validateGuardMetadata(paths, after)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
    ) {
      throw new UnsafeLockFileError('supervisor lock guard changed while it was read')
    }

    const record = parseGuardRecord(raw)
    const identity = { raw, device: after.dev, inode: after.ino }
    return record === undefined ? identity : { ...identity, record }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (error instanceof UnsafeLockFileError) throw error
    if (code === 'ELOOP') {
      throw new UnsafeLockFileError('supervisor lock guard must not be a symlink', { cause: error })
    }
    throw error
  } finally {
    await handle?.close()
  }
}

/** Read a just-created guard for rollback without requiring its write/chmod to have completed. */
async function readGuardForCreationCleanup(
  paths: RuntimePaths,
  guardPath = paths.guardFile,
): Promise<GuardSnapshot | undefined> {
  let handle
  try {
    const flags = paths.platform === 'win32'
      ? 'r'
      : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(guardPath, flags)
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_GUARD_BYTES) {
      throw new UnsafeLockFileError('new supervisor lock guard has unsafe metadata')
    }
    if (paths.platform !== 'win32') {
      const uid = currentUid()
      if (uid !== undefined && before.uid !== uid) {
        throw new UnsafeLockFileError('new supervisor lock guard changed owner')
      }
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.size > MAX_GUARD_BYTES
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
    ) {
      throw new UnsafeLockFileError('new supervisor lock guard changed during cleanup validation')
    }
    if (paths.platform !== 'win32') {
      const uid = currentUid()
      if (uid !== undefined && after.uid !== uid) {
        throw new UnsafeLockFileError('new supervisor lock guard changed owner')
      }
    }

    const record = parseGuardRecord(raw)
    const snapshot = { raw, device: after.dev, inode: after.ino }
    return record === undefined ? snapshot : { ...snapshot, record }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP') {
      throw new UnsafeLockFileError('new supervisor lock guard must not be a symlink', { cause: error })
    }
    throw error
  } finally {
    await handle?.close()
  }
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.raw === right.raw
}

function sameGuardSnapshot(left: GuardSnapshot, right: GuardSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.raw === right.raw
}

function sameGuardRecord(left: SupervisorGuardRecord, right: SupervisorGuardRecord): boolean {
  return left.pid === right.pid
    && left.createdAt === right.createdAt
    && left.nonce === right.nonce
}

function sameRecord(left: SupervisorLockRecord, right: SupervisorLockRecord): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.instanceId === right.instanceId
    && left.endpoint === right.endpoint
}

function ownershipUnknown(message: string, cause?: unknown): SupervisorLockError {
  return new SupervisorLockError(
    'LOCK_OWNERSHIP_UNKNOWN',
    message,
    cause === undefined ? undefined : { cause },
  )
}

async function removeLock(
  paths: RuntimePaths,
  reason: LockUnlinkReason,
  hooks: SupervisorLockHooks | undefined,
): Promise<void> {
  await hooks?.beforeLockUnlink?.(reason, paths.lockFile)
  try {
    await unlink(paths.lockFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

interface GuardLease {
  readonly record: SupervisorGuardRecord
  release(): Promise<void>
}

/**
 * PID-only probing is deliberately conservative: only ESRCH proves staleness.
 * A visible foreign PID and every other error remain unknown.
 */
export async function probeGuardOwner(record: SupervisorGuardRecord): Promise<LockOwnerProbe> {
  if (record.pid === process.pid) return 'live'
  try {
    process.kill(record.pid, 0)
    return 'unknown'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'unknown'
  }
}

async function releaseOwnedGuard(
  paths: RuntimePaths,
  owned: GuardSnapshot,
  record: SupervisorGuardRecord,
): Promise<void> {
  const current = await readGuardSnapshot(paths)
  if (
    current === undefined
    || current.record === undefined
    || !sameGuardRecord(current.record, record)
    || !sameGuardSnapshot(current, owned)
  ) return

  // Re-read immediately before unlink to narrow replacement races. Node exposes
  // no compare-and-swap unlink, so another process can still replace the path in
  // the final syscall window; nonce + inode + raw snapshot checks are the
  // strongest portable user-space guard available here.
  const verified = await readGuardSnapshot(paths)
  if (verified === undefined || !sameGuardSnapshot(current, verified)) return
  try {
    await unlink(paths.guardFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function cleanupCreatedGuard(
  paths: RuntimePaths,
  candidate: string,
  identity: CreatedGuardIdentity,
): Promise<void> {
  const observed = await readGuardForCreationCleanup(paths, candidate)
  if (observed === undefined) return
  if (observed.device !== identity.device || observed.inode !== identity.inode) return
  if (observed.record !== undefined && observed.record.nonce !== identity.nonce) return

  const verified = await readGuardForCreationCleanup(paths, candidate)
  if (verified === undefined || !sameGuardSnapshot(observed, verified)) return
  if (verified.record !== undefined && verified.record.nonce !== identity.nonce) return

  try {
    await unlink(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function createGuardLease(
  paths: RuntimePaths,
  hooks: SupervisorLockHooks | undefined,
): Promise<GuardLease> {
  const record: SupervisorGuardRecord = {
    pid: process.pid,
    createdAt: Date.now(),
    nonce: randomUUID(),
  }
  const raw = `${JSON.stringify(record)}\n`
  const candidate = join(
    paths.stateDir,
    `.supervisor.lock.guard.${record.nonce}.candidate`,
  )
  let handle
  let created: CreatedGuardIdentity | undefined
  let owned: GuardSnapshot | undefined
  let linked = false
  let candidatePresent = true
  try {
    handle = await open(candidate, 'wx', PRIVATE_FILE_MODE)
    await hooks?.beforeGuardCreateStep?.('creation-stat', candidate)
    const creationMetadata = await handle.stat()
    if (!creationMetadata.isFile() || creationMetadata.nlink !== 1) {
      throw new UnsafeLockFileError('new supervisor lock guard has unsafe creation metadata')
    }
    created = {
      device: creationMetadata.dev,
      inode: creationMetadata.ino,
      nonce: record.nonce,
    }

    await hooks?.beforeGuardCreateStep?.('write', candidate)
    await handle.writeFile(raw, { encoding: 'utf8' })
    await hooks?.beforeGuardCreateStep?.('chmod', candidate)
    if (paths.platform !== 'win32') await handle.chmod(PRIVATE_FILE_MODE)
    await hooks?.beforeGuardCreateStep?.('sync', candidate)
    await handle.sync()
    await hooks?.beforeGuardCreateStep?.('stat', candidate)
    const metadata = await handle.stat()
    validateGuardMetadata(paths, metadata)
    if (metadata.dev !== created.device || metadata.ino !== created.inode) {
      throw new UnsafeLockFileError('new supervisor lock guard changed after creation')
    }
    owned = { raw, record, device: metadata.dev, inode: metadata.ino }
    await handle.close()
    handle = undefined

    // Publish only a complete, fsynced guard. The shared path is never malformed.
    await link(candidate, paths.guardFile)
    linked = true
    await unlink(candidate)
    candidatePresent = false
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (created === undefined && handle !== undefined) {
      try {
        const recoveryMetadata = await handle.stat()
        if (!recoveryMetadata.isFile() || recoveryMetadata.nlink !== 1) {
          throw new UnsafeLockFileError('new supervisor lock guard has unsafe recovery metadata')
        }
        created = {
          device: recoveryMetadata.dev,
          inode: recoveryMetadata.ino,
          nonce: record.nonce,
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      handle = undefined
    }
    if (linked && candidatePresent) {
      try {
        if (await sameInode(candidate, paths.guardFile)) await unlink(paths.guardFile)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError)
      }
    }
    if (created !== undefined && candidatePresent) {
      try {
        await cleanupCreatedGuard(paths, candidate, created)
        candidatePresent = false
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'guard creation and identity-safe cleanup failed')
    }
    throw error
  }

  let released = false
  return {
    record,
    async release(): Promise<void> {
      if (released) return
      await releaseOwnedGuard(paths, owned!, record)
      released = true
    },
  }
}

async function reclaimStaleGuard(
  paths: RuntimePaths,
  probe: (record: SupervisorGuardRecord) => Promise<LockOwnerProbe>,
  hooks: SupervisorLockHooks | undefined,
): Promise<'reclaimed' | 'busy'> {
  let observed: GuardSnapshot | undefined
  try {
    observed = await readGuardSnapshot(paths)
  } catch {
    return 'busy'
  }
  if (observed === undefined) return 'reclaimed'
  if (observed.record === undefined) return 'busy'

  let ownership: LockOwnerProbe
  try {
    ownership = await probe(observed.record)
  } catch {
    ownership = 'unknown'
  }
  if (ownership !== 'stale') return 'busy'
  await hooks?.afterGuardStaleProbe?.(observed.record)

  const current = await readGuardSnapshot(paths)
  if (current === undefined || !sameGuardSnapshot(observed, current)) {
    throw new SupervisorLockError(
      'LOCK_CONTENTION',
      'supervisor lock guard changed while stale ownership was checked',
    )
  }
  const verified = await readGuardSnapshot(paths)
  if (verified === undefined || !sameGuardSnapshot(current, verified)) {
    throw new SupervisorLockError(
      'LOCK_CONTENTION',
      'supervisor lock guard changed immediately before stale recovery',
    )
  }

  // Portable Node has no CAS-unlink. The two snapshot checks minimize the race;
  // any observed replacement fails closed instead of deleting it.
  try {
    await unlink(paths.guardFile)
    return 'reclaimed'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SupervisorLockError(
        'LOCK_CONTENTION',
        'supervisor lock guard disappeared during stale recovery',
      )
    }
    throw error
  }
}

async function acquireGuard(
  paths: RuntimePaths,
  section: LockCriticalSection,
  options: SupervisorLockOptions,
): Promise<GuardLease> {
  const attempts = options.guardAttempts ?? 64
  const retryMs = options.guardRetryMs ?? 2
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || !Number.isFinite(retryMs) || retryMs < 0) {
    throw new TypeError('invalid supervisor lock guard retry options')
  }
  const probe = options.guardProbe ?? probeGuardOwner

  let busyAttempts = 0
  while (busyAttempts < attempts) {
    let lease: GuardLease
    try {
      lease = await createGuardLease(paths, options.hooks)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reclaimStaleGuard(paths, probe, options.hooks) === 'reclaimed') continue
      busyAttempts += 1
      if (busyAttempts < attempts) await delay(retryMs)
      continue
    }

    try {
      await options.hooks?.afterGuardAcquired?.(section)
    } catch (error) {
      await lease.release().catch(cleanupError => {
        throw new AggregateError([error, cleanupError], 'guard hook and cleanup both failed')
      })
      throw error
    }
    return lease
  }

  throw new SupervisorLockError(
    'LOCK_CONTENTION',
    'supervisor lock guard remained busy; refusing to alter the lock',
  )
}

async function sameInode(left: string, right: string): Promise<boolean> {
  const [leftMetadata, rightMetadata] = await Promise.all([lstat(left), lstat(right)])
  return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino
}

async function installRecord(
  paths: RuntimePaths,
  record: SupervisorLockRecord,
  hooks: SupervisorLockHooks | undefined,
): Promise<void> {
  const candidate = join(paths.stateDir, `.supervisor.lock.${record.instanceId}.candidate`)
  let linked = false
  let candidatePresent = true

  try {
    await writePrivateFileAtomic(
      candidate,
      `${JSON.stringify(record)}\n`,
      paths.platform,
      { beforeDirectorySync: directory => hooks?.beforeCandidateDirectorySync?.(directory) },
    )
    await link(candidate, paths.lockFile)
    linked = true
    await hooks?.afterInstallLinked?.(record)
    await hooks?.beforeCandidateCleanup?.(candidate)
    await unlink(candidate)
    candidatePresent = false
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (linked) {
      try {
        if (await sameInode(candidate, paths.lockFile)) {
          await removeLock(paths, 'rollback', hooks)
        } else {
          cleanupErrors.push(new Error('linked lock changed before installation rollback'))
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (candidatePresent) {
      try {
        await unlink(candidate)
        candidatePresent = false
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'supervisor lock installation and rollback failed')
    }
    throw error
  }
}

async function readExistingForAcquire(paths: RuntimePaths): Promise<LockSnapshot | undefined> {
  try {
    return await readSnapshot(paths)
  } catch (error) {
    if (error instanceof UnsafeLockFileError) {
      throw ownershipUnknown(error.message, error)
    }
    throw error
  }
}

async function rollbackInstalledRecord(
  paths: RuntimePaths,
  record: SupervisorLockRecord,
  hooks: SupervisorLockHooks | undefined,
): Promise<void> {
  const current = await readSnapshot(paths)
  if (current?.record !== undefined && sameRecord(current.record, record)) {
    await removeLock(paths, 'rollback', hooks)
  }
}

/**
 * Conservative unauthenticated probe. Only this exact process can be trusted as
 * live from PID identity alone; another visible PID needs endpoint proof from a
 * caller-supplied probe before its lock may be treated as live.
 */
export async function probeLockOwner(record: SupervisorLockRecord): Promise<LockOwnerProbe> {
  if (record.pid === process.pid) return 'live'
  try {
    process.kill(record.pid, 0)
    return 'unknown'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'stale'
    return 'unknown'
  }
}

export async function acquireSupervisorLock(
  paths: RuntimePaths,
  probe: (record: SupervisorLockRecord) => Promise<LockOwnerProbe> = probeLockOwner,
  options: SupervisorLockOptions = {},
): Promise<LockLease> {
  const guard = await acquireGuard(paths, 'acquire', options)
  let installedRecord: SupervisorLockRecord | undefined
  let guardReleased = false

  try {
    const existing = await readExistingForAcquire(paths)
    if (existing !== undefined) {
      if (existing.record === undefined || existing.record.endpoint !== paths.endpoint) {
        throw ownershipUnknown('supervisor lock ownership cannot be validated')
      }

      let ownership: LockOwnerProbe
      try {
        ownership = await probe(existing.record)
      } catch (error) {
        throw ownershipUnknown('supervisor lock owner probe failed', error)
      }

      if (ownership === 'live') {
        throw new SupervisorLockError(
          'LOCK_ALREADY_RUNNING',
          `supervisor is already running as pid ${existing.record.pid}`,
        )
      }
      if (ownership === 'unknown') {
        throw ownershipUnknown('supervisor lock owner is unknown')
      }

      const current = await readExistingForAcquire(paths)
      if (current === undefined || !sameSnapshot(existing, current)) {
        throw new SupervisorLockError(
          'LOCK_CONTENTION',
          'supervisor lock changed while stale ownership was checked',
        )
      }
      await removeLock(paths, 'stale', options.hooks)
    }

    const record: SupervisorLockRecord = {
      pid: process.pid,
      startedAt: Date.now(),
      instanceId: randomUUID(),
      endpoint: paths.endpoint,
    }
    await installRecord(paths, record, options.hooks)
    installedRecord = record

    await guard.release()
    guardReleased = true

    let released = false
    return {
      record,
      async release(): Promise<void> {
        if (released) return
        const releaseGuard = await acquireGuard(paths, 'release', options)
        let safelyReleased = false
        let releaseGuardReleased = false
        try {
          let current: LockSnapshot | undefined
          try {
            current = await readSnapshot(paths)
          } catch (error) {
            if (error instanceof UnsafeLockFileError) {
              safelyReleased = true
              return
            }
            throw error
          }

          if (current?.record === undefined || !sameRecord(current.record, record)) {
            safelyReleased = true
            return
          }
          await removeLock(paths, 'release', options.hooks)
          safelyReleased = true
        } finally {
          try {
            await releaseGuard.release()
            releaseGuardReleased = true
          } finally {
            if (safelyReleased && releaseGuardReleased) released = true
          }
        }
      },
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (installedRecord !== undefined && !guardReleased) {
      try {
        await rollbackInstalledRecord(paths, installedRecord, options.hooks)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (!guardReleased) {
      try {
        await guard.release()
        guardReleased = true
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'supervisor lock operation and cleanup failed')
    }
    throw error
  }
}
