/** Locale copy for the dev-reloader standard settings card. */
export declare const zh: {
    readonly title: "开发重载";
    readonly description: "本地开发自动重载、构建与安全重启";
    readonly unsaved: "未保存";
    readonly save: "保存";
    readonly saving: "保存中…";
    readonly reset: "重置为默认值";
    readonly general: "常规";
    readonly watch: "监听";
    readonly lifecycle: "生命周期";
    readonly advanced: "高级";
    readonly operational: "运行控制";
    readonly enabled: "启用守护器";
    readonly profile: "DSH 配置档案";
    readonly webUrl: "Web 地址";
    readonly logLevel: "日志级别";
    readonly sourceRoots: "源码目录";
    readonly sourceRootsHint: "每行一个绝对路径；留空时自动发现。";
    readonly ignored: "忽略规则";
    readonly ignoredHint: "每行一个 glob 或路径。";
    readonly debounceMs: "防抖时间（毫秒）";
    readonly healthTimeoutMs: "健康检查超时（毫秒）";
    readonly shutdownGraceMs: "关闭宽限期（毫秒）";
    readonly bridgeGraceMs: "桥接宽限期（毫秒）";
    readonly crashWindowMs: "崩溃统计窗口（毫秒）";
    readonly maxCrashRestarts: "最大崩溃重启次数";
    readonly projectOverrides: "项目命令覆盖（JSON）";
    readonly projectOverridesHint: "JSON 数组；每项包含 root，可选 build 与 devWeb。";
    readonly phase: "阶段";
    readonly rebuild: "重建";
    readonly restart: "重启";
    readonly 'restart.confirm': "确认重启？";
    readonly 'restart.confirmAction': "确认";
    readonly forceRestart: "强制重启";
    readonly 'forceRestart.warn': "强制重启会立即中断当前进行中的任务。";
    readonly 'forceRestart.confirm': "确认强制";
    readonly 'forceRestart.confirmAgain': "再次确认：中断所有进行中的工作？";
    readonly cancel: "取消";
    readonly readOnly: "当前配置文档只读。";
    readonly settingsLoading: "正在加载插件配置…";
    readonly settingsUnavailable: "无法读取插件配置；状态与重载命令仍可使用。";
    readonly compatMode: "使用 rc.6 本机兼容通道";
    readonly commandFailed: "命令执行失败";
    readonly recovering: "服务恢复中，刷新中…";
    readonly validationError: "请修正标记的配置项。";
};
export type DevReloaderCardKey = keyof typeof zh;
export type DevReloaderCardLocale = {
    readonly [key in DevReloaderCardKey]: string;
};
export declare const en: DevReloaderCardLocale;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'dev-reloader.card': DevReloaderCardKey;
    }
}
//# sourceMappingURL=locales.d.ts.map