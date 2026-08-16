import { type RuntimePaths } from './paths.js';
export interface SupervisorLockRecord {
    readonly pid: number;
    readonly startedAt: number;
    readonly instanceId: string;
    readonly endpoint: string;
}
/** Bounded ownership record for the short-lived lock mutation guard. */
export interface SupervisorGuardRecord {
    readonly pid: number;
    readonly createdAt: number;
    readonly nonce: string;
}
export type LockOwnerProbe = 'live' | 'stale' | 'unknown';
export type LockCriticalSection = 'acquire' | 'release';
export type LockUnlinkReason = 'stale' | 'release' | 'rollback';
export type GuardCreateStep = 'creation-stat' | 'write' | 'chmod' | 'sync' | 'stat';
export interface SupervisorLockHooks {
    /** Fault-injection/test seam for operations on the private guard candidate. */
    beforeGuardCreateStep?(step: GuardCreateStep, candidate: string): void | Promise<void>;
    afterGuardAcquired?(section: LockCriticalSection): void | Promise<void>;
    afterGuardStaleProbe?(record: SupervisorGuardRecord): void | Promise<void>;
    afterInstallLinked?(record: SupervisorLockRecord): void | Promise<void>;
    beforeCandidateDirectorySync?(directory: string): void | Promise<void>;
    beforeCandidateCleanup?(candidate: string): void | Promise<void>;
    beforeLockUnlink?(reason: LockUnlinkReason, lockFile: string): void | Promise<void>;
}
export interface SupervisorLockOptions {
    readonly guardAttempts?: number;
    readonly guardRetryMs?: number;
    readonly guardProbe?: (record: SupervisorGuardRecord) => Promise<LockOwnerProbe>;
    readonly hooks?: SupervisorLockHooks;
}
export interface LockLease {
    readonly record: SupervisorLockRecord;
    release(): Promise<void>;
}
export type SupervisorLockErrorCode = 'LOCK_ALREADY_RUNNING' | 'LOCK_OWNERSHIP_UNKNOWN' | 'LOCK_CONTENTION';
export declare class SupervisorLockError extends Error {
    readonly code: SupervisorLockErrorCode;
    constructor(code: SupervisorLockErrorCode, message: string, options?: ErrorOptions);
}
/**
 * PID-only probing is deliberately conservative: only ESRCH proves staleness.
 * A visible foreign PID and every other error remain unknown.
 */
export declare function probeGuardOwner(record: SupervisorGuardRecord): Promise<LockOwnerProbe>;
/**
 * Conservative unauthenticated probe. Only this exact process can be trusted as
 * live from PID identity alone; another visible PID needs endpoint proof from a
 * caller-supplied probe before its lock may be treated as live.
 */
export declare function probeLockOwner(record: SupervisorLockRecord): Promise<LockOwnerProbe>;
export declare function acquireSupervisorLock(paths: RuntimePaths, probe?: (record: SupervisorLockRecord) => Promise<LockOwnerProbe>, options?: SupervisorLockOptions): Promise<LockLease>;
//# sourceMappingURL=lock.d.ts.map