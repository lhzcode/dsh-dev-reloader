import { SettingsCard } from './SettingsCard.js';
import { createDevReloaderApi } from './api.js';
import { en, zh } from './locales.js';
import { createSettingsTransport } from './settings-transport.js';
export const name = 'dsh-dev-reloader-client';
export const inject = ['slots', 'locale', 'settingsScope', 'connection', 'remote'];
export const NAMESPACE = 'dsh-dev-reloader';
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register('dev-reloader.card', { zh, en }));
    const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
    const connection = ctx.get('connection');
    const fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
    const transport = createSettingsTransport(scope, {
        ...(fetchFn === undefined ? {} : { fetchFn }),
        loopback: connection?.isLoopback !== false,
    });
    const api = createDevReloaderApi();
    const toFace = () => ({
        hooks: { devReloader: transport },
        mutateSettings: (ops) => transport.mutate(ops),
        refreshSettings: () => transport.refresh(),
        command: (type, options) => api.command(type, options),
        getStatus: async () => {
            const status = await api.getStatus();
            return status.error === undefined
                ? { phase: status.phase }
                : { phase: status.phase, error: status.error };
        },
        getHealth: () => api.getHealth(),
    });
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-dev-reloader',
        order: 40,
        locale: 'dev-reloader.card',
        inject: () => toFace(),
    }, SettingsCard));
}
//# sourceMappingURL=index.js.map