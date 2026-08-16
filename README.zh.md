# dsh-dev-reloader

[English](README.md) | 中文

基于官方 DSH bundle 规范开发的一个**仅用于本地开发**的自动重载与自动重启插件。它作为 DSH 插件安装后，会自动启动一个独立的开发守护器，监听 DSH 源码 checkout 与本地链接插件，并按照变更内容选择配置 HMR、Cordis HMR、client HMR 或完整构建重启。

> **本地开发限定警告**：本项目只面向本地开发环境。守护器会监听真实源码、执行本地构建脚本、按需终止并重新拉起 DSH 进程。**不要在共享或生产服务器上安装使用**。构建命令属于本地源码项目的受信代码，会消耗真实的本机资源。

## 功能概览

- 作为官方格式的 host/client bundle 安装，`dsh` 每次启动时自动连接或启动独立守护器，日常使用不需要额外启动 `pnpm dev`。
- 自动发现 DSH 源码 checkout（根目录含 `pnpm-workspace.yaml`、根包元数据和 `apps/web`）与本地链接插件（`link:` / `file:` / `workspace:`）。
- 按变更自动分类并选择最合适的动作：配置 HMR、server（Cordis）HMR、client HMR、依赖安装 + 完整重启、完整构建 + 完整重启。
- 完整重启前等待活动任务；只有经过额外确认的 GUI **强制重启**会绕过活动门控并可能中断工作。
- 重启后仅在新宿主 HTTP 健康且新 bridge `bootId` 就绪时，对原 URL 自动刷新一次。
- 独立守护器在 DSH 退出期间继续存活；用户正常停止、插件 HMR 卸载、插件禁用与宿主崩溃会被区分处理。
- 崩溃恢复带指数退避与熔断；守护器自身更新通过一次性的本地 handoff 交接。

## 兼容性

| 项 | 要求 |
|---|---|
| 运行平台 | Linux、macOS、Windows |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| DSH | `0.1.0-rc.6` 及同 ABI 系列 |
| pnpm | 11（`packageManager` 声明 `pnpm@11.8.0`），本地开发建议 11.x |
| 浏览器 | Web 平台（`dsh.client.platform` 为 `web`） |
| 安装方式 | GitHub bundle 安装或本地 `link:` 安装；**不提供 npm 发布，也不创建 GitHub Release** |

## 安装（GitHub）

```sh
dsh plugin --profile web add github:lhzcode/dsh-dev-reloader
```

安装命令成功后只需首次重启一次 DSH，让新 bundle 进入组合：

```sh
dsh web
```

此后插件在每次 DSH 启动时自动连接或启动守护器，不再要求额外运行 `pnpm dev`。

## 预编译 GitHub Bundle

仓库直接跟踪生成后的 `lib/` 发布产物。GitHub 安装使用这些已审查产物，不执行依赖构建脚本，因此用户无需把本插件加入 pnpm `allowBuilds`。

贡献者修改会影响输出的源码后，必须执行 `pnpm build` 并一并提交对应的 `lib/` 变更。CI 会先打包已提交产物，再重新构建并拒绝过期的生成文件。

## 本地开发安装

修改本插件自身源码时，先构建出 `lib/`，再用绝对 `link:` 路径安装：

```sh
git clone https://github.com/lhzcode/dsh-dev-reloader.git
cd dsh-dev-reloader
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add link:$PWD
```

本地安装**必须先产生 `lib/`**，然后使用 `link:$PWD`（即当前目录的绝对路径）。首次加载后，守护器也能监听本插件源码并安全地交接替换自身。

## 首次重启

安装完成后重启一次 DSH（`dsh web`）。插件挂载时会自动连接或启动守护器；守护器完成监听计划后就绪，无需任何额外手工操作。完整重启后，DSH 由守护器作为子进程拉起。

## GUI 状态与操作

Web 设置区提供“开发重载”卡片（槽位 `settings.plugin.item`，命名空间 `dsh-dev-reloader`）：

- **完整标准表单**：提供全部守护器配置项，采用与其他插件配置卡片一致的分组、未保存标记、保存、重置、只读和字段校验交互；`profile` 作为运行时不可变字段只读展示。在 rc.6 兼容通道下，保存会提交一次带版本栅栏的原子变更批次；官方 scope 始终优先并使用其原生字段变更 API。重置会移除用户覆盖并重新继承 DSH 默认值与组合配置。
- **阶段展示**：启动中（starting）、监听中（watching）、构建中（building）、等待 HMR（hmr-wait）、等待重启（pending-restart）、重启中（restarting）、恢复中（recovering）、降级（degraded）、失败（failed）、已暂停（paused）、未知（unknown）。并显示最近错误摘要。
- **重新构建**：对全部项目执行构建并触发完整重启（失败状态下也可用于显式恢复）。
- **重启**：请求一次完整重启。若存在活动任务则进入“等待重启”阶段，需要二次确认；自动策略**永不**强制中断活动任务。
- **强制重启**：二次确认后立即中断所有进行中的任务并重启（UI 明确警告会中断工作）。
- 当宿主文档只读时，配置与命令控件处于禁用状态。若 rc.6 DSH Web 不开放第三方设置命名空间，卡片会自动使用仅限本机环回的命名空间兼容通道；DSH `SettingsProvider` 仍是唯一配置存储与校验所有者。官方 `settingsScope` 一旦可用即优先使用。

## 自动发现与变更分类

自动发现：

- **DSH 源码 checkout**：根目录含 `pnpm-workspace.yaml`、根包元数据标注 DSH 根，且包含 `apps/web`。
- **本地链接插件**：通过当前 DSH profile 的 `package.json` 解析 `link:` / `file:` / `workspace:` 本地依赖并跟随真实路径。
- 额外源码根可通过配置 `sourceRoots` 指定，默认空数组并自动发现。

变更分类（默认动作按其最强影响级别执行一次）：

| 变更类型 | 默认动作 |
|---|---|
| profile/home 下的 `cordis.patch.yml` | 交给 DSH 内置配置 HMR |
| 服务端插件源码 | 执行对应包构建，等待 Cordis HMR |
| client-plugin 源码 | 确保该 checkout 的 `dev:web` watcher 运行，交给 client HMR |
| 插件 `package.json`、bundle patch、exports、构建配置 | 构建成功后完整重启 |
| DSH Web Shell、基础包、共享普通包 | 执行官方仓库根构建，成功后完整重启 |
| lockfile 或依赖关系 | 执行 `pnpm install --frozen-lockfile`，成功后完整重启 |
| 一般文档、测试源码、Git 元数据、构建输出 | 默认忽略 |
| 无法可靠分类的运行时代码 | 失败关闭：按完整构建与重启处理 |

构建输出只由构建完成事件消费，不重新进入源码 watcher，避免循环构建。

## 配置

