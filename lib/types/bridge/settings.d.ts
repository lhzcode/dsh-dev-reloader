import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type SettingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings';
export declare const SETTINGS_PATH = "/plugins/dsh-dev-reloader/settings";
export declare const MAX_SETTINGS_BODY_BYTES: number;
export declare const MAX_SETTINGS_OPS = 64;
export interface SettingsBridgeDescriptor {
    readonly value: unknown;
    readonly base: unknown;
    readonly user: unknown;
    readonly revision: number;
    readonly writable: boolean;
}
export interface SettingsBridgeDependencies {
    readonly describe: () => SettingsBridgeDescriptor | undefined;
    readonly mutate: (ops: readonly SettingsPathOp[], expectedRevision?: number) => Promise<void>;
}
type ParsedMutation = {
    readonly ok: true;
    readonly ops: readonly SettingsPathOp[];
    readonly expectedRevision?: number;
} | {
    readonly ok: false;
    readonly status: number;
    readonly error: string;
};
export declare function parseSettingsMutation(text: string): ParsedMutation;
export declare function createSettingsRoute(deps: SettingsBridgeDependencies): WebRoute;
export interface SettingsBridgeSectionHooks<T> {
    readonly setSource: (current: () => T) => void;
    readonly onChange: () => void;
    readonly validate?: (value: T) => void;
}
/**
 * Register one canonical settings section and expose its redacted descriptor
 * through the rc.6 compatibility route. The route is only a transport adapter:
 * every read and write remains owned by the injected SettingsProvider.
 */
export declare function installSettingsBridgeSection<T>(ctx: Context, ns: SettingsNamespace, schema: z<T>, entry: T, registerRoute: (route: WebRoute) => () => void, hooks: SettingsBridgeSectionHooks<T>): void;
export {};
//# sourceMappingURL=settings.d.ts.map