import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { SupervisorConfig } from '../shared/config.js'
import type { SettingsCardFace } from './context-types.js'
import {
  createSettingsDraft,
  resetSettingsOps,
  settingsOpsFromDraft,
  type DraftErrors,
  type SupervisorSettingsDraft,
} from './settings-form.js'
import {
  RECOVERY_MARKER_KEY,
  type RecoveryDecision,
  type RecoveryProbe,
  decideRecovery,
} from './reconnect.js'
import { en } from './locales.js'

const STATUS_INTERVAL_MS = 2_000
const RECOVERY_INTERVAL_MS = 1_000
const RESTARTING_PHASES = new Set(['pending-restart', 'restarting', 'recovering'])
type ConfirmStage = 'none' | 'normal' | 'force-warn' | 'force-armed'

export type SettingsCardProps = PropsRuntime<'settings.plugin.item'> &
  PropsLocale<'dev-reloader.card'> &
  InjectFace<SettingsCardFace>

function readMarker(): string | undefined {
  try { return sessionStorage.getItem(RECOVERY_MARKER_KEY) ?? undefined } catch { return undefined }
}
function writeMarker(bootId: string): void {
  try { sessionStorage.setItem(RECOVERY_MARKER_KEY, bootId) } catch { /* restricted storage */ }
}
function clearMarker(): void {
  try { sessionStorage.removeItem(RECOVERY_MARKER_KEY) } catch { /* restricted storage */ }
}
function liveReload(): void {
  try { window.location.reload() } catch { /* unavailable in tests */ }
}

export function SettingsCard(props: SettingsCardProps): ReactNode {
  const settings = props.useDevReloader(state => state)
  const config = settings.value
  const [draft, setDraft] = useState<SupervisorSettingsDraft | undefined>(() => (
    config === undefined ? undefined : createSettingsDraft(config)
  ))
  const [draftBase, setDraftBase] = useState<SupervisorConfig | undefined>(config)
  const [draftRevision, setDraftRevision] = useState<number | undefined>(settings.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formErrors, setFormErrors] = useState<DraftErrors>({})
  const [formError, setFormError] = useState<string | undefined>()
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>('none')
  const [commandError, setCommandError] = useState<string | undefined>()
  const [status, setStatus] = useState<{ phase: string; error?: string }>()
  const [reloading, setReloading] = useState(false)
  const t = props.t
  const label = (key: keyof typeof en): string => t(key)

  useEffect(() => {
    if (!dirty && config !== undefined) {
      setDraft(createSettingsDraft(config))
      setDraftBase(config)
      setDraftRevision(settings.revision)
    }
  }, [config, dirty, settings.revision, settings.mode])

  useEffect(() => {
    let disposed = false
    const tick = async (): Promise<void> => {
      try {
        const result = await props.getStatus()
        if (!disposed) setStatus(result)
      } catch { /* transient status failure */ }
      try { await props.refreshSettings() } catch { /* transport renders its own error */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), STATUS_INTERVAL_MS)
    return () => { disposed = true; clearInterval(timer) }
  }, [props.getStatus, props.refreshSettings])

  const activePhase = status?.phase ?? 'unknown'
  const armed = useRef(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    const restarting = RESTARTING_PHASES.has(activePhase)
    const marker = readMarker()
    if (!restarting) {
      if (marker !== undefined) clearMarker()
      return undefined
    }
    if (!armed.current) {
      armed.current = true
      if (marker === undefined) {
        void props.getHealth().then(probe => {
          if (!disposed && probe.ok && probe.bootId) writeMarker(probe.bootId)
        }).catch(() => undefined)
      }
    }
    const tick = async (): Promise<void> => {
      if (disposed) return
      let probe: RecoveryProbe
      try {
        const health = await props.getHealth()
        probe = { healthy: health.ok, bridgeReady: health.ok, bootId: health.bootId }
      } catch {
        probe = { healthy: false, bridgeReady: false, bootId: undefined }
      }
      if (disposed) return
      const decision: RecoveryDecision = decideRecovery(
        { phase: reloading ? 'reloading' : 'waiting', savedBootId: readMarker() },
        probe,
      )
      if (decision.type === 'reload') {
        setReloading(true)
        writeMarker(decision.bootId)
        setTimeout(liveReload, 0)
      } else if (decision.type === 'clear') {
        clearMarker()
        setReloading(false)
      }
    }
    void tick()
    timer = setInterval(() => void tick(), RECOVERY_INTERVAL_MS)
    return () => { disposed = true; if (timer !== undefined) clearInterval(timer) }
  }, [activePhase, props.getHealth, reloading])

  const settingsReady = settings.status === 'ready' && config !== undefined && draft !== undefined
  const settingsDisabled = !settingsReady || !settings.writable || saving
  const commandDisabled = !settings.writable

  const edit = <K extends keyof SupervisorSettingsDraft>(field: K, value: SupervisorSettingsDraft[K]): void => {
    if (draft === undefined) return
    setDraft({ ...draft, [field]: value })
    setDirty(true)
    setFormError(undefined)
    if (formErrors[field] !== undefined) setFormErrors({ ...formErrors, [field]: undefined })
  }

  const save = async (): Promise<void> => {
    if (draftBase === undefined || draft === undefined) return
    const result = settingsOpsFromDraft(draftBase, draft)
    if (!result.ok) {
      setFormErrors(result.errors)
      setFormError(label('validationError'))
      return
    }
    if (result.ops.length === 0) {
      setDirty(false)
      setFormErrors({})
      setFormError(undefined)
      return
    }
    setSaving(true)
    setFormErrors({})
    setFormError(undefined)
    try {
      await props.mutateSettings(result.ops, draftRevision)
      await props.refreshSettings()
      setDirty(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    setSaving(true)
    setFormErrors({})
    setFormError(undefined)
    try {
      await props.mutateSettings(resetSettingsOps())
      await props.refreshSettings()
      setDirty(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const issue = async (type: Parameters<typeof props.command>[0], options?: { force?: boolean }): Promise<void> => {
    try {
      const result = options === undefined ? await props.command(type) : await props.command(type, options)
      if (!result.ok) throw new Error(result.error ?? label('commandFailed'))
      setCommandError(undefined)
      setConfirmStage('none')
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article style={cardStyle} data-testid="dev-reloader-card">
      <header style={headerStyle}>
        <div>
          <h3 style={titleStyle}>{label('title')}</h3>
          <p style={descriptionStyle}>{label('description')}</p>
        </div>
        <div style={badgesStyle}>
          {settings.mode === 'compat' ? <span style={modeBadgeStyle}>{label('compatMode')}</span> : null}
          {dirty ? <span style={dirtyBadgeStyle}>{label('unsaved')}</span> : null}
        </div>
      </header>

      {settings.status === 'loading' ? <p style={noticeStyle}>{label('settingsLoading')}</p> : null}
      {settings.status === 'unavailable' ? <p style={warningStyle}>{label('settingsUnavailable')}</p> : null}
      {settings.status === 'ready' && !settings.writable ? <p style={warningStyle}>{label('readOnly')}</p> : null}
      {settings.error ? <p style={errorStyle}>{settings.error}</p> : null}

      {draft !== undefined ? (
        <div style={formStyle} aria-disabled={settingsDisabled} data-testid="dev-reloader-settings-form">
          <Section title={label('general')}>
            <label style={toggleStyle}>
              <input aria-label={label('enabled')} type="checkbox" checked={draft.enabled} disabled={settingsDisabled}
                onChange={event => edit('enabled', event.target.checked)} />
              <span>{label('enabled')}</span>
            </label>
            <Field label={label('profile')}>
              <input aria-label={label('profile')} style={inputStyle} value={draft.profile} disabled readOnly />
            </Field>
            <Field label={label('webUrl')} error={formErrors.webUrl}>
              <input aria-label={label('webUrl')} style={inputStyle} value={draft.webUrl} disabled={settingsDisabled}
                onChange={event => edit('webUrl', event.target.value)} />
            </Field>
            <Field label={label('logLevel')} error={formErrors.logLevel}>
              <select aria-label={label('logLevel')} style={inputStyle} value={draft.logLevel} disabled={settingsDisabled}
                onChange={event => edit('logLevel', event.target.value)}>
                {['debug', 'info', 'warn', 'error'].map(level => <option key={level} value={level}>{level}</option>)}
              </select>
            </Field>
          </Section>

          <Section title={label('watch')}>
            <Field label={label('sourceRoots')} hint={label('sourceRootsHint')} wide>
              <textarea aria-label={label('sourceRoots')} style={textareaStyle} rows={3} value={draft.sourceRoots}
                disabled={settingsDisabled} onChange={event => edit('sourceRoots', event.target.value)} />
            </Field>
            <Field label={label('ignored')} hint={label('ignoredHint')} wide>
              <textarea aria-label={label('ignored')} style={textareaStyle} rows={3} value={draft.ignored}
                disabled={settingsDisabled} onChange={event => edit('ignored', event.target.value)} />
            </Field>
            <Field label={label('debounceMs')} error={formErrors.debounceMs}>
              <input aria-label={label('debounceMs')} style={inputStyle} inputMode="numeric" value={draft.debounceMs}
                disabled={settingsDisabled} onChange={event => edit('debounceMs', event.target.value)} />
            </Field>
          </Section>

          <Section title={label('lifecycle')}>
            {(['healthTimeoutMs', 'shutdownGraceMs', 'bridgeGraceMs', 'crashWindowMs', 'maxCrashRestarts'] as const).map(field => (
              <Field key={field} label={label(field)} error={formErrors[field]}>
                <input aria-label={label(field)} style={inputStyle} inputMode="numeric" value={draft[field]}
                  disabled={settingsDisabled} onChange={event => edit(field, event.target.value)} />
              </Field>
            ))}
          </Section>

          <Section title={label('advanced')}>
            <Field label={label('projectOverrides')} hint={label('projectOverridesHint')} error={formErrors.projectOverrides} wide>
              <textarea aria-label={label('projectOverrides')} style={{ ...textareaStyle, fontFamily: 'ui-monospace, monospace' }}
                rows={8} value={draft.projectOverrides} disabled={settingsDisabled}
                onChange={event => edit('projectOverrides', event.target.value)} />
            </Field>
          </Section>

          {formError ? <p style={errorStyle}>{formError}</p> : null}
          <div style={formActionsStyle}>
            <button type="button" style={primaryButtonStyle} disabled={settingsDisabled || !dirty} onClick={() => void save()}>
              {saving ? label('saving') : label('save')}
            </button>
            <button type="button" style={buttonStyle} disabled={settingsDisabled} onClick={() => void reset()}>
              {label('reset')}
            </button>
          </div>
        </div>
      ) : null}

      <Section title={label('operational')}>
        <div style={phaseRowStyle}>
          <span>{label('phase')}</span>
          <code style={phaseStyle}>{activePhase}</code>
          {reloading ? <span>{label('recovering')}</span> : null}
        </div>
        {status?.error ? <p style={errorStyle}>{status.error}</p> : null}
        {commandError ? <p style={errorStyle}>{commandError}</p> : null}
        <div style={actionRowStyle}>
          <button type="button" style={buttonStyle} disabled={commandDisabled} onClick={() => void issue('rebuild')}>{label('rebuild')}</button>
          {confirmStage === 'none' ? <button type="button" style={buttonStyle} disabled={commandDisabled} onClick={() => setConfirmStage('normal')}>{label('restart')}</button> : null}
          {confirmStage === 'none' ? <button type="button" style={dangerButtonStyle} disabled={commandDisabled} onClick={() => setConfirmStage('force-warn')}>{label('forceRestart')}</button> : null}
          {confirmStage !== 'none' ? <RenderConfirm stage={confirmStage} label={label}
            onCancel={() => setConfirmStage('none')}
            onConfirm={() => {
              if (confirmStage === 'normal') void issue('restart', { force: false })
              else if (confirmStage === 'force-warn') setConfirmStage('force-armed')
              else void issue('restart', { force: true })
            }} /> : null}
        </div>
      </Section>
    </article>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return <section style={sectionStyle}><h4 style={sectionTitleStyle}>{title}</h4><div style={gridStyle}>{children}</div></section>
}
function Field({ label, hint, error, wide, children }: { label: string; hint?: string | undefined; error?: string | undefined; wide?: boolean | undefined; children: ReactNode }): ReactNode {
  return <label style={{ ...fieldStyle, ...(wide ? wideFieldStyle : {}) }}><span style={fieldLabelStyle}>{label}</span>{children}{hint ? <span style={hintStyle}>{hint}</span> : null}{error ? <span style={errorStyle}>{error}</span> : null}</label>
}
function RenderConfirm({ stage, label, onConfirm, onCancel }: { stage: ConfirmStage; label: (key: keyof typeof en) => string; onConfirm: () => void; onCancel: () => void }): ReactNode {
  const text = stage === 'normal' ? label('restart.confirm') : stage === 'force-warn' ? label('forceRestart.warn') : label('forceRestart.confirmAgain')
  const action = stage === 'normal' ? label('restart.confirmAction') : stage === 'force-warn' ? label('forceRestart.confirm') : label('forceRestart.confirmAgain')
  return <span style={confirmStyle}><span style={stage === 'normal' ? hintStyle : errorStyle}>{text}</span><button type="button" style={stage === 'normal' ? buttonStyle : dangerButtonStyle} onClick={onConfirm}>{action}</button><button type="button" style={buttonStyle} onClick={onCancel}>{label('cancel')}</button></span>
}

const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: 16, border: '1px solid var(--dsw-alias-stroke-subtle, rgba(127,127,127,.22))', borderRadius: 12, background: 'var(--dsw-alias-surface-raised, transparent)' }
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 17, lineHeight: 1.4 }
const descriptionStyle: CSSProperties = { margin: '3px 0 0', color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 13 }
const badgesStyle: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }
const dirtyBadgeStyle: CSSProperties = { padding: '2px 7px', borderRadius: 999, fontSize: 11, color: 'var(--dsw-alias-warning, #9a6700)', background: 'rgba(210,153,34,.12)' }
const modeBadgeStyle: CSSProperties = { ...dirtyBadgeStyle, color: 'var(--dsw-alias-accent, #2563eb)', background: 'rgba(37,99,235,.1)' }
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 9, padding: 12, borderRadius: 10, background: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,.055))' }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 650, color: 'var(--dsw-alias-label-secondary, inherit)' }
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }
const fieldStyle: CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }
const wideFieldStyle: CSSProperties = { gridColumn: '1 / -1' }
const fieldLabelStyle: CSSProperties = { fontSize: 12, fontWeight: 600 }
const hintStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 11, lineHeight: 1.4 }
const inputStyle: CSSProperties = { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '6px 9px', border: '1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))', borderRadius: 7, color: 'inherit', background: 'var(--dsw-alias-surface-primary, transparent)' }
const textareaStyle: CSSProperties = { ...inputStyle, resize: 'vertical', lineHeight: 1.45 }
const toggleStyle: CSSProperties = { ...fieldStyle, flexDirection: 'row', alignItems: 'center', alignSelf: 'center', minHeight: 34, fontSize: 13 }
const formActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const buttonStyle: CSSProperties = { minHeight: 32, padding: '5px 10px', border: '1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))', borderRadius: 7, color: 'inherit', background: 'var(--dsw-alias-surface-primary, transparent)', cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, color: 'var(--dsw-alias-on-accent, white)', borderColor: 'transparent', background: 'var(--dsw-alias-accent, #2563eb)' }
const dangerButtonStyle: CSSProperties = { ...buttonStyle, color: 'var(--dsw-alias-danger, #c0392b)' }
const phaseRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, gridColumn: '1 / -1', fontSize: 13 }
const phaseStyle: CSSProperties = { fontWeight: 650 }
const actionRowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', gridColumn: '1 / -1' }
const confirmStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const noticeStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 12 }
const warningStyle: CSSProperties = { ...noticeStyle, color: 'var(--dsw-alias-warning, #9a6700)' }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-danger, #c0392b)', fontSize: 12, wordBreak: 'break-word' }
