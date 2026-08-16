import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink, } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writePrivateFileAtomic, } from './paths.js';
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_GUARD_BYTES = 4 * 1024;
export class SupervisorLockError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'SupervisorLockError';
        this.code = code;
    }
}
class UnsafeLockFileError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'UnsafeLockFileError';
    }
}
function parseRecord(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0)
        return undefined;
    if (typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt) || candidate.startedAt <= 0) {
        return undefined;
    }
    if (typeof candidate.instanceId !== 'string'
        || candidate.instanceId.length === 0
        || candidate.instanceId.length > 256)
        return undefined;
    if (typeof candidate.endpoint !== 'string'
        || candidate.endpoint.length === 0
        || candidate.endpoint.length > 4_096)
        return undefined;
    return {
        pid: candidate.pid,
        startedAt: candidate.startedAt,
        instanceId: candidate.instanceId,
        endpoint: candidate.endpoint,
    };
}
function parseGuardRecord(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0)
        return undefined;
    if (typeof candidate.createdAt !== 'number'
        || !Number.isFinite(candidate.createdAt)
        || candidate.createdAt <= 0)
        return undefined;
    if (typeof candidate.nonce !== 'string'
        || candidate.nonce.length === 0
        || candidate.nonce.length > 256)
        return undefined;
    return {
        pid: candidate.pid,
        createdAt: candidate.createdAt,
        nonce: candidate.nonce,
    };
}
function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
function validateLockMetadata(paths, metadata) {
    if (!metadata.isFile())
        throw new UnsafeLockFileError('supervisor lock is not a regular file');
    if (metadata.nlink !== 1)
        throw new UnsafeLockFileError('supervisor lock has an unsafe link count');
    if (metadata.size > MAX_LOCK_BYTES)
        throw new UnsafeLockFileError('supervisor lock is too large');
    if (paths.platform !== 'win32') {
        const uid = currentUid();
        if (uid !== undefined && metadata.uid !== uid) {
            throw new UnsafeLockFileError('supervisor lock is not owned by the current user');
        }
        if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
            throw new UnsafeLockFileError('supervisor lock mode is not 0600');
        }
    }
}
function validateGuardMetadata(paths, metadata) {
    if (!metadata.isFile())
        throw new UnsafeLockFileError('supervisor lock guard is not a regular file');
    if (metadata.nlink !== 1)
        throw new UnsafeLockFileError('supervisor lock guard has an unsafe link count');
    if (metadata.size > MAX_GUARD_BYTES)
        throw new UnsafeLockFileError('supervisor lock guard is too large');
    if (paths.platform !== 'win32') {
        const uid = currentUid();
        if (uid !== undefined && metadata.uid !== uid) {
            throw new UnsafeLockFileError('supervisor lock guard is not owned by the current user');
        }
        if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
            throw new UnsafeLockFileError('supervisor lock guard mode is not 0600');
        }
    }
}
async function readSnapshot(paths) {
    let handle;
    try {
        const flags = paths.platform === 'win32'
            ? 'r'
            : constants.O_RDONLY | constants.O_NOFOLLOW;
        handle = await open(paths.lockFile, flags);
        const before = await handle.stat();
        validateLockMetadata(paths, before);
        const raw = await handle.readFile({ encoding: 'utf8' });
        const after = await handle.stat();
        validateLockMetadata(paths, after);
        if (before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size) {
            throw new UnsafeLockFileError('supervisor lock changed while it was read');
        }
        const record = parseRecord(raw);
        const identity = {
            raw,
            device: after.dev,
            inode: after.ino,
        };
        return record === undefined ? identity : { ...identity, record };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return undefined;
        if (error instanceof UnsafeLockFileError)
            throw error;
        if (code === 'ELOOP') {
            throw new UnsafeLockFileError('supervisor lock must not be a symlink', { cause: error });
        }
        throw error;
    }
    finally {
        await handle?.close();
    }
}
async function readGuardSnapshot(paths) {
    let handle;
    try {
        const flags = paths.platform === 'win32'
            ? 'r'
            : constants.O_RDONLY | constants.O_NOFOLLOW;
        handle = await open(paths.guardFile, flags);
        const before = await handle.stat();
        validateGuardMetadata(paths, before);
        const raw = await handle.readFile({ encoding: 'utf8' });
        const after = await handle.stat();
        validateGuardMetadata(paths, after);
        if (before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size) {
            throw new UnsafeLockFileError('supervisor lock guard changed while it was read');
        }
        const record = parseGuardRecord(raw);
        const identity = { raw, device: after.dev, inode: after.ino };
        return record === undefined ? identity : { ...identity, record };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return undefined;
        if (error instanceof UnsafeLockFileError)
            throw error;
        if (code === 'ELOOP') {
            throw new UnsafeLockFileError('supervisor lock guard must not be a symlink', { cause: error });
        }
        throw error;
    }
    finally {
        await handle?.close();
    }
}
/** Read a just-created guard for rollback without requiring its write/chmod to have completed. */
async function readGuardForCreationCleanup(paths, guardPath = paths.guardFile) {
    let handle;
    try {
        const flags = paths.platform === 'win32'
            ? 'r'
            : constants.O_RDONLY | constants.O_NOFOLLOW;
        handle = await open(guardPath, flags);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > MAX_GUARD_BYTES) {
            throw new UnsafeLockFileError('new supervisor lock guard has unsafe metadata');
        }
        if (paths.platform !== 'win32') {
            const uid = currentUid();
            if (uid !== undefined && before.uid !== uid) {
                throw new UnsafeLockFileError('new supervisor lock guard changed owner');
            }
        }
        const raw = await handle.readFile({ encoding: 'utf8' });
        const after = await handle.stat();
        if (!after.isFile()
            || after.nlink !== 1
            || after.size > MAX_GUARD_BYTES
            || before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size) {
            throw new UnsafeLockFileError('new supervisor lock guard changed during cleanup validation');
        }
        if (paths.platform !== 'win32') {
            const uid = currentUid();
            if (uid !== undefined && after.uid !== uid) {
                throw new UnsafeLockFileError('new supervisor lock guard changed owner');
            }
        }
        const record = parseGuardRecord(raw);
        const snapshot = { raw, device: after.dev, inode: after.ino };
        return record === undefined ? snapshot : { ...snapshot, record };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return undefined;
        if (code === 'ELOOP') {
            throw new UnsafeLockFileError('new supervisor lock guard must not be a symlink', { cause: error });
        }
        throw error;
    }
    finally {
        await handle?.close();
    }
}
function sameSnapshot(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.raw === right.raw;
}
function sameGuardSnapshot(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.raw === right.raw;
}
function sameGuardRecord(left, right) {
    return left.pid === right.pid
        && left.createdAt === right.createdAt
        && left.nonce === right.nonce;
}
function sameRecord(left, right) {
    return left.pid === right.pid
        && left.startedAt === right.startedAt
        && left.instanceId === right.instanceId
        && left.endpoint === right.endpoint;
}
function ownershipUnknown(message, cause) {
    return new SupervisorLockError('LOCK_OWNERSHIP_UNKNOWN', message, cause === undefined ? undefined : { cause });
}
async function removeLock(paths, reason, hooks) {
    await hooks?.beforeLockUnlink?.(reason, paths.lockFile);
    try {
        await unlink(paths.lockFile);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/**
 * PID-only probing is deliberately conservative: only ESRCH proves staleness.
 * A visible foreign PID and every other error remain unknown.
 */
export async function probeGuardOwner(record) {
    if (record.pid === process.pid)
        return 'live';
    try {
        process.kill(record.pid, 0);
        return 'unknown';
    }
    catch (error) {
        return error.code === 'ESRCH' ? 'stale' : 'unknown';
    }
}
async function releaseOwnedGuard(paths, owned, record) {
    const current = await readGuardSnapshot(paths);
    if (current === undefined
        || current.record === undefined
        || !sameGuardRecord(current.record, record)
        || !sameGuardSnapshot(current, owned))
        return;
    // Re-read immediately before unlink to narrow replacement races. Node exposes
    // no compare-and-swap unlink, so another process can still replace the path in
    // the final syscall window; nonce + inode + raw snapshot checks are the
    // strongest portable user-space guard available here.
    const verified = await readGuardSnapshot(paths);
    if (verified === undefined || !sameGuardSnapshot(current, verified))
        return;
    try {
        await unlink(paths.guardFile);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function cleanupCreatedGuard(paths, candidate, identity) {
    const observed = await readGuardForCreationCleanup(paths, candidate);
    if (observed === undefined)
        return;
    if (observed.device !== identity.device || observed.inode !== identity.inode)
        return;
    if (observed.record !== undefined && observed.record.nonce !== identity.nonce)
        return;
    const verified = await readGuardForCreationCleanup(paths, candidate);
    if (verified === undefined || !sameGuardSnapshot(observed, verified))
        return;
    if (verified.record !== undefined && verified.record.nonce !== identity.nonce)
        return;
    try {
        await unlink(candidate);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function createGuardLease(paths, hooks) {
    const record = {
        pid: process.pid,
        createdAt: Date.now(),
        nonce: randomUUID(),
    };
    const raw = `${JSON.stringify(record)}\n`;
    const candidate = join(paths.stateDir, `.supervisor.lock.guard.${record.nonce}.candidate`);
    let handle;
    let created;
    let owned;
    let linked = false;
    let candidatePresent = true;
    try {
        handle = await open(candidate, 'wx', PRIVATE_FILE_MODE);
        await hooks?.beforeGuardCreateStep?.('creation-stat', candidate);
        const creationMetadata = await handle.stat();
        if (!creationMetadata.isFile() || creationMetadata.nlink !== 1) {
            throw new UnsafeLockFileError('new supervisor lock guard has unsafe creation metadata');
        }
        created = {
            device: creationMetadata.dev,
            inode: creationMetadata.ino,
            nonce: record.nonce,
        };
        await hooks?.beforeGuardCreateStep?.('write', candidate);
        await handle.writeFile(raw, { encoding: 'utf8' });
        await hooks?.beforeGuardCreateStep?.('chmod', candidate);
        if (paths.platform !== 'win32')
            await handle.chmod(PRIVATE_FILE_MODE);
        await hooks?.beforeGuardCreateStep?.('sync', candidate);
        await handle.sync();
        await hooks?.beforeGuardCreateStep?.('stat', candidate);
        const metadata = await handle.stat();
        validateGuardMetadata(paths, metadata);
        if (metadata.dev !== created.device || metadata.ino !== created.inode) {
            throw new UnsafeLockFileError('new supervisor lock guard changed after creation');
        }
        owned = { raw, record, device: metadata.dev, inode: metadata.ino };
        await handle.close();
        handle = undefined;
        // Publish only a complete, fsynced guard. The shared path is never malformed.
        await link(candidate, paths.guardFile);
        linked = true;
        await unlink(candidate);
        candidatePresent = false;
    }
    catch (error) {
        const cleanupErrors = [];
        if (created === undefined && handle !== undefined) {
            try {
                const recoveryMetadata = await handle.stat();
                if (!recoveryMetadata.isFile() || recoveryMetadata.nlink !== 1) {
                    throw new UnsafeLockFileError('new supervisor lock guard has unsafe recovery metadata');
                }
                created = {
                    device: recoveryMetadata.dev,
                    inode: recoveryMetadata.ino,
                    nonce: record.nonce,
                };
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
            handle = undefined;
        }
        if (linked && candidatePresent) {
            try {
                if (await sameInode(candidate, paths.guardFile))
                    await unlink(paths.guardFile);
            }
            catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT')
                    cleanupErrors.push(cleanupError);
            }
        }
        if (created !== undefined && candidatePresent) {
            try {
                await cleanupCreatedGuard(paths, candidate, created);
                candidatePresent = false;
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], 'guard creation and identity-safe cleanup failed');
        }
        throw error;
    }
    let released = false;
    return {
        record,
        async release() {
            if (released)
                return;
            await releaseOwnedGuard(paths, owned, record);
            released = true;
        },
    };
}
async function reclaimStaleGuard(paths, probe, hooks) {
    let observed;
    try {
        observed = await readGuardSnapshot(paths);
    }
    catch {
        return 'busy';
    }
    if (observed === undefined)
        return 'reclaimed';
    if (observed.record === undefined)
        return 'busy';
    let ownership;
    try {
        ownership = await probe(observed.record);
    }
    catch {
        ownership = 'unknown';
    }
    if (ownership !== 'stale')
        return 'busy';
    await hooks?.afterGuardStaleProbe?.(observed.record);
    const current = await readGuardSnapshot(paths);
    if (current === undefined || !sameGuardSnapshot(observed, current)) {
        throw new SupervisorLockError('LOCK_CONTENTION', 'supervisor lock guard changed while stale ownership was checked');
    }
    const verified = await readGuardSnapshot(paths);
    if (verified === undefined || !sameGuardSnapshot(current, verified)) {
        throw new SupervisorLockError('LOCK_CONTENTION', 'supervisor lock guard changed immediately before stale recovery');
    }
    // Portable Node has no CAS-unlink. The two snapshot checks minimize the race;
    // any observed replacement fails closed instead of deleting it.
    try {
        await unlink(paths.guardFile);
        return 'reclaimed';
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new SupervisorLockError('LOCK_CONTENTION', 'supervisor lock guard disappeared during stale recovery');
        }
        throw error;
    }
}
async function acquireGuard(paths, section, options) {
    const attempts = options.guardAttempts ?? 64;
    const retryMs = options.guardRetryMs ?? 2;
    if (!Number.isSafeInteger(attempts) || attempts <= 0 || !Number.isFinite(retryMs) || retryMs < 0) {
        throw new TypeError('invalid supervisor lock guard retry options');
    }
    const probe = options.guardProbe ?? probeGuardOwner;
    let busyAttempts = 0;
    while (busyAttempts < attempts) {
        let lease;
        try {
            lease = await createGuardLease(paths, options.hooks);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (await reclaimStaleGuard(paths, probe, options.hooks) === 'reclaimed')
                continue;
            busyAttempts += 1;
            if (busyAttempts < attempts)
                await delay(retryMs);
            continue;
        }
        try {
            await options.hooks?.afterGuardAcquired?.(section);
        }
        catch (error) {
            await lease.release().catch(cleanupError => {
                throw new AggregateError([error, cleanupError], 'guard hook and cleanup both failed');
            });
            throw error;
        }
        return lease;
    }
    throw new SupervisorLockError('LOCK_CONTENTION', 'supervisor lock guard remained busy; refusing to alter the lock');
}
async function sameInode(left, right) {
    const [leftMetadata, rightMetadata] = await Promise.all([lstat(left), lstat(right)]);
    return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino;
}
async function installRecord(paths, record, hooks) {
    const candidate = join(paths.stateDir, `.supervisor.lock.${record.instanceId}.candidate`);
    let linked = false;
    let candidatePresent = true;
    try {
        await writePrivateFileAtomic(candidate, `${JSON.stringify(record)}\n`, paths.platform, { beforeDirectorySync: directory => hooks?.beforeCandidateDirectorySync?.(directory) });
        await link(candidate, paths.lockFile);
        linked = true;
        await hooks?.afterInstallLinked?.(record);
        await hooks?.beforeCandidateCleanup?.(candidate);
        await unlink(candidate);
        candidatePresent = false;
    }
    catch (error) {
        const cleanupErrors = [];
        if (linked) {
            try {
                if (await sameInode(candidate, paths.lockFile)) {
                    await removeLock(paths, 'rollback', hooks);
                }
                else {
                    cleanupErrors.push(new Error('linked lock changed before installation rollback'));
                }
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (candidatePresent) {
            try {
                await unlink(candidate);
                candidatePresent = false;
            }
            catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT')
                    cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], 'supervisor lock installation and rollback failed');
        }
        throw error;
    }
}
async function readExistingForAcquire(paths) {
    try {
        return await readSnapshot(paths);
    }
    catch (error) {
        if (error instanceof UnsafeLockFileError) {
            throw ownershipUnknown(error.message, error);
        }
        throw error;
    }
}
async function rollbackInstalledRecord(paths, record, hooks) {
    const current = await readSnapshot(paths);
    if (current?.record !== undefined && sameRecord(current.record, record)) {
        await removeLock(paths, 'rollback', hooks);
    }
}
/**
 * Conservative unauthenticated probe. Only this exact process can be trusted as
 * live from PID identity alone; another visible PID needs endpoint proof from a
 * caller-supplied probe before its lock may be treated as live.
 */
export async function probeLockOwner(record) {
    if (record.pid === process.pid)
        return 'live';
    try {
        process.kill(record.pid, 0);
        return 'unknown';
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return 'stale';
        return 'unknown';
    }
}
export async function acquireSupervisorLock(paths, probe = probeLockOwner, options = {}) {
    const guard = await acquireGuard(paths, 'acquire', options);
    let installedRecord;
    let guardReleased = false;
    try {
        const existing = await readExistingForAcquire(paths);
        if (existing !== undefined) {
            if (existing.record === undefined || existing.record.endpoint !== paths.endpoint) {
                throw ownershipUnknown('supervisor lock ownership cannot be validated');
            }
            let ownership;
            try {
                ownership = await probe(existing.record);
            }
            catch (error) {
                throw ownershipUnknown('supervisor lock owner probe failed', error);
            }
            if (ownership === 'live') {
                throw new SupervisorLockError('LOCK_ALREADY_RUNNING', `supervisor is already running as pid ${existing.record.pid}`);
            }
            if (ownership === 'unknown') {
                throw ownershipUnknown('supervisor lock owner is unknown');
            }
            const current = await readExistingForAcquire(paths);
            if (current === undefined || !sameSnapshot(existing, current)) {
                throw new SupervisorLockError('LOCK_CONTENTION', 'supervisor lock changed while stale ownership was checked');
            }
            await removeLock(paths, 'stale', options.hooks);
        }
        const record = {
            pid: process.pid,
            startedAt: Date.now(),
            instanceId: randomUUID(),
            endpoint: paths.endpoint,
        };
        await installRecord(paths, record, options.hooks);
        installedRecord = record;
        await guard.release();
        guardReleased = true;
        let released = false;
        return {
            record,
            async release() {
                if (released)
                    return;
                const releaseGuard = await acquireGuard(paths, 'release', options);
                let safelyReleased = false;
                let releaseGuardReleased = false;
                try {
                    let current;
                    try {
                        current = await readSnapshot(paths);
                    }
                    catch (error) {
                        if (error instanceof UnsafeLockFileError) {
                            safelyReleased = true;
                            return;
                        }
                        throw error;
                    }
                    if (current?.record === undefined || !sameRecord(current.record, record)) {
                        safelyReleased = true;
                        return;
                    }
                    await removeLock(paths, 'release', options.hooks);
                    safelyReleased = true;
                }
                finally {
                    try {
                        await releaseGuard.release();
                        releaseGuardReleased = true;
                    }
                    finally {
                        if (safelyReleased && releaseGuardReleased)
                            released = true;
                    }
                }
            },
        };
    }
    catch (error) {
        const cleanupErrors = [];
        if (installedRecord !== undefined && !guardReleased) {
            try {
                await rollbackInstalledRecord(paths, installedRecord, options.hooks);
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (!guardReleased) {
            try {
                await guard.release();
                guardReleased = true;
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], 'supervisor lock operation and cleanup failed');
        }
        throw error;
    }
}
//# sourceMappingURL=lock.js.map