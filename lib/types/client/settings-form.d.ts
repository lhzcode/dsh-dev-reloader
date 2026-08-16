import type { SupervisorConfig } from '../shared/config.js';
import type { SettingsEditOp } from './settings-transport.js';
export interface SupervisorSettingsDraft {
    enabled: boolean;
    profile: string;
    sourceRoots: string;
    webUrl: string;
    debounceMs: string;
    healthTimeoutMs: string;
    shutdownGraceMs: string;
    bridgeGraceMs: string;
    crashWindowMs: string;
    maxCrashRestarts: string;
    ignored: string;
    projectOverrides: string;
    logLevel: string;
}
export type DraftErrors = Partial<Record<keyof SupervisorSettingsDraft, string>>;
export type ParsedSettingsDraft = {
    readonly ok: true;
    readonly value: SupervisorConfig;
} | {
    readonly ok: false;
    readonly errors: DraftErrors;
};
export type SettingsOpsResult = {
    readonly ok: true;
    readonly value: SupervisorConfig;
    readonly ops: readonly SettingsEditOp[];
} | {
    readonly ok: false;
    readonly errors: DraftErrors;
};
export declare const EDITABLE_SETTINGS_FIELDS: readonly ["enabled", "sourceRoots", "webUrl", "debounceMs", "healthTimeoutMs", "shutdownGraceMs", "bridgeGraceMs", "crashWindowMs", "maxCrashRestarts", "ignored", "projectOverrides", "logLevel"];
export declare function createSettingsDraft(config: SupervisorConfig): SupervisorSettingsDraft;
export declare function parseSettingsDraft(draft: SupervisorSettingsDraft): ParsedSettingsDraft;
export declare function settingsOpsFromDraft(current: SupervisorConfig, draft: SupervisorSettingsDraft): SettingsOpsResult;
export declare function resetSettingsOps(): readonly SettingsEditOp[];
//# sourceMappingURL=settings-form.d.ts.map