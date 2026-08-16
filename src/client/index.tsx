/** Dev-reloader client plugin and standard settings-card registration. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

import type { SupervisorConfig } from '../shared/config.js'
import { SettingsCard } from './SettingsCard.js'
import { createDevReloaderApi } from './api.js'
import type { SettingsCardFace } from './context-types.js'
import { en, zh } from './locales.js'
import { createSettingsTransport } from './settings-transport.js'

export const name = 'dsh-dev-reloader-client'
export const inject = ['slots', 'locale', 'settingsScope', 'connection', 'remote'] as const
export const NAMESPACE = 'dsh-dev-reloader'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dev-reloader.card', { zh, en }))

  const scope = ctx.settingsScope.bind<SupervisorConfig>({ namespace: NAMESPACE })
  const connection = ctx.get('connection') as { readonly isLoopback?: boolean } | undefined
  const fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined
  const transport = createSettingsTransport(scope, {
    ...(fetchFn === undefined ? {} : { fetchFn }),
    loopback: connection?.isLoopback !== false,
  })
  const api = createDevReloaderApi()

  const toFace = (): SettingsCardFace => ({
    hooks: { devReloader: transport },
    mutateSettings: (ops) => transport.mutate(ops),
    refreshSettings: () => transport.refresh(),
    command: (type, options) => api.command(type as never, options as never),
    getStatus: async () => {
      const status = await api.getStatus()
      return status.error === undefined
        ? { phase: status.phase }
        : { phase: status.phase, error: status.error }
    },
    getHealth: () => api.getHealth(),
  })

  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        id: 'dsh-dev-reloader',
        order: 40,
        locale: 'dev-reloader.card',
        inject: () => toFace(),
      },
      SettingsCard,
    ),
  )
}