卡片中可调参数全部通过 DSH 官方设置源实时应用；影响 watcher 的字段会触发监听计划原子替换。以下字段与默认值来自 `src/shared/config.ts` 与 `src/index.ts` 的设置 schema：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启动守护器；`false` 显式停止并关闭连接 |
| `profile` | string | `'web'` | 守护器服务的 DSH profile（CLI 运行时固定，不可在线变更） |
| `sourceRoots` | string[] | `[]` | 额外的源码 checkout 根目录（默认自动发现） |
| `webUrl` | string | 从当前 Web 宿主解析 | 新宿主应保持的 Web URL；重启后复用原 URL |
| `debounceMs` | number | `250` | 文件事件去抖窗口 |
| `healthTimeoutMs` | number | `60000` | 新宿主健康检查总时限 |
| `shutdownGraceMs` | number | `10000` | 正常退出宽限期（超时后升级终止方式） |
| `bridgeGraceMs` | number | `10000` | HMR 或启动期间等待桥接重新出现的时限 |
| `crashWindowMs` | number | `60000` | 崩溃熔断观察窗口 |
| `maxCrashRestarts` | number | `3` | 窗口内最大崩溃重启次数，超限进入失败并停止自动拉起 |
| `ignored` | string[] | `[]` | 附加忽略 glob |
| `projectOverrides` | object[] | `[]` | 特定源码根的 build / devWeb（可执行文件 + argv 数组）覆盖 |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` | 守护器日志等级 |

更新语义：`enabled:false` 显式停止守护器；`profile` 在运行时不可变更；`debounceMs` 变更会替换调度器；其他影响 watcher 的字段（`sourceRoots` / `ignored` / `projectOverrides`）触发监听计划原子替换；生命周期相关字段在线替换生命周期策略。

## 日志与故障排查

- 运行时私密目录：`<DSH home>/plugins/dsh-dev-reloader/<profile>/`（设置 `DSH_HOME` 时使用该值，否则使用 DSH 的标准默认目录；POSIX 下目录 `0700`，令牌/锁文件 `0600`）。
- 守护器日志：同一目录下的 `supervisor.log`。
- 常见问题：
  - **未进入监听状态**：检查 DSH home 是否可解析（默认无需手动设置 `DSH_HOME`）、profile 名是否正确、守护器是否因单实例锁被占用。
  - **构建失败**：守护器保持旧 DSH 继续服务，不重启；GUI 显示失败项目与截断日志，下一次源码修改自动重试。
  - **崩溃循环未恢复**：窗口内超过 `maxCrashRestarts` 进入失败；从 GUI“重新构建”或重新启动 DSH 显式恢复。
  - **卡在等待重启**：存在活动 agent/任务或活动状态未知；结束相关任务，或使用“强制重启”显式覆盖。

## 暂停与卸载

- **暂停**：在设置卡片关闭“启用守护器”（`enabled:false`），守护器停止并关闭连接；已运行的 DSH 不受影响。
- **卸载**：`dsh plugin --profile web remove dsh-dev-reloader`（或按 DSH 卸载命令），随后重启 DSH。可手动删除守护器遗留的运行目录 `<DSH home>/plugins/dsh-dev-reloader/`。

## 模型体验

| 表面 | 影响 |
|---|---|
| System Prompt | 无 |
| 模型工具 | 无 |
| Token 开销 | 每次请求为零 |
| Session Log | 只读取活动状态，不新增 Session 事件 |
| 活动工作 | 自动与普通重启会等待；人工确认的强制重启可能中断工作 |

## 能力与安全边界

- 仅对**环回**地址启用管理功能；非环回访问只能读取脱敏状态，不能触发重启。
- GUI 写操作要求同源请求，并由服务端验证本地连接；含代理转发头、跨源或非 JSON 的请求被拒绝。
- 本地控制通道（Unix domain socket，Windows 使用 named pipe）与令牌文件仅限当前用户访问（`0700` / `0600`）。
- 本地通道使用随机实例令牌 + 互证 HMAC 挑战-响应；**令牌本身永不上线**，只传递由令牌派生的证明。
- 完整环境变量只在守护器由当前 DSH 启动时继承并保存在内存中，不写入状态文件或日志。
- 进程使用可执行文件 + argv 数组，不拼接不可信命令字符串；除 Windows 上确切的 `pnpm`/`pnpm.cmd` 受信包管理器 Shim 外均保持 `shell:false`。
- watcher 只进入自动发现或用户明确配置的真实目录。
- 自动模式不强制中断活动任务，未知活动状态默认等待。
- 不持久化完整环境变量、认证信息或启动令牌；状态与命令输出经过有界、脱敏处理。
- 本插件不提供任何远程/推送能力，也不向任何外部服务上报数据。

## 开发、测试与贡献

依赖：Node.js `^22.19.0 || >=24.0.0`，pnpm 11。

```sh
pnpm install
pnpm build         # 清理并编译到 lib/
pnpm verify        # typecheck + 全部测试 + build
pnpm test:unit     # 仅单元测试
pnpm test:integration  # 仅集成测试（含 bundle smoke）
```

- 所有自动测试都用临时 `DSH_HOME` 与操作系统分配的临时端口，不占用或替换 `127.0.0.1:3080`。
- `pnpm verify` 中的 bundle smoke 会打包、解包并校验元数据，确保构建产物不含本机仓库路径。
- 修改生命周期行为前，请先阅读[已确认设计](docs/design.md)与[实施计划](docs/implementation-plan.md)，并遵循项目已有的 TDD 与复核约定。

## 文档

除包入口 README 外，全部文档统一放在 [docs/](docs/README.md)：

- [架构文档](docs/architecture.md)
- [可视化架构](docs/architecture.html)
- [已确认设计](docs/design.md)
- [实施计划](docs/implementation-plan.md)
- [更新记录](CHANGELOG.md)
- [贡献指南](https://github.com/lhzcode/dsh-dev-reloader/blob/main/.github/CONTRIBUTING.md)
- [安全策略](https://github.com/lhzcode/dsh-dev-reloader/blob/main/.github/SECURITY.md)

## 已知限制

- 仅用于本地开发：自动发现的源码目录及其构建脚本被视为可信代码。
- 浏览器 Client 只支持 Web。
- 特殊 checkout 布局可能需要显式配置 `sourceRoots` 或 `projectOverrides`。
- 修改 Profile Bundle 列表后仍需重启对应 Profile。
- 包只从 GitHub 或本地 checkout 安装，不发布到 npm。

## License

[MIT](LICENSE)
