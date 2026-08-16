window.__ModuleLoader__.load({
	id: "dsh-dev-reloader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/settings-form.ts
		const EDITABLE_SETTINGS_FIELDS = [
			"enabled",
			"sourceRoots",
			"webUrl",
			"debounceMs",
			"healthTimeoutMs",
			"shutdownGraceMs",
			"bridgeGraceMs",
			"crashWindowMs",
			"maxCrashRestarts",
			"ignored",
			"projectOverrides",
			"logLevel"
		];
		const NATURAL_FIELDS = [
			"debounceMs",
			"healthTimeoutMs",
			"shutdownGraceMs",
			"bridgeGraceMs",
			"crashWindowMs",
			"maxCrashRestarts"
		];
		const LOG_LEVELS = /* @__PURE__ */ new Set([
			"debug",
			"info",
			"warn",
			"error"
		]);
		function lines(value) {
			return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
		}
		function natural(value) {
			const normalized = value.trim();
			if (!/^\d+$/u.test(normalized)) return void 0;
			const parsed = Number(normalized);
			return Number.isSafeInteger(parsed) ? parsed : void 0;
		}
		function isRecord$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function validCommand(value) {
			if (!isRecord$1(value)) return false;
			return (value.executable === void 0 || typeof value.executable === "string") && (value.cwd === void 0 || typeof value.cwd === "string") && (value.args === void 0 || Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"));
		}
		function validProjectOverrides(value) {
			return Array.isArray(value) && value.every((entry) => isRecord$1(entry) && typeof entry.root === "string" && entry.root.length > 0 && (entry.build === void 0 || validCommand(entry.build)) && (entry.devWeb === void 0 || validCommand(entry.devWeb)));
		}
		function equalJson(left, right) {
			return JSON.stringify(left) === JSON.stringify(right);
		}
		function createSettingsDraft(config) {
			return {
				enabled: config.enabled,
				profile: config.profile,
				sourceRoots: config.sourceRoots.join("\n"),
				webUrl: config.webUrl ?? "",
				debounceMs: String(config.debounceMs),
				healthTimeoutMs: String(config.healthTimeoutMs),
				shutdownGraceMs: String(config.shutdownGraceMs),
				bridgeGraceMs: String(config.bridgeGraceMs),
				crashWindowMs: String(config.crashWindowMs),
				maxCrashRestarts: String(config.maxCrashRestarts),
				ignored: config.ignored.join("\n"),
				projectOverrides: JSON.stringify(config.projectOverrides, null, 2),
				logLevel: config.logLevel
			};
		}
		function parseSettingsDraft(draft) {
			const errors = {};
			const numbers = {};
			for (const field of NATURAL_FIELDS) {
				const value = natural(draft[field]);
				if (value === void 0) errors[field] = "Enter a non-negative integer.";
				else numbers[field] = value;
			}
			let webUrl;
			const rawUrl = draft.webUrl.trim();
			if (rawUrl !== "") try {
				const parsed = new URL(rawUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
				webUrl = rawUrl;
			} catch {
				errors.webUrl = "Enter an absolute HTTP or HTTPS URL.";
			}
			let projectOverrides = [];
			try {
				const parsed = JSON.parse(draft.projectOverrides.trim() || "[]");
				if (!validProjectOverrides(parsed)) throw new Error("shape");
				projectOverrides = parsed;
			} catch {
				errors.projectOverrides = "Enter a JSON array of project override objects.";
			}
			if (!LOG_LEVELS.has(draft.logLevel)) errors.logLevel = "Choose debug, info, warn, or error.";
			if (Object.keys(errors).length > 0) return {
				ok: false,
				errors
			};
			return {
				ok: true,
				value: {
					enabled: draft.enabled,
					profile: draft.profile,
					sourceRoots: lines(draft.sourceRoots),
					...webUrl === void 0 ? {} : { webUrl },
					debounceMs: numbers.debounceMs,
					healthTimeoutMs: numbers.healthTimeoutMs,
					shutdownGraceMs: numbers.shutdownGraceMs,
					bridgeGraceMs: numbers.bridgeGraceMs,
					crashWindowMs: numbers.crashWindowMs,
					maxCrashRestarts: numbers.maxCrashRestarts,
					ignored: lines(draft.ignored),
					projectOverrides,
					logLevel: draft.logLevel
				}
			};
		}
		function settingsOpsFromDraft(current, draft) {
			const parsed = parseSettingsDraft(draft);
			if (!parsed.ok) return parsed;
			const next = parsed.value;
			const ops = [];
			for (const field of EDITABLE_SETTINGS_FIELDS) {
				if (equalJson(current[field], next[field])) continue;
				if (field === "webUrl" && next.webUrl === void 0) ops.push({
					op: "unset",
					path: [field]
				});
				else ops.push({
					op: "set",
					path: [field],
					value: next[field]
				});
			}
			return {
				ok: true,
				value: next,
				ops
			};
		}
		function resetSettingsOps() {
			return EDITABLE_SETTINGS_FIELDS.map((field) => ({
				op: "unset",
				path: [field]
			}));
		}
		//#endregion
		//#region src/client/reconnect.ts
		/**
		* Once-only recovery decision for the browser settings card.
		*
		* The client plugin never contacts the supervisor or the daemon directly. After
		* the host announces an imminent full restart it records the current host
		* boot id in this page's sessionStorage (marker key `dsh.devReloader.recovery.v1`)
		* and begins polling the same-origin health/bridge surfaces through the typed
		* API helpers. Each poll feeds {@link decideRecovery} a state plus a probe; the
		* decision tells the card whether to keep waiting, perform a single
		* `location.reload()`, or clear the recovery marker once the reload landed
		* through a fresh page generation.
		*
		* The pure decision rule guarantees the "once-only" property: a reload is
		* requested exactly when a *new* boot id is healthy and bridge-ready and the
		* page is not already reloading. Any repetition of the same probe therefore
		* never yields a second reload.
		*/
		/** Marker key stored in sessionStorage while recovery is pending. */
		const RECOVERY_MARKER_KEY = "dsh.devReloader.recovery.v1";
		/**
		* Decide the next recovery action from a state/probe pair.
		*
		* - unhealthy or bridge-absent or unknown boot id → stay (keep waiting)
		* - already `reloading` and a healthy bridge-ready boot id is present → clear
		*   the marker: the single reload already replaced this generation, so any
		*   subsequent probe must never reload again.
		* - same boot id as the saved one while still `waiting` → stay (not yet changed)
		* - new boot id, healthy and bridge-ready while `waiting` → request the reload
		*/
		function decideRecovery(state, probe) {
			if (!probe.healthy || !probe.bridgeReady || probe.bootId === void 0) return { type: "stay" };
			if (state.phase === "reloading") return { type: "clear" };
			if (state.savedBootId !== void 0 && probe.bootId === state.savedBootId) return { type: "stay" };
			return {
				type: "reload",
				bootId: probe.bootId
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/** Locale copy for the dev-reloader standard settings card. */
		const zh = {
			title: "开发重载",
			description: "本地开发自动重载、构建与安全重启",
			unsaved: "未保存",
			save: "保存",
			saving: "保存中…",
			reset: "重置为默认值",
			general: "常规",
			watch: "监听",
			lifecycle: "生命周期",
			advanced: "高级",
			operational: "运行控制",
			enabled: "启用守护器",
			profile: "DSH 配置档案",
			webUrl: "Web 地址",
			logLevel: "日志级别",
			sourceRoots: "源码目录",
			sourceRootsHint: "每行一个绝对路径；留空时自动发现。",
			ignored: "忽略规则",
			ignoredHint: "每行一个 glob 或路径。",
			debounceMs: "防抖时间（毫秒）",
			healthTimeoutMs: "健康检查超时（毫秒）",
			shutdownGraceMs: "关闭宽限期（毫秒）",
			bridgeGraceMs: "桥接宽限期（毫秒）",
			crashWindowMs: "崩溃统计窗口（毫秒）",
			maxCrashRestarts: "最大崩溃重启次数",
			projectOverrides: "项目命令覆盖（JSON）",
			projectOverridesHint: "JSON 数组；每项包含 root，可选 build 与 devWeb。",
			phase: "阶段",
			rebuild: "重建",
			restart: "重启",
			"restart.confirm": "确认重启？",
			"restart.confirmAction": "确认",
			forceRestart: "强制重启",
			"forceRestart.warn": "强制重启会立即中断当前进行中的任务。",
			"forceRestart.confirm": "确认强制",
			"forceRestart.confirmAgain": "再次确认：中断所有进行中的工作？",
			cancel: "取消",
			readOnly: "当前配置文档只读。",
			settingsLoading: "正在加载插件配置…",
			settingsUnavailable: "无法读取插件配置；状态与重载命令仍可使用。",
			compatMode: "使用 rc.6 本机兼容通道",
			commandFailed: "命令执行失败",
			recovering: "服务恢复中，刷新中…",
			validationError: "请修正标记的配置项。"
		};
		const en = {
			title: "Dev Reloader",
			description: "Local development auto reload, build, and safe restart",
			unsaved: "Unsaved",
			save: "Save",
			saving: "Saving…",
			reset: "Reset to defaults",
			general: "General",
			watch: "Watch",
			lifecycle: "Lifecycle",
			advanced: "Advanced",
			operational: "Operations",
			enabled: "Enable daemon",
			profile: "DSH profile",
			webUrl: "Web URL",
			logLevel: "Log level",
			sourceRoots: "Source roots",
			sourceRootsHint: "One absolute path per line; leave empty for discovery.",
			ignored: "Ignored paths",
			ignoredHint: "One glob or path per line.",
			debounceMs: "Debounce (ms)",
			healthTimeoutMs: "Health timeout (ms)",
			shutdownGraceMs: "Shutdown grace (ms)",
			bridgeGraceMs: "Bridge grace (ms)",
			crashWindowMs: "Crash window (ms)",
			maxCrashRestarts: "Maximum crash restarts",
			projectOverrides: "Project command overrides (JSON)",
			projectOverridesHint: "JSON array; each item has root and optional build/devWeb.",
			phase: "Phase",
			rebuild: "Rebuild",
			restart: "Restart",
			"restart.confirm": "Restart anyway?",
			"restart.confirmAction": "Confirm",
			forceRestart: "Force restart",
			"forceRestart.warn": "A force restart immediately interrupts active work.",
			"forceRestart.confirm": "Force",
			"forceRestart.confirmAgain": "Confirm again: interrupt all in-progress jobs?",
			cancel: "Cancel",
			readOnly: "The settings document is read-only.",
			settingsLoading: "Loading plugin settings…",
			settingsUnavailable: "Plugin settings could not be loaded; status and reload commands remain available.",
			compatMode: "Using the local rc.6 compatibility channel",
			commandFailed: "Command failed",
			recovering: "Service recovering, refreshing…",
			validationError: "Correct the highlighted settings."
		};
		//#endregion
		//#region src/client/SettingsCard.tsx
		const STATUS_INTERVAL_MS = 2e3;
		const RECOVERY_INTERVAL_MS = 1e3;
		const RESTARTING_PHASES = /* @__PURE__ */ new Set([
			"pending-restart",
			"restarting",
			"recovering"
		]);
		function readMarker() {
			try {
				return sessionStorage.getItem("dsh.devReloader.recovery.v1") ?? void 0;
			} catch {
				return;
			}
		}
		function writeMarker(bootId) {
			try {
				sessionStorage.setItem(RECOVERY_MARKER_KEY, bootId);
			} catch {}
		}
		function clearMarker() {
			try {
				sessionStorage.removeItem(RECOVERY_MARKER_KEY);
			} catch {}
		}
		function liveReload() {
			try {
				window.location.reload();
			} catch {}
		}
		function SettingsCard(props) {
			const settings = props.useDevReloader((state) => state);
			const config = settings.value;
			const [draft, setDraft] = (0, react.useState)(() => config === void 0 ? void 0 : createSettingsDraft(config));
			const [draftBase, setDraftBase] = (0, react.useState)(config);
			const [draftRevision, setDraftRevision] = (0, react.useState)(settings.revision);
			const [dirty, setDirty] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [formErrors, setFormErrors] = (0, react.useState)({});
			const [formError, setFormError] = (0, react.useState)();
			const [confirmStage, setConfirmStage] = (0, react.useState)("none");
			const [commandError, setCommandError] = (0, react.useState)();
			const [status, setStatus] = (0, react.useState)();
			const [reloading, setReloading] = (0, react.useState)(false);
			const t = props.t;
			const label = (key) => t(key);
			(0, react.useEffect)(() => {
				if (!dirty && config !== void 0) {
					setDraft(createSettingsDraft(config));
					setDraftBase(config);
					setDraftRevision(settings.revision);
				}
			}, [
				config,
				dirty,
				settings.revision,
				settings.mode
			]);
			(0, react.useEffect)(() => {
				let disposed = false;
				const tick = async () => {
					try {
						const result = await props.getStatus();
						if (!disposed) setStatus(result);
					} catch {}
					try {
						await props.refreshSettings();
					} catch {}
				};
				tick();
				const timer = setInterval(() => void tick(), STATUS_INTERVAL_MS);
				return () => {
					disposed = true;
					clearInterval(timer);
				};
			}, [props.getStatus, props.refreshSettings]);
			const activePhase = status?.phase ?? "unknown";
			const armed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				let disposed = false;
				let timer;
				const restarting = RESTARTING_PHASES.has(activePhase);
				const marker = readMarker();
				if (!restarting) {
					if (marker !== void 0) clearMarker();
					return;
				}
				if (!armed.current) {
					armed.current = true;
					if (marker === void 0) props.getHealth().then((probe) => {
						if (!disposed && probe.ok && probe.bootId) writeMarker(probe.bootId);
					}).catch(() => void 0);
				}
				const tick = async () => {
					if (disposed) return;
					let probe;
					try {
						const health = await props.getHealth();
						probe = {
							healthy: health.ok,
							bridgeReady: health.ok,
							bootId: health.bootId
						};
					} catch {
						probe = {
							healthy: false,
							bridgeReady: false,
							bootId: void 0
						};
					}
					if (disposed) return;
					const decision = decideRecovery({
						phase: reloading ? "reloading" : "waiting",
						savedBootId: readMarker()
					}, probe);
					if (decision.type === "reload") {
						setReloading(true);
						writeMarker(decision.bootId);
						setTimeout(liveReload, 0);
					} else if (decision.type === "clear") {
						clearMarker();
						setReloading(false);
					}
				};
				tick();
				timer = setInterval(() => void tick(), RECOVERY_INTERVAL_MS);
				return () => {
					disposed = true;
					if (timer !== void 0) clearInterval(timer);
				};
			}, [
				activePhase,
				props.getHealth,
				reloading
			]);
			const settingsDisabled = !(settings.status === "ready" && config !== void 0 && draft !== void 0) || !settings.writable || saving;
			const commandDisabled = !settings.writable;
			const edit = (field, value) => {
				if (draft === void 0) return;
				setDraft({
					...draft,
					[field]: value
				});
				setDirty(true);
				setFormError(void 0);
				if (formErrors[field] !== void 0) setFormErrors({
					...formErrors,
					[field]: void 0
				});
			};
			const save = async () => {
				if (draftBase === void 0 || draft === void 0) return;
				const result = settingsOpsFromDraft(draftBase, draft);
				if (!result.ok) {
					setFormErrors(result.errors);
					setFormError(label("validationError"));
					return;
				}
				if (result.ops.length === 0) {
					setDirty(false);
					setFormErrors({});
					setFormError(void 0);
					return;
				}
				setSaving(true);
				setFormErrors({});
				setFormError(void 0);
				try {
					await props.mutateSettings(result.ops, draftRevision);
					await props.refreshSettings();
					setDirty(false);
				} catch (error) {
					setFormError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			const reset = async () => {
				setSaving(true);
				setFormErrors({});
				setFormError(void 0);
				try {
					await props.mutateSettings(resetSettingsOps());
					await props.refreshSettings();
					setDirty(false);
				} catch (error) {
					setFormError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			const issue = async (type, options) => {
				try {
					const result = options === void 0 ? await props.command(type) : await props.command(type, options);
					if (!result.ok) throw new Error(result.error ?? label("commandFailed"));
					setCommandError(void 0);
					setConfirmStage("none");
				} catch (error) {
					setCommandError(error instanceof Error ? error.message : String(error));
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				style: cardStyle,
				"data-testid": "dev-reloader-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: headerStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: titleStyle,
							children: label("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: descriptionStyle,
							children: label("description")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: badgesStyle,
							children: [settings.mode === "compat" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modeBadgeStyle,
								children: label("compatMode")
							}) : null, dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: dirtyBadgeStyle,
								children: label("unsaved")
							}) : null]
						})]
					}),
					settings.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: noticeStyle,
						children: label("settingsLoading")
					}) : null,
					settings.status === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: warningStyle,
						children: label("settingsUnavailable")
					}) : null,
					settings.status === "ready" && !settings.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: warningStyle,
						children: label("readOnly")
					}) : null,
					settings.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: errorStyle,
						children: settings.error
					}) : null,
					draft !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: formStyle,
						"aria-disabled": settingsDisabled,
						"data-testid": "dev-reloader-settings-form",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
								title: label("general"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: toggleStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											"aria-label": label("enabled"),
											type: "checkbox",
											checked: draft.enabled,
											disabled: settingsDisabled,
											onChange: (event) => edit("enabled", event.target.checked)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label("enabled") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("profile"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											"aria-label": label("profile"),
											style: inputStyle,
											value: draft.profile,
											disabled: true,
											readOnly: true
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("webUrl"),
										error: formErrors.webUrl,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											"aria-label": label("webUrl"),
											style: inputStyle,
											value: draft.webUrl,
											disabled: settingsDisabled,
											onChange: (event) => edit("webUrl", event.target.value)
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("logLevel"),
										error: formErrors.logLevel,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
											"aria-label": label("logLevel"),
											style: inputStyle,
											value: draft.logLevel,
											disabled: settingsDisabled,
											onChange: (event) => edit("logLevel", event.target.value),
											children: [
												"debug",
												"info",
												"warn",
												"error"
											].map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: level,
												children: level
											}, level))
										})
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
								title: label("watch"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("sourceRoots"),
										hint: label("sourceRootsHint"),
										wide: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											"aria-label": label("sourceRoots"),
											style: textareaStyle,
											rows: 3,
											value: draft.sourceRoots,
											disabled: settingsDisabled,
											onChange: (event) => edit("sourceRoots", event.target.value)
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("ignored"),
										hint: label("ignoredHint"),
										wide: true,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											"aria-label": label("ignored"),
											style: textareaStyle,
											rows: 3,
											value: draft.ignored,
											disabled: settingsDisabled,
											onChange: (event) => edit("ignored", event.target.value)
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: label("debounceMs"),
										error: formErrors.debounceMs,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											"aria-label": label("debounceMs"),
											style: inputStyle,
											inputMode: "numeric",
											value: draft.debounceMs,
											disabled: settingsDisabled,
											onChange: (event) => edit("debounceMs", event.target.value)
										})
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
								title: label("lifecycle"),
								children: [
									"healthTimeoutMs",
									"shutdownGraceMs",
									"bridgeGraceMs",
									"crashWindowMs",
									"maxCrashRestarts"
								].map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: label(field),
									error: formErrors[field],
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										"aria-label": label(field),
										style: inputStyle,
										inputMode: "numeric",
										value: draft[field],
										disabled: settingsDisabled,
										onChange: (event) => edit(field, event.target.value)
									})
								}, field))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
								title: label("advanced"),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: label("projectOverrides"),
									hint: label("projectOverridesHint"),
									error: formErrors.projectOverrides,
									wide: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										"aria-label": label("projectOverrides"),
										style: {
											...textareaStyle,
											fontFamily: "ui-monospace, monospace"
										},
										rows: 8,
										value: draft.projectOverrides,
										disabled: settingsDisabled,
										onChange: (event) => edit("projectOverrides", event.target.value)
									})
								})
							}),
							formError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: formError
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: formActionsStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: primaryButtonStyle,
									disabled: settingsDisabled || !dirty,
									onClick: () => void save(),
									children: saving ? label("saving") : label("save")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle,
									disabled: settingsDisabled,
									onClick: () => void reset(),
									children: label("reset")
								})]
							})
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: label("operational"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: phaseRowStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label("phase") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: phaseStyle,
										children: activePhase
									}),
									reloading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label("recovering") }) : null
								]
							}),
							status?.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: status.error
							}) : null,
							commandError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: commandError
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: actionRowStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: commandDisabled,
										onClick: () => void issue("rebuild"),
										children: label("rebuild")
									}),
									confirmStage === "none" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: commandDisabled,
										onClick: () => setConfirmStage("normal"),
										children: label("restart")
									}) : null,
									confirmStage === "none" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: dangerButtonStyle,
										disabled: commandDisabled,
										onClick: () => setConfirmStage("force-warn"),
										children: label("forceRestart")
									}) : null,
									confirmStage !== "none" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RenderConfirm, {
										stage: confirmStage,
										label,
										onCancel: () => setConfirmStage("none"),
										onConfirm: () => {
											if (confirmStage === "normal") issue("restart", { force: false });
											else if (confirmStage === "force-warn") setConfirmStage("force-armed");
											else issue("restart", { force: true });
										}
									}) : null
								]
							})
						]
					})
				]
			});
		}
		function Section({ title, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: sectionStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					style: sectionTitleStyle,
					children: title
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: gridStyle,
					children
				})]
			});
		}
		function Field({ label, hint, error, wide, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: {
					...fieldStyle,
					...wide ? wideFieldStyle : {}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: fieldLabelStyle,
						children: label
					}),
					children,
					hint ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: hintStyle,
						children: hint
					}) : null,
					error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: errorStyle,
						children: error
					}) : null
				]
			});
		}
		function RenderConfirm({ stage, label, onConfirm, onCancel }) {
			const text = stage === "normal" ? label("restart.confirm") : stage === "force-warn" ? label("forceRestart.warn") : label("forceRestart.confirmAgain");
			const action = stage === "normal" ? label("restart.confirmAction") : stage === "force-warn" ? label("forceRestart.confirm") : label("forceRestart.confirmAgain");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: confirmStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: stage === "normal" ? hintStyle : errorStyle,
						children: text
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: stage === "normal" ? buttonStyle : dangerButtonStyle,
						onClick: onConfirm,
						children: action
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle,
						onClick: onCancel,
						children: label("cancel")
					})
				]
			});
		}
		const cardStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 14,
			padding: 16,
			border: "1px solid var(--dsw-alias-stroke-subtle, rgba(127,127,127,.22))",
			borderRadius: 12,
			background: "var(--dsw-alias-surface-raised, transparent)"
		};
		const headerStyle = {
			display: "flex",
			justifyContent: "space-between",
			alignItems: "flex-start",
			gap: 12
		};
		const titleStyle = {
			margin: 0,
			fontSize: 17,
			lineHeight: 1.4
		};
		const descriptionStyle = {
			margin: "3px 0 0",
			color: "var(--dsw-alias-label-tertiary, #777)",
			fontSize: 13
		};
		const badgesStyle = {
			display: "flex",
			gap: 6,
			flexWrap: "wrap",
			justifyContent: "flex-end"
		};
		const dirtyBadgeStyle = {
			padding: "2px 7px",
			borderRadius: 999,
			fontSize: 11,
			color: "var(--dsw-alias-warning, #9a6700)",
			background: "rgba(210,153,34,.12)"
		};
		const modeBadgeStyle = {
			...dirtyBadgeStyle,
			color: "var(--dsw-alias-accent, #2563eb)",
			background: "rgba(37,99,235,.1)"
		};
		const formStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 12
		};
		const sectionStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 9,
			padding: 12,
			borderRadius: 10,
			background: "var(--dsw-alias-surface-secondary, rgba(127,127,127,.055))"
		};
		const sectionTitleStyle = {
			margin: 0,
			fontSize: 13,
			fontWeight: 650,
			color: "var(--dsw-alias-label-secondary, inherit)"
		};
		const gridStyle = {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
			gap: 10
		};
		const fieldStyle = {
			minWidth: 0,
			display: "flex",
			flexDirection: "column",
			gap: 5
		};
		const wideFieldStyle = { gridColumn: "1 / -1" };
		const fieldLabelStyle = {
			fontSize: 12,
			fontWeight: 600
		};
		const hintStyle = {
			color: "var(--dsw-alias-label-tertiary, #777)",
			fontSize: 11,
			lineHeight: 1.4
		};
		const inputStyle = {
			boxSizing: "border-box",
			width: "100%",
			minHeight: 34,
			padding: "6px 9px",
			border: "1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))",
			borderRadius: 7,
			color: "inherit",
			background: "var(--dsw-alias-surface-primary, transparent)"
		};
		const textareaStyle = {
			...inputStyle,
			resize: "vertical",
			lineHeight: 1.45
		};
		const toggleStyle = {
			...fieldStyle,
			flexDirection: "row",
			alignItems: "center",
			alignSelf: "center",
			minHeight: 34,
			fontSize: 13
		};
		const formActionsStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const buttonStyle = {
			minHeight: 32,
			padding: "5px 10px",
			border: "1px solid var(--dsw-alias-stroke-default, rgba(127,127,127,.3))",
			borderRadius: 7,
			color: "inherit",
			background: "var(--dsw-alias-surface-primary, transparent)",
			cursor: "pointer"
		};
		const primaryButtonStyle = {
			...buttonStyle,
			color: "var(--dsw-alias-on-accent, white)",
			borderColor: "transparent",
			background: "var(--dsw-alias-accent, #2563eb)"
		};
		const dangerButtonStyle = {
			...buttonStyle,
			color: "var(--dsw-alias-danger, #c0392b)"
		};
		const phaseRowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			gridColumn: "1 / -1",
			fontSize: 13
		};
		const phaseStyle = { fontWeight: 650 };
		const actionRowStyle = {
			display: "flex",
			gap: 8,
			alignItems: "center",
			flexWrap: "wrap",
			gridColumn: "1 / -1"
		};
		const confirmStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap"
		};
		const noticeStyle = {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary, #777)",
			fontSize: 12
		};
		const warningStyle = {
			...noticeStyle,
			color: "var(--dsw-alias-warning, #9a6700)"
		};
		const errorStyle = {
			margin: 0,
			color: "var(--dsw-alias-danger, #c0392b)",
			fontSize: 12,
			wordBreak: "break-word"
		};
		new TextEncoder();
		//#endregion
		//#region src/client/api.ts
		/**
		* Typed fetch helpers for the same-origin bridge surfaces.
		*
		* The browser card talks only to the host bridge's loopback routes
		* (`/plugins/dsh-dev-reloader/{status,health,command}`). This module owns all
		* `fetch` usage for the card, keeps request bodies within the supervisor's
		* bounded-body contract, and maps transport/HTTP failures into a single
		* {@link ApiError} so the card can render them uniformly. `fetch` is injectable
		* for tests.
		*/
		/** Same-origin route paths served by the host bridge (keep in sync with routes.ts). */
		const STATUS_PATH = "/plugins/dsh-dev-reloader/status";
		const HEALTH_PATH = "/plugins/dsh-dev-reloader/health";
		const COMMAND_PATH = "/plugins/dsh-dev-reloader/command";
		/** Upper bound for a command request body (matches the host route guard). */
		const MAX_COMMAND_BODY_BYTES = 64 * 1024;
		/** Reject bodies that would exceed the bounded-body contract. */
		var BodyTooLargeError = class extends Error {
			constructor(byteLength) {
				super(`command body is ${byteLength} bytes, exceeding the ${MAX_COMMAND_BODY_BYTES} byte bound`);
				this.name = "BodyTooLargeError";
			}
		};
		/** Error raised for any transport or non-2xx HTTP failure of a bridge call. */
		var ApiError = class extends Error {
			status;
			body;
			constructor(status, body, cause) {
				super(`bridge request failed with status ${status}: ${body}`, { cause });
				this.name = "ApiError";
				this.status = status;
				this.body = body;
			}
			/** Short human-readable message for the settings card. */
			displayMessage() {
				return `HTTP ${this.status}: ${this.body}`;
			}
		};
		/** One sequential request-id source for commands issued by this page. */
		function createRequestId() {
			return `dsh-card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}
		async function readError(res) {
			const text = await res.text().catch(() => "");
			if (text !== "") return text;
			return `HTTP ${res.status}`;
		}
		async function request(fetchImpl, base, path, init) {
			try {
				const response = await fetchImpl(`${base}${path}`, init);
				if (!response.ok) {
					const body = await readError(response);
					throw new ApiError(response.status, body);
				}
				return response;
			} catch (error) {
				if (error instanceof ApiError) throw error;
				throw new ApiError(0, error instanceof Error ? error.message : String(error), error);
			}
		}
		/**
		* Build the typed bridge API. `fetchImpl` defaults to the global `fetch`;
		* `base` defaults to the same-origin root (`''`), so routes resolve relative to
		* the current page.
		*/
		function createDevReloaderApi(fetchImpl = fetch, base = "") {
			return {
				async getStatus() {
					return await (await request(fetchImpl, base, STATUS_PATH, {
						method: "GET",
						cache: "no-store"
					})).json();
				},
				async getHealth() {
					return await (await request(fetchImpl, base, HEALTH_PATH, {
						method: "GET",
						cache: "no-store"
					})).json();
				},
				async command(type, options) {
					const payload = {
						protocolVersion: 1,
						type,
						requestId: createRequestId()
					};
					if (options?.force !== void 0) payload.force = options.force;
					if (options?.config !== void 0) payload.config = options.config;
					const text = JSON.stringify(payload);
					const byteLength = new TextEncoder().encode(text).byteLength;
					if (byteLength > 65536) throw new BodyTooLargeError(byteLength);
					return await (await request(fetchImpl, base, COMMAND_PATH, {
						method: "POST",
						cache: "no-store",
						headers: { "content-type": "application/json; charset=utf-8" },
						body: text
					})).json();
				}
			};
		}
		//#endregion
		//#region src/client/settings-transport.ts
		const SETTINGS_PATH = "/plugins/dsh-dev-reloader/settings";
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function parseDescriptor(value) {
			if (!isRecord(value) || !("value" in value)) return void 0;
			if (!Number.isSafeInteger(value.revision) || value.revision < 0) return void 0;
			if (typeof value.writable !== "boolean") return void 0;
			return {
				value: value.value,
				base: value.base,
				user: value.user,
				revision: value.revision,
				writable: value.writable
			};
		}
		async function responseError(response) {
			try {
				const body = await response.json();
				if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) return body.error.slice(0, 512);
			} catch {}
			return "settings request failed (" + response.status + ")";
		}
		function officialSnapshot(source) {
			return {
				status: source.status,
				value: source.value,
				base: source.base,
				user: source.user,
				writable: source.writable,
				mode: source.status === "ready" ? "official" : "unavailable",
				revision: void 0,
				error: void 0
			};
		}
		var SettingsTransportController = class {
			official;
			fetchFn;
			loopback;
			listeners = /* @__PURE__ */ new Set();
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
				if (source !== this.sourceSnapshot) this.acceptOfficial(source, false);
				return this.snapshot;
			};
			subscribe = (listener) => {
				this.listeners.add(listener);
				if (this.unsubscribeOfficial === void 0) this.unsubscribeOfficial = this.official.subscribe(() => {
					this.acceptOfficial(this.official.getSnapshot(), true);
				});
				if (this.sourceSnapshot.status === "unavailable") this.loadCompat();
				return () => {
					this.listeners.delete(listener);
					if (this.listeners.size === 0) {
						this.unsubscribeOfficial?.();
						this.unsubscribeOfficial = void 0;
					}
				};
			};
			refresh = async () => {
				const source = this.official.getSnapshot();
				this.acceptOfficial(source, false);
				if (source.status === "unavailable") await this.loadCompat(true);
			};
			mutate = (ops, expectedRevision) => {
				const operation = this.writeTail.then(async () => {
					if (ops.length === 0) return;
					const source = this.official.getSnapshot();
					this.acceptOfficial(source, false);
					if (source.status === "ready") {
						if (!source.writable) throw new Error("settings document is read-only");
						for (const op of ops) if (op.op === "set") await this.official.set(op.path[0], op.value);
						else await this.official.unset(op.path[0]);
						this.acceptOfficial(this.official.getSnapshot(), true);
						return;
					}
					if (this.snapshot.status !== "ready" || this.snapshot.mode !== "compat") throw new Error(this.snapshot.error ?? "settings are unavailable");
					if (!this.snapshot.writable) throw new Error("settings document is read-only");
					if (this.fetchFn === void 0) throw new Error("settings are unavailable");
					const revision = expectedRevision ?? this.snapshot.revision;
					const response = await this.fetchFn(SETTINGS_PATH, {
						method: "POST",
						credentials: "same-origin",
						cache: "no-store",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							...revision === void 0 ? {} : { expectedRevision: revision },
							ops
						})
					});
					if (!response.ok) {
						const message = await responseError(response);
						await this.loadCompat(true, message);
						throw new Error(message);
					}
					const body = await response.json();
					const descriptor = isRecord(body) ? parseDescriptor(body.descriptor) : void 0;
					if (descriptor === void 0) throw new Error("settings response is malformed");
					if (this.official.getSnapshot().status === "ready") {
						this.acceptOfficial(this.official.getSnapshot(), true);
						return;
					}
					this.loadGeneration += 1;
					this.acceptCompat(descriptor);
				});
				this.writeTail = operation.catch(() => void 0);
				return operation;
			};
			acceptOfficial(source, notify) {
				if (source === this.sourceSnapshot) return;
				this.sourceSnapshot = source;
				if (source.status === "ready") {
					this.loadGeneration += 1;
					this.setSnapshot(officialSnapshot(source), notify);
					return;
				}
				if (source.status === "loading") {
					this.setSnapshot(officialSnapshot(source), notify);
					return;
				}
				if (!this.loopback || this.fetchFn === void 0) {
					this.setSnapshot(officialSnapshot(source), notify);
					return;
				}
				if (this.snapshot.mode !== "compat") this.setSnapshot({
					status: "loading",
					value: void 0,
					base: void 0,
					user: void 0,
					writable: source.writable,
					mode: "compat",
					revision: void 0,
					error: void 0
				}, notify);
				this.loadCompat();
			}
			async loadCompat(force = false, retainedError) {
				if (!this.loopback || this.fetchFn === void 0) return;
				if (this.official.getSnapshot().status === "ready") return;
				if (!force && this.loadPromise !== void 0) return this.loadPromise;
				const generation = ++this.loadGeneration;
				const load = (async () => {
					try {
						const response = await this.fetchFn(SETTINGS_PATH, {
							method: "GET",
							credentials: "same-origin",
							cache: "no-store",
							headers: { accept: "application/json" }
						});
						if (!response.ok) throw new Error(await responseError(response));
						const body = await response.json();
						const descriptor = isRecord(body) ? parseDescriptor(body.descriptor) : void 0;
						if (descriptor === void 0) throw new Error("settings response is malformed");
						if (generation !== this.loadGeneration) return;
						if (this.official.getSnapshot().status !== "ready") this.acceptCompat(descriptor, retainedError);
					} catch (error) {
						if (generation !== this.loadGeneration) return;
						if (this.official.getSnapshot().status === "ready") return;
						const message = retainedError ?? (error instanceof Error ? error.message : "settings request failed");
						this.setSnapshot({
							status: "unavailable",
							value: void 0,
							base: void 0,
							user: void 0,
							writable: this.official.getSnapshot().writable,
							mode: "unavailable",
							revision: void 0,
							error: message.slice(0, 512)
						}, true);
					}
				})();
				this.loadPromise = load;
				try {
					await load;
				} finally {
					if (this.loadPromise === load) this.loadPromise = void 0;
				}
			}
			acceptCompat(descriptor, error) {
				this.setSnapshot({
					status: "ready",
					value: descriptor.value,
					base: descriptor.base,
					user: descriptor.user,
					writable: descriptor.writable,
					mode: "compat",
					revision: descriptor.revision,
					error
				}, true);
			}
			setSnapshot(next, notify) {
				if (this.snapshot === next) return;
				this.snapshot = next;
				if (notify) this.listeners.forEach((listener) => listener());
			}
		};
		function createSettingsTransport(official, options) {
			return new SettingsTransportController(official, options.fetchFn, options.loopback);
		}
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-dev-reloader-client";
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"connection",
			"remote"
		];
		const NAMESPACE = "dsh-dev-reloader";
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("dev-reloader.card", {
				zh,
				en
			}));
			const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
			const connection = ctx.get("connection");
			const fetchFn = typeof fetch === "function" ? fetch.bind(globalThis) : void 0;
			const transport = createSettingsTransport(scope, {
				...fetchFn === void 0 ? {} : { fetchFn },
				loopback: connection?.isLoopback !== false
			});
			const api = createDevReloaderApi();
			const toFace = () => ({
				hooks: { devReloader: transport },
				mutateSettings: (ops) => transport.mutate(ops),
				refreshSettings: () => transport.refresh(),
				command: (type, options) => api.command(type, options),
				getStatus: async () => {
					const status = await api.getStatus();
					return status.error === void 0 ? { phase: status.phase } : {
						phase: status.phase,
						error: status.error
					};
				},
				getHealth: () => api.getHealth()
			});
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "dsh-dev-reloader",
				order: 40,
				locale: "dev-reloader.card",
				inject: () => toFace()
			}, SettingsCard));
		}
		//#endregion
		exports.NAMESPACE = NAMESPACE;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map