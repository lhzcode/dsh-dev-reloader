const SETTINGS_PATH = '/plugins/dsh-dev-reloader/settings';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseDescriptor(value) {
    if (!isRecord(value) || !('value' in value))
        return undefined;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0)
        return undefined;
    if (typeof value.writable !== 'boolean')
        return undefined;
    return {
        value: value.value,
        base: value.base,
        user: value.user,
        revision: value.revision,
        writable: value.writable,
    };
}
async function responseError(response) {
    try {
        const body = await response.json();
        if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) {
            return body.error.slice(0, 512);
        }
    }
    catch {
        // Fall through to the bounded status message.
    }
    return 'settings request failed (' + response.status + ')';
}
function officialSnapshot(source) {
    return {
        status: source.status,
        value: source.value,
        base: source.base,
        user: source.user,
        writable: source.writable,
        mode: source.status === 'ready' ? 'official' : 'unavailable',
        revision: undefined,
        error: undefined,
    };
}
class SettingsTransportController {
    official;
    fetchFn;
    loopback;
    listeners = new Set();
    sourceSnapshot;
    snapshot;
    unsubscribeOfficial;
    loadPromise;
    loadGeneration = 0;
    writeTail = Promise.resolve();
    constructor(official, fetchFn, loopback) {
        this.official = official;
        this.fetchFn = fetchFn;
        this.loopback = loopback;
        this.sourceSnapshot = official.getSnapshot();
        this.snapshot = officialSnapshot(this.sourceSnapshot);
    }
    getSnapshot = () => {
        const source = this.official.getSnapshot();
        if (source !== this.sourceSnapshot)
            this.acceptOfficial(source, false);
        return this.snapshot;
    };
    subscribe = (listener) => {
        this.listeners.add(listener);
        if (this.unsubscribeOfficial === undefined) {
            this.unsubscribeOfficial = this.official.subscribe(() => {
                this.acceptOfficial(this.official.getSnapshot(), true);
            });
        }
        if (this.sourceSnapshot.status === 'unavailable')
            void this.loadCompat();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.unsubscribeOfficial?.();
                this.unsubscribeOfficial = undefined;
            }
        };
    };
    refresh = async () => {
        const source = this.official.getSnapshot();
        this.acceptOfficial(source, false);
        if (source.status === 'unavailable')
            await this.loadCompat(true);
    };
    mutate = (ops, expectedRevision) => {
        const operation = this.writeTail.then(async () => {
            if (ops.length === 0)
                return;
            const source = this.official.getSnapshot();
            this.acceptOfficial(source, false);
            if (source.status === 'ready') {
                if (!source.writable)
                    throw new Error('settings document is read-only');
                for (const op of ops) {
                    if (op.op === 'set')
                        await this.official.set(op.path[0], op.value);
                    else
                        await this.official.unset(op.path[0]);
                }
                this.acceptOfficial(this.official.getSnapshot(), true);
                return;
            }
            if (this.snapshot.status !== 'ready' || this.snapshot.mode !== 'compat') {
                throw new Error(this.snapshot.error ?? 'settings are unavailable');
            }
            if (!this.snapshot.writable)
                throw new Error('settings document is read-only');
            if (this.fetchFn === undefined)
                throw new Error('settings are unavailable');
            const revision = expectedRevision ?? this.snapshot.revision;
            const response = await this.fetchFn(SETTINGS_PATH, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...(revision === undefined ? {} : { expectedRevision: revision }),
                    ops,
                }),
            });
            if (!response.ok) {
                const message = await responseError(response);
                await this.loadCompat(true, message);
                throw new Error(message);
            }
            const body = await response.json();
            const descriptor = isRecord(body) ? parseDescriptor(body.descriptor) : undefined;
            if (descriptor === undefined)
                throw new Error('settings response is malformed');
            if (this.official.getSnapshot().status === 'ready') {
                this.acceptOfficial(this.official.getSnapshot(), true);
                return;
            }
            this.loadGeneration += 1;
            this.acceptCompat(descriptor);
        });
        this.writeTail = operation.catch(() => undefined);
        return operation;
    };
    acceptOfficial(source, notify) {
        if (source === this.sourceSnapshot)
            return;
        this.sourceSnapshot = source;
        if (source.status === 'ready') {
            this.loadGeneration += 1;
            this.setSnapshot(officialSnapshot(source), notify);
            return;
        }
        if (source.status === 'loading') {
            this.setSnapshot(officialSnapshot(source), notify);
            return;
        }
        if (!this.loopback || this.fetchFn === undefined) {
            this.setSnapshot(officialSnapshot(source), notify);
            return;
        }
        if (this.snapshot.mode !== 'compat') {
            this.setSnapshot({
                status: 'loading',
                value: undefined,
                base: undefined,
                user: undefined,
                writable: source.writable,
                mode: 'compat',
                revision: undefined,
                error: undefined,
            }, notify);
        }
        void this.loadCompat();
    }
    async loadCompat(force = false, retainedError) {
        if (!this.loopback || this.fetchFn === undefined)
            return;
        if (this.official.getSnapshot().status === 'ready')
            return;
        if (!force && this.loadPromise !== undefined)
            return this.loadPromise;
        const generation = ++this.loadGeneration;
        const load = (async () => {
            try {
                const response = await this.fetchFn(SETTINGS_PATH, {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { accept: 'application/json' },
                });
                if (!response.ok)
                    throw new Error(await responseError(response));
                const body = await response.json();
                const descriptor = isRecord(body) ? parseDescriptor(body.descriptor) : undefined;
                if (descriptor === undefined)
                    throw new Error('settings response is malformed');
                if (generation !== this.loadGeneration)
                    return;
                if (this.official.getSnapshot().status !== 'ready')
                    this.acceptCompat(descriptor, retainedError);
            }
            catch (error) {
                if (generation !== this.loadGeneration)
                    return;
                if (this.official.getSnapshot().status === 'ready')
                    return;
                const message = retainedError ?? (error instanceof Error ? error.message : 'settings request failed');
                this.setSnapshot({
                    status: 'unavailable',
                    value: undefined,
                    base: undefined,
                    user: undefined,
                    writable: this.official.getSnapshot().writable,
                    mode: 'unavailable',
                    revision: undefined,
                    error: message.slice(0, 512),
                }, true);
            }
        })();
        this.loadPromise = load;
        try {
            await load;
        }
        finally {
            if (this.loadPromise === load)
                this.loadPromise = undefined;
        }
    }
    acceptCompat(descriptor, error) {
        this.setSnapshot({
            status: 'ready',
            value: descriptor.value,
            base: descriptor.base,
            user: descriptor.user,
            writable: descriptor.writable,
            mode: 'compat',
            revision: descriptor.revision,
            error,
        }, true);
    }
    setSnapshot(next, notify) {
        if (this.snapshot === next)
            return;
        this.snapshot = next;
        if (notify)
            this.listeners.forEach(listener => listener());
    }
}
export function createSettingsTransport(official, options) {
    return new SettingsTransportController(official, options.fetchFn, options.loopback);
}
//# sourceMappingURL=settings-transport.js.map