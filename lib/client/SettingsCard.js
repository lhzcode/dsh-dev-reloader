import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, } from 'react';
import { createSettingsDraft, resetSettingsOps, settingsOpsFromDraft, } from './settings-form.js';
import { RECOVERY_MARKER_KEY, decideRecovery, } from './reconnect.js';
import { en } from './locales.js';
const STATUS_INTERVAL_MS = 2_000;
const RECOVERY_INTERVAL_MS = 1_000;
const RESTARTING_PHASES = new Set(['pending-restart', 'restarting', 'recovering']);
function readMarker() {
    try {
        return sessionStorage.getItem(RECOVERY_MARKER_KEY) ?? undefined;
    }
    catch {
        return undefined;
    }
}
function writeMarker(bootId) {
    try {
        sessionStorage.setItem(RECOVERY_MARKER_KEY, bootId);
    }
    catch { /* restricted storage */ }
}
function clearMarker() {
    try {
        sessionStorage.removeItem(RECOVERY_MARKER_KEY);
    }
    catch { /* restricted storage */ }
}
function liveReload() {
    try {
        window.location.reload();
    }
    catch { /* unavailable in tests */ }
}
export function SettingsCard(props) {
    const settings = props.useDevReloader(state => state);
    const config = settings.value;
    const [draft, setDraft] = useState(() => (config === undefined ? undefined : createSettingsDraft(config)));
    const [draftBase, setDraftBase] = useState(config);
    const [draftRevision, setDraftRevision] = useState(settings.revision);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formErrors, setFormErrors] = useState({});
    const [formError, setFormError] = useState();
    const [confirmStage, setConfirmStage] = useState('none');
    const [commandError, setCommandError] = useState();
    const [status, setStatus] = useState();
    const [reloading, setReloading] = useState(false);
    const t = props.t;
    const label = (key) => t(key);
    useEffect(() => {
        if (!dirty && config !== undefined) {
            setDraft(createSettingsDraft(config));
            setDraftBase(config);
            setDraftRevision(settings.revision);
        }
    }, [config, dirty, settings.revision, settings.mode]);
    useEffect(() => {
        let disposed = false;
        const tick = async () => {
            try {
                const result = await props.getStatus();
                if (!disposed)
                    setStatus(result);
            }
            catch { /* transient status failure */ }
            try {
                await props.refreshSettings();
            }
            catch { /* transport renders its own error */ }
        };
        void tick();
        const timer = setInterval(() => void tick(), STATUS_INTERVAL_MS);
        return () => { disposed = true; clearInterval(timer); };
    }, [props.getStatus, props.refreshSettings]);
    const activePhase = status?.phase ?? 'unknown';
    const armed = useRef(false);
    useEffect(() => {
        let disposed = false;
        let timer;
        const restarting = RESTARTING_PHASES.has(activePhase);
        const marker = readMarker();
        if (!restarting) {
            if (marker !== undefined)
                clearMarker();
            return undefined;
        }
        if (!armed.current) {
            armed.current = true;
            if (marker === undefined) {
                void props.getHealth().then(probe => {
                    if (!disposed && probe.ok && probe.bootId)
                        writeMarker(probe.bootId);
                }).catch(() => undefined);
            }
        }
        const tick = async () => {
            if (disposed)
                return;
            let probe;
            try {
                const health = await props.getHealth();
                probe = { healthy: health.ok, bridgeReady: health.ok, bootId: health.bootId };
            }
            catch {
                probe = { healthy: false, bridgeReady: false, bootId: undefined };
            }
            if (disposed)
                return;
            const decision = decideRecovery({ phase: reloading ? 'reloading' : 'waiting', savedBootId: readMarker() }, probe);
            if (decision.type === 'reload') {
                setReloading(true);
                writeMarker(decision.bootId);
                setTimeout(liveReload, 0);
            }
            else if (decision.type === 'clear') {
                clearMarker();
                setReloading(false);
            }
        };
        void tick();
        timer = setInterval(() => void tick(), RECOVERY_INTERVAL_MS);
        return () => { disposed = true; if (timer !== undefined)
            clearInterval(timer); };
    }, [activePhase, props.getHealth, reloading]);
    const settingsReady = settings.status === 'ready' && config !== undefined && draft !== undefined;
    const settingsDisabled = !settingsReady || !settings.writable || saving;
    const commandDisabled = !settings.writable;
    const edit = (field, value) => {
        if (draft === undefined)
            return;
        setDraft({ ...draft, [field]: value });
        setDirty(true);
        setFormError(undefined);
        if (formErrors[field] !== undefined)
            setFormErrors({ ...formErrors, [field]: undefined });
    };
    const save = async () => {
        if (draftBase === undefined || draft === undefined)
            return;
        const result = settingsOpsFromDraft(draftBase, draft);
        if (!result.ok) {
            setFormErrors(result.errors);
            setFormError(label('validationError'));
            return;
        }
        if (result.ops.length === 0) {
            setDirty(false);
            setFormErrors({});
            setFormError(undefined);
            return;
        }
        setSaving(true);
        setFormErrors({});
        setFormError(undefined);
        try {
            await props.mutateSettings(result.ops, draftRevision);
            await props.refreshSettings();
            setDirty(false);
        }
        catch (error) {
            setFormError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setSaving(false);
        }
    };
    const reset = async () => {
        setSaving(true);
        setFormErrors({});
        setFormError(undefined);
        try {
            await props.mutateSettings(resetSettingsOps());
            await props.refreshSettings();
            setDirty(false);
        }
        catch (error) {
            setFormError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setSaving(false);
        }
    };
    const issue = async (type, options) => {
        try {
            const result = options === undefined ? await props.command(type) : await props.command(type, options);
            if (!result.ok)
                throw new Error(result.error ?? label('commandFailed'));
            setCommandError(undefined);
            setConfirmStage('none');
        }
        catch (error) {
            setCommandError(error instanceof Error ? error.message : String(error));
        }
    };
    return (_jsxs("article", { style: cardStyle, "data-testid": "dev-reloader-card", children: [_jsxs("header", { style: headerStyle, children: [_jsxs("div", { children: [_jsx("h3", { style: titleStyle, children: label('title') }), _jsx("p", { style: descriptionStyle, children: label('description') })] }), _jsxs("div", { style: badgesStyle, children: [settings.mode === 'compat' ? _jsx("span", { style: modeBadgeStyle, children: label('compatMode') }) : null, dirty ? _jsx("span", { style: dirtyBadgeStyle, children: label('unsaved') }) : null] })] }), settings.status === 'loading' ? _jsx("p", { style: noticeStyle, children: label('settingsLoading') }) : null, settings.status === 'unavailable' ? _jsx("p", { style: warningStyle, children: label('settingsUnavailable') }) : null, settings.status === 'ready' && !settings.writable ? _jsx("p", { style: warningStyle, children: label('readOnly') }) : null, settings.error ? _jsx("p", { style: errorStyle, children: settings.error }) : null, draft !== undefined ? (_jsxs("div", { style: formStyle, "aria-disabled": settingsDisabled, "data-testid": "dev-reloader-settings-form", children: [_jsxs(Section, { title: label('general'), children: [_jsxs("label", { style: toggleStyle, children: [_jsx("input", { "aria-label": label('enabled'), type: "checkbox", checked: draft.enabled, disabled: settingsDisabled, onChange: event => edit('enabled', event.target.checked) }), _jsx("span", { children: label('enabled') })] }), _jsx(Field, { label: label('profile'), children: _jsx("input", { "aria-label": label('profile'), style: inputStyle, value: draft.profile, disabled: true, readOnly: true }) }), _jsx(Field, { label: label('webUrl'), error: formErrors.webUrl, children: _jsx("input", { "aria-label": label('webUrl'), style: inputStyle, value: draft.webUrl, disabled: settingsDisabled, onChange: event => edit('webUrl', event.target.value) }) }), _jsx(Field, { label: label('logLevel'), error: formErrors.logLevel, children: _jsx("select", { "aria-label": label('logLevel'), style: inputStyle, value: draft.logLevel, disabled: settingsDisabled, onChange: event => edit('logLevel', event.target.value), children: ['debug', 'info', 'warn', 'error'].map(level => _jsx("option", { value: level, children: level }, level)) }) })] }), _jsxs(Section, { title: label('watch'), children: [_jsx(Field, { label: label('sourceRoots'), hint: label('sourceRootsHint'), wide: true, children: _jsx("textarea", { "aria-label": label('sourceRoots'), style: textareaStyle, rows: 3, value: draft.sourceRoots, disabled: settingsDisabled, onChange: event => edit('sourceRoots', event.target.value) }) }), _jsx(Field, { label: label('ignored'), hint: label('ignoredHint'), wide: true, children: _jsx("textarea", { "aria-label": label('ignored'), style: textareaStyle, rows: 3, value: draft.ignored, disabled: settingsDisabled, onChange: event => edit('ignored', event.target.value) }) }), _jsx(Field, { label: label('debounceMs'), error: formErrors.debounceMs, children: _jsx("input", { "aria-label": label('debounceMs'), style: inputStyle, inputMode: "numeric", value: draft.debounceMs, disabled: settingsDisabled, onChange: event => edit('debounceMs', event.target.value) }) })] }), _jsx(Section, { title: label('lifecycle'), children: ['healthTimeoutMs', 'shutdownGraceMs', 'bridgeGraceMs', 'crashWindowMs', 'maxCrashRestarts'].map(field => (_jsx(Field, { label: label(field), error: formErrors[field], children: _jsx("input", { "aria-label": label(field), style: inputStyle, inputMode: "numeric", value: draft[field], disabled: settingsDisabled, onChange: event => edit(field, event.target.value) }) }, field))) }), _jsx(Section, { title: label('advanced'), children: _jsx(Field, { label: label('projectOverrides'), hint: label('projectOverridesHint'), error: formErrors.projectOverrides, wide: true, children: _jsx("textarea", { "aria-label": label('projectOverrides'), style: { ...textareaStyle, fontFamily: 'ui-monospace, monospace' }, rows: 8, value: draft.projectOverrides, disabled: settingsDisabled, onChange: event => edit('projectOverrides', event.target.value) }) }) }), formError ? _jsx("p", { style: errorStyle, children: formError }) : null, _jsxs("div", { style: formActionsStyle, children: [_jsx("button", { type: "button", style: primaryButtonStyle, disabled: settingsDisabled || !dirty, onClick: () => void save(), children: saving ? label('saving') : label('save') }), _jsx("button", { type: "button", style: buttonStyle, disabled: settingsDisabled, onClick: () => void reset(), children: label('reset') })] })] })) : null, _jsxs(Section, { title: label('operational'), children: [_jsxs("div", { style: phaseRowStyle, children: [_jsx("span", { children: label('phase') }), _jsx("code", { style: phaseStyle, children: activePhase }), reloading ? _jsx("span", { children: label('recovering') }) : null] }), status?.error ? _jsx("p", { style: errorStyle, children: status.error }) : null, commandError ? _jsx("p", { style: errorStyle, children: commandError }) : null, _jsxs("div", { style: actionRowStyle, children: [_jsx("button", { type: "button", style: buttonStyle, disabled: commandDisabled, onClick: () => void issue('rebuild'), children: label('rebuild') }), confirmStage === 'none' ? _jsx("button", { type: "button", style: buttonStyle, disabled: commandDisabled, onClick: () => setConfirmStage('normal'), children: label('restart') }) : null, confirmStage === 'none' ? _jsx("button", { type: "button", style: dangerButtonStyle, disabled: commandDisabled, onClick: () => setConfirmStage('force-warn'), children: label('forceRestart') }) : null, confirmStage !== 'none' ? _jsx(RenderConfirm, { stage: confirmStage, label: label, onCancel: () => setConfirmStage('none'), onConfirm: () => {
                                    if (confirmStage === 'normal')
                                        void issue('restart', { force: false });
                                    else if (confirmStage === 'force-warn')
                                        setConfirmStage('force-armed');
                                    else
                                        void issue('restart', { force: true });
                                } }) : null] })] })] }));
}
function Section({ title, children }) {
    return _jsxs("section", { style: sectionStyle, children: [_jsx("h4", { style: sectionTitleStyle, children: title }), _jsx("div", { style: gridStyle, children: children })] });
}
function Field({ label, hint, error, wide, children }) {
    return _jsxs("label", { style: { ...fieldStyle, ...(wide ? wideFieldStyle : {}) }, children: [_jsx("span", { style: fieldLabelStyle, children: label }), children, hint ? _jsx("span", { style: hintStyle, children: hint }) : null, error ? _jsx("span", { style: errorStyle, children: error }) : null] });
}
function RenderConfirm({ stage, label, onConfirm, onCancel }) {
    const text = stage === 'normal' ? label('restart.confirm') : stage === 'force-warn' ? label('forceRestart.warn') : label('forceRestart.confirmAgain');
    const action = stage === 'normal' ? label('restart.confirmAction') : stage === 'force-warn' ? label('forceRestart.confirm') : label('forceRestart.confirmAgain');
    return _jsxs("span", { style: confirmStyle, children: [_jsx("span", { style: stage === 'normal' ? hintStyle : errorStyle, children: text }), _jsx("button", { type: "button", style: stage === 'normal' ? buttonStyle : dangerButtonStyle, onClick: onConfirm, children: action }), _jsx("button", { type: "button", style: buttonStyle, onClick: onCancel, children: label('cancel') })] });
}
const cardStyle = { display: 'flex', flexDirection: 'column', gap: 14, padding: 16, border: '1px solid var(--dsw-alias-stroke-subtle, rgba(127,127,127,.22))', borderRadius: 12, background: 'var(--dsw-alias-surface-raised, transparent)' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 };
const titleStyle = { margin: 0, fontSize: 17, lineHeight: 1.4 };
const descriptionStyle = { margin: '3px 0 0', color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 13 };
const badgesStyle = { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' };
const dirtyBadgeStyle = { padding: '2px 7px', borderRadius: 999, fontSize: 11, color: 'var(--dsw-alias-warning, #9a6700)', background: 'rgba(210,153,34,.12)' };
const modeBadgeStyle = { ...dirtyBadgeStyle, color: 'var(--dsw-alias-accent, #2563eb)', background: 'rgba(37,99,235,.1)' };
const formStyle = { display: 'flex', flexDirection: 'column', gap: 12 };
const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 9, padding: 12, borderRadius: 10, background: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,.055))' };
const sectionTitleStyle = { margin: 0, fontSize: 13, fontWeight: 650, color: 'var(--dsw-alias-label-secondary, inherit)' };
const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 };
const fieldStyle = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 };
const wideFieldStyle = { gridColumn: '1 / -1' };
const fieldLabelStyle = { fontSize: 12, fontWeight: 600 };
const hintStyle = { color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 11, lineHeight: 1.4 };
const inputStyle = { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '6px 9px', border: '1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))', borderRadius: 7, color: 'inherit', background: 'var(--dsw-alias-surface-primary, transparent)' };
const textareaStyle = { ...inputStyle, resize: 'vertical', lineHeight: 1.45 };
const toggleStyle = { ...fieldStyle, flexDirection: 'row', alignItems: 'center', alignSelf: 'center', minHeight: 34, fontSize: 13 };
const formActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8 };
const buttonStyle = { minHeight: 32, padding: '5px 10px', border: '1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))', borderRadius: 7, color: 'inherit', background: 'var(--dsw-alias-surface-primary, transparent)', cursor: 'pointer' };
const primaryButtonStyle = { ...buttonStyle, color: 'var(--dsw-alias-on-accent, white)', borderColor: 'transparent', background: 'var(--dsw-alias-accent, #2563eb)' };
const dangerButtonStyle = { ...buttonStyle, color: 'var(--dsw-alias-danger, #c0392b)' };
const phaseRowStyle = { display: 'flex', alignItems: 'center', gap: 8, gridColumn: '1 / -1', fontSize: 13 };
const phaseStyle = { fontWeight: 650 };
const actionRowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', gridColumn: '1 / -1' };
const confirmStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const noticeStyle = { margin: 0, color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 12 };
const warningStyle = { ...noticeStyle, color: 'var(--dsw-alias-warning, #9a6700)' };
const errorStyle = { margin: 0, color: 'var(--dsw-alias-danger, #c0392b)', fontSize: 12, wordBreak: 'break-word' };
//# sourceMappingURL=SettingsCard.js.map