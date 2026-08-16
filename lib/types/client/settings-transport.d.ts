import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client';
export type SettingsEditOp = {
    readonly op: 'set';
    readonly path: readonly [string];
    readonly value: unknown;
} | {
    readonly op: 'unset';
    readonly path: readonly [string];
};
export interface SettingsTransportSnapshot<T> {
    readonly status: 'loading' | 'ready' | 'unavailable';
    readonly value: T | undefined;
    readonly base: unknown;
    readonly user: unknown;
    readonly writable: boolean;
    readonly mode: 'official' | 'compat' | 'unavailable';
    readonly revision: number | undefined;
    readonly error: string | undefined;
}
export interface SettingsTransport<T> {
    readonly getSnapshot: () => SettingsTransportSnapshot<T>;
    readonly subscribe: (listener: () => void) => () => void;
    readonly mutate: (ops: readonly SettingsEditOp[], expectedRevision?: number) => Promise<void>;
    readonly refresh: () => Promise<void>;
}
export interface SettingsTransportOptions {
    readonly fetchFn?: typeof fetch;
    readonly loopback: boolean;
}
export declare function createSettingsTransport<T>(official: SettingsScope<T>, options: SettingsTransportOptions): SettingsTransport<T>;
//# sourceMappingURL=settings-transport.d.ts.map