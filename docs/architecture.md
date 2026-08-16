# dsh-dev-reloader 架构

本文档描述该插件的进程与信任边界、变更分类、状态机与完整重启序列。实现的事实来源是 `src/shared/protocol.ts`、`src/shared/state.ts`、`src/shared/config.ts`、`src/bridge/*`、`src/supervisor/*` 与 `src/client/*`。

## 三进程边界

系统由三个独立进程组成，职责严格分离：

```
┌─────────────────────────────┐  本地受信 IPC    ┌──────────────────────────┐
│  DSH 宿主进程（桥接插件）        │  ◄─────────────►  │  独立 Node 守护器            │
│  src/index.ts / bridge/*      │  Unix socket /    │  lib/supervisor/cli.js    │
│                               │  Windows pipe     │  supervisor/{discovery,   │
│  · 宿主 PID / Node / argv/     │                   │  watcher,classifier,builder,│
│    env/WebURL 采集            │                   │  health-check,lifecycle,   │
│  · 活动 Agent 与后台任务汇总     │                   │  handoff,ipc}.ts         │
│  · 同源 Web 路由（status/      │                   │  · 发现 / 监听 / 构建 / 调度 │
│    health/command）            │                   │  · 活动任务门控            │
│  · settings 绑定与命令转发       │                   │  · 进程生命周期 / 崩溃恢复   │
└──────────────┬────────────────┘                   │  · 自身版本 handoff       │
               │ 同源 HTTP（浏览器不接触守护器或令牌）         └──────────────────────────┘
┌──────────────▼────────────────┐
│  浏览器 client-plugin           │
│  src/client/（设置卡片 + 一次性恢复）│
└───────────────────────────────┘
```

- **DSH 宿主进程内的桥接插件**：只适配 Cordis/DSH 服务，不直接监听源码、也不自行重启宿主。它维护到守护器的本地 IPC 客户端、把守护器状态通过环回 Web 路由暴露给浏览器、接收 GUI 命令并转发，并在宿主即将处置时发送生命周期信号。宿主不删除守护器锁——锁归守护器进程所有。
- **独立 Node 守护器**：从打包的 `lib/supervisor/cli.js` 以 `detached` + `shell:false` 启动，持有单实例锁与本地控制通道，负责发现、监听、构建、门控、进程生命周期与崩溃恢复。它在 DSH 退出期间存活；第一次完整重启后，新 DSH 由守护器作为子进程拉起。
- **浏览器 client-plugin**：承载完整设置表单与一次性恢复。它既不直接连接守护器，也拿不到守护器令牌；优先使用官方 `settingsScope`，仅在 rc.6 不开放第三方命名空间时通过同源 `/settings` 兼容路由访问同一个 DSH `SettingsProvider`，并继续用 `status` / `health` / `command` 路由完成运行控制。

三个层之间的唯一共享契约是 `src/shared/protocol.ts`（版本化 wire 协议）与 `src/shared/state.ts`（状态机）。

## IPC 信任边界

桥接插件与守护器之间通过本地通道完成受信握手：Unix domain socket（Windows 为 named pipe），端点 `$DSH_HOME/plugins/dsh-dev-reloader/<profile>/supervisor.sock`（目录 `0700`；令牌文件 `supervisor.token` 与锁文件 `0600`，仅当前用户可访问）。

- 启动握手包含随机实例**令牌**（64 位 hex，`createHmac('sha256', token)` 派生）、宿主 PID 与 `bootId`。守护器拒绝旧 PID、错误令牌或其他用户的连接。
- **令牌永不上线**：身份通过 HMAC 挑战-响应证明，令牌只在派生证明中使用；连接/事件限定在同一 profile 与代际（peer 代际准入）。
- `handoff.ts` 的一次性交接通道同样基于该令牌做**互证 HMAC**：lead 与 standby 双向证明各自知道令牌，绑定 transaction id、server nonce 与 client nonce 以避免重放；端点/通道在 commit 后被一次性消费。
- 完整环境变量只在守护器由当前 DSH 启动时经内存继承，不写入状态文件或日志。
- 桥接的 Web 路由为环回 + 同源模型：`status`/`health` 可读；`command` 与 `/settings` 写入仅接受非代理、非跨源、`application/json` 的环回请求；请求体有界（`64 KiB`）。`/settings` 读取同样拒绝非环回与代理请求，且每次只返回该命名空间经脱敏的 DSH descriptor。

### 路由

`src/bridge/routes.ts` 与 `src/bridge/settings.ts` 定义同源前缀 `/plugins/dsh-dev-reloader`：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/plugins/dsh-dev-reloader/status` | GET | 守护器公开状态（脱敏处理后的字段） |
| `/plugins/dsh-dev-reloader/health` | GET | `{ ok, bootId }`，供恢复轮询使用 |
| `/plugins/dsh-dev-reloader/command` | POST | 受信命令：`get-status` / `update-config` / `rebuild` / `restart` / `pause` / `stop` |
| `/plugins/dsh-dev-reloader/settings` | GET / POST | 读取脱敏 descriptor；或以 `expectedRevision` 提交一批顶层 `set` / `unset` 操作。仅为 rc.6 兼容传输，持久化与校验仍归 DSH `SettingsProvider` |

浏览器端 `src/client/api.ts` 与 `src/client/settings-transport.ts` 镜像这些路径与有界体契约。兼容 `/settings` 路由的退役触发器是最低支持的 DSH 版本已向第三方命名空间提供官方 `settingsScope`；届时删除该路由与 fallback 分支，表单仅保留官方 scope。

## 变更分类

`src/supervisor/classifier.ts` 将一条相对 POSIX 规范化路径映射为确定性动作计划。影响等级严格为：

```
ignore < config-hmr < server-hmr < client-hmr < full-restart
```

分类顺序：

1. **忽略**：`.git`、`docs`、测试、README/`*.md`、构建输出（`lib`/`dist`/`coverage` 等），以及额外 `ignored` glob。
2. **配置 HMR**：profile/home 下的 `cordis.patch.yml` → 交给 DSH 内置配置 HMR（`config-hmr`）。
3. **依赖安装**：workspace 根的 `pnpm-lock.yaml` → `dependency-install`（`pnpm install --frozen-lockfile`）+ 完整重启。
4. **清单/构建配置**：`package.json`、`cordis.patch.yml`、`tsconfig*.json`、官方/通用构建配置 → 构建 + 完整重启（`manifest`）。
5. **DSH checkout 运行时代码**：整仓变更 → 官方根构建 + 完整重启（`runtime`）。
6. **client-plugin 源码**：有 `devWeb` 则启动/复用持久 `dev:web` watcher（`client-watch`，`client-hmr`）；无则完整重启。
7. **服务端入口**：构建 + 等待 Cordis HMR 的显式 `hmr/reload` 确认（`server-hmr`）。
8. **失败关闭**：无法可靠分类的运行时代码按完整构建与重启处理。

`mergeActions` 去重独立操作、保留每个操作类型并选取最大影响；构建期间到达的新事件合并为后续周期，同一时间只执行一个构建周期。路径输入还会校验相对形态与安全编码，拒绝越界/绝对/含反斜杠/百分比编码逃逸路径。

## 状态机

`src/shared/state.ts` 定义稳定相位与合法转移（非法转移抛错）：

```
starting ──watch-ready──► watching ──build-started──► building
watching ──restart-pending──► pending-restart
building ──build-succeeded──► watching
building ──hmr-wait──► hmr-wait ──hmr-complete──► watching
building ──build-failed──► degraded
watching/building/hmr-wait ──restart-pending──► pending-restart
pending-restart ──restart-ready──► restarting ──host-started──► recovering ──recovered──► watching
degraded ──watch-ready──► watching
degraded ──build-started──► building
degraded ──restart-pending──► pending-restart
paused / failed ──resume──► starting
任意可恢复状态 ──fail──► failed；非 failed ──pause──► paused
```

公开状态（`toPublicStatus`）只包含相位、变更时间、原因、受影响项目（上限 32）、错误摘要与 `bootId`；`reason`/`error` 经过敏感脱敏并截断（512 / 2048 字节），不包含环境变量、令牌或完整敏感命令输出。

## 完整重启序列

健康路径：

```
gate（活动门控） → restart-pending → restart-ready → terminate（向旧宿主发正常终止信号）
→ 等待端口释放（shutdownGraceMs 超时后升级） → spawn（以保存的 Node/execArgv/argv/cwd/env 启动新 DSH）
→ dual health（新宿主 HTTP 健康 且 新 bridge bootId 就绪） → bridge reconnect → recovered
```

- 构建通过 `pending-restart` 或 `restart-ready` 进入重启；活动计数非零或活动状态未知时**无限等待**，只有 GUI 显式“重启/强制重启”可覆盖（`force:true` 绕过门控）。
- 守护器向旧宿主发送正常终止信号，等待 Cordis 资源释放与端口关闭，超时才升级终止方式。
- 以 `HostLaunchSpec` 中保存的可执行文件、execArgv、argv、cwd 与内存环境启动新 DSH；新宿主由守护器作为子进程运行。
- 新桥接实例通过同一本地通道重新握手并发布新 `bootId`；HTTP 健康**且** bridge `bootId` 就绪后才判定 `recovered`。
- **HMR 路径**：server HMR 构建后等待桥接转发 `hmr/reload` 的显式确认（`hmr-wait`→`hmr-complete`）；超时（`healthTimeoutMs`）升级为完整重启。
- 浏览器在 `pending-restart`/`restarting`/`recovering` 期间把当前 `bootId` 写入 `sessionStorage`（`dsh.devReloader.recovery.v1`），以 1s 轮询同源 `health`；发现健康的新 `bootId` 时执行**一次** `location.reload()`，并清除恢复标记。
- 守护器始终复用原 `webUrl`，不启动替代 Web 服务。
- 崩溃恢复：宿主无处置握手直接消失视为崩溃，按指数退避恢复；窗口内超过 `maxCrashRestarts` 进入 `failed`，由 GUI 或重启 DSH 显式恢复。
