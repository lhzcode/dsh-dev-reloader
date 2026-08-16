# DSH 开发自动重载插件设计

## 状态

- 日期：2026-08-15
- 状态：已实现并进入公开发布候选审计
- 项目：`dsh-dev-reloader`
- 仓库：`https://github.com/lhzcode/dsh-dev-reloader`
- 产品形态：可安装的 DSH bundle 插件，内部启动独立开发守护进程
- 目标环境：仅本地开发

## 背景与目标

DSH 已具备 Cordis 配置与 loader 插件的热替换能力，Web client-plugin 也具备 HMR 接收能力，但不同类型的修改仍分别依赖前端 watcher、包构建或完整重启。开发者需要一个统一入口，自动发现 DSH 源码与本地链接插件，完成构建、热替换或整进程重启，并在服务恢复后自动刷新原 Web GUI。

本项目的目标是：

1. 作为官方格式的 DSH bundle 安装到 `web` profile。
2. 插件加载后自动启动独立守护进程，用户不需要额外运行开发命令。
3. 自动发现当前 DSH 源码 checkout 和 profile 中的本地链接插件。
4. 根据变更类型选择配置 HMR、Cordis HMR、client HMR 或完整构建与重启。
5. 完整重启前等待 Agent、后台任务和守护器自身构建任务结束。
6. 始终复用原启动命令、工作目录、环境和 Web URL；恢复后自动重连并刷新页面。
7. 仅用于本地开发，失败时优先保留当前可用的 DSH 实例。

## 非目标

1. 不作为生产进程管理器、服务编排器或高可用系统。
2. 不替代 DSH 内置 Cordis HMR 或 client HMR。
3. 不在远程地址暴露重启控制接口。
4. 不强制中断仍在运行的 Agent 或后台任务。
5. 不自动发布 npm 包、GitHub Release 或正式版本；发布属于后续显式授权范围。
6. 不比较或评价其他社区插件。

## 官方插件规范

项目遵循 DSH 官方插件与 bundle 约定：

- 服务端入口导出 `name`、`inject`、`Config` schema 和 `apply(ctx, config)`。
- 所有监听器、路由、连接和动态注册由 Cordis 上下文持有；自有资源通过 `ctx.effect()` 注册清理逻辑。
- `package.json` 使用 ESM，声明 `main`、`types`、`exports`、`files`、`dsh.bundle.patch` 与 `dsh.client`。
- `cordis.patch.yml` 以包名插入服务端插件行。
- 可调部署参数全部进入 Schemastery 配置，不散落硬编码。
- GitHub 安装直接使用仓库跟踪的预编译 `lib/`；安装过程不执行依赖构建脚本，也不要求用户配置 pnpm `allowBuilds`。
- 本地开发使用构建后的绝对 `link:` 安装。

参考：

- https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/index.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/config.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/framework/index.zh.md

## 用户流程

### GitHub 独立仓库安装

`README.md` 的默认安装方式为 DSH 官方支持且社区常用的 GitHub bundle 安装：

```sh
dsh plugin --profile web add github:lhzcode/dsh-dev-reloader
```

GitHub 安装直接消费仓库中已提交并经 CI 校验的 `lib/`，不执行 `prepare`、`prepack` 或其他依赖构建脚本。源码变更影响构建输出时，贡献者必须同步提交重新生成的 `lib/`。

安装完成后只需首次重启一次 DSH，让新 bundle 进入组合：

```sh
dsh web
```

此后插件在每次 DSH 启动时自动连接或启动守护器，不再要求额外运行 `pnpm dev`。

### 本地开发安装

```sh
git clone https://github.com/lhzcode/dsh-dev-reloader.git
cd dsh-dev-reloader
pnpm install
pnpm build
dsh plugin --profile web add link:$PWD
```

本地安装必须先产生 `lib/`，然后使用绝对 `link:` 路径。首次加载后，守护器也能监听并安全替换自身。

### GUI 操作

Web 设置区提供“开发自动重载”卡片：

- 启用/停用自动重载。
- 展示“未连接、监听中、构建中、等待任务、重启中、恢复中、失败、已暂停”等状态。
- 展示当前变更来源、构建目标和最近错误摘要。
- 提供“重新构建”和“立即重启”按钮。
- “立即重启”是显式人工覆盖；自动策略永不强制中断活动任务。

## 总体架构

### 1. Cordis 服务端桥接插件

服务端插件运行在 DSH 宿主内，职责限定为：

- 读取当前宿主 PID、Node 可执行文件、argv、cwd、Web URL 和可发现的源码根。
- 启动或连接独立守护器。
- 汇总活动 Agent 与后台任务状态。
- 将守护器状态通过同源 Web 路由提供给 client-plugin。
- 接收 GUI 启停、重建和人工重启命令，并转发给守护器。
- 在宿主即将处置时发送生命周期信号。

桥接插件不直接监听源码，也不自行重启宿主。

### 2. 独立开发守护器

守护器是从插件包 `lib/supervisor/cli.js` 启动的独立 Node 进程。它在 DSH 退出期间继续存活，负责：

- 单实例锁与本地控制通道。
- 源码根和本地插件发现。
- 文件监听、事件去抖和变更合并。
- 构建计划、构建命令和 watcher 生命周期。
- 活动任务门控。
- DSH 进程退出、端口释放、重新启动和健康检查。
- 自身新版本的无缝交接。
- 崩溃恢复、退避与诊断日志。

### 3. Web client-plugin

client-plugin 只负责本地开发体验：

- 注册设置卡片。
- 订阅桥接插件状态。
- 在计划重启前进入恢复等待状态。
- 服务断开后轮询同源健康端点。
- 发现新的 `bootId` 且服务健康后执行一次 `location.reload()`。

浏览器不会直接连接守护器，也不会获得守护器鉴权令牌。

### 4. 本地控制通道

守护器使用 Unix domain socket；Windows 使用 named pipe。通道标识和状态位于：

```text
$DSH_HOME/plugins/dsh-dev-reloader/
```

目录与令牌文件限制为当前用户访问。桥接插件与守护器执行启动握手，包含随机实例令牌、宿主 PID 和 `bootId`。守护器拒绝旧 PID、错误令牌或其他用户的连接。

控制命令可以在固定请求数、帧数和字节数上限内并发处理，并通过 `requestId` 关联乱序响应；会修改守护器状态的操作仍由内部 mutation queue 串行执行。

完整环境变量只在守护器由当前 DSH 启动时继承并保存在内存中，不写入状态文件或日志。

## 启动与接管流程

1. DSH 挂载 bundle，Cordis 调用桥接插件 `apply`。
2. 桥接插件查找有效守护器锁并尝试握手。
3. 没有守护器时，插件以 detached 方式启动 `lib/supervisor/cli.js`；有有效守护器时直接复用。
4. 守护器先采用当前正在运行的 DSH PID，不要求第一次启动就是其子进程。
5. 守护器建立监听计划并回传“监听中”。
6. 第一次完整重启后，新 DSH 由守护器作为子进程启动；新桥接实例通过相同本地通道重新握手。
7. GUI 显示当前守护器实例、监听根数量和启动时间。

### 正常停止与异常退出的区分

- 守护器主动重启时已处于 `restarting` 状态，忽略旧桥接实例的处置信号。
- 用户通过 SIGINT/SIGTERM 正常停止 DSH 时，桥接插件处置并发送 `host-disposing`；如果不存在守护器发起的重启，守护器随之退出，不重新拉起 DSH。
- HMR 暂时卸载桥接插件时，宿主 PID 仍然存活；守护器等待新桥接实例，不误判为整机停止。
- 宿主无处置握手直接消失时视为崩溃，守护器按退避策略恢复。
- 插件被禁用或卸载后，桥接心跳在宿主仍存活时持续缺失；超过配置宽限期，守护器退出并清理锁。

## 源码与插件发现

发现过程基于真实路径，避免符号链接和 pnpm 虚拟目录造成重复监听。

### DSH 源码根

按以下优先级解析：

1. 插件配置中的显式 `sourceRoots`。
2. 环境变量 `DSH_DEV_SOURCE_ROOT`。
3. 当前 argv、入口模块和 cwd 的祖先目录中，具有 DSH monorepo 标识与 `pnpm-workspace.yaml` 的 checkout。
4. 当前已安装的 `@deepseek-ai/dsh` 包根；若仅包含发布产物，则只作为运行时根，不假装存在可构建源码。

没有可用源码 checkout 时，DSH 本体监听显示为“未发现”，但本地链接插件仍可正常工作。

### 本地链接插件

读取 `$DSH_HOME/profiles/web/package.json` 的 dependencies 和 `dsh.profile.bundles`，识别：

- `workspace:`
- `link:`
- `file:`
- profile `node_modules` 中解析后真实路径位于 profile 外部的符号链接

对每个包读取 `package.json`、`dsh.bundle`、`dsh.client`、exports、scripts 和 workspace 根，形成标准化项目描述。

### 默认忽略项

- `.git/**`
- `node_modules/**`
- 临时文件与编辑器交换文件
- 构建输出目录，如 `lib/**`、`dist/**`、`coverage/**`
- 测试快照输出和日志

构建输出只由构建完成事件消费，不重新进入源码 watcher，避免循环构建。

## 变更分类与执行策略

| 变更类型 | 默认动作 |
|---|---|
| profile/home 的 `cordis.patch.yml` | 交给 DSH 内置配置 HMR |
| loader 管理的服务端插件源码 | 执行对应包构建，等待 Cordis HMR |
| client-plugin 源码 | 确保该 checkout 的 `dev:web` watcher 正在运行，交给 client HMR |
| 插件 `package.json`、bundle patch、exports、构建配置 | 构建成功后完整重启 |
| DSH Web Shell、基础包和共享普通包 | 执行官方仓库构建，成功后完整重启 |
| lockfile 或依赖关系 | 安装/构建成功后完整重启 |
| README、一般文档、测试源码、Git 元数据 | 默认忽略 |
| 无法可靠分类的运行时代码 | 失败关闭：按完整构建与重启处理 |

### 构建命令

1. 优先使用项目 `packageManager` 字段指定的 pnpm 版本。
2. client-plugin 存在 `dev:web` 时，守护器只启动一个持久 watcher 并复用。
3. 普通独立插件默认执行其 `build` script。
4. DSH monorepo 的 Web Shell 或共享包变更执行仓库官方根构建，首版不自行发明不完整的局部构建图。
5. 配置允许为特殊 checkout 覆盖 build/watch 命令，但命令以 argv 数组保存和执行，不拼接不可信 shell 字符串。

### 调度

- 默认去抖窗口由配置提供。
- 同一时间只执行一个构建周期。
- 构建期间到达的新事件合并为一个后续周期。
- 构建失败时保持旧 DSH 继续服务，记录错误，不进入重启。
- 成功构建后根据最高影响级别只执行一次 HMR 等待或完整重启。

## 活动任务门控

桥接插件周期性发送活动快照：

- 状态为 running 的 root Agent。
- DSH jobs 服务中仍在运行或停止中的后台任务。
- 守护器自己启动的构建、测试或 watcher 初始化任务。

完整重启请求进入 `pending-restart` 后：

1. 构建可以完成，但不退出 DSH。
2. 任一活动计数非零时显示“等待任务”。
3. 计数全部归零后自动继续重启。
4. 桥接断开或活动状态未知时继续等待，不设置自动超时。
5. 只有用户点击“立即重启”才能覆盖等待；该动作在 UI 中明确提示会中断任务。

服务端插件 HMR 和 client HMR 不经过完整进程门控；它们沿用 DSH 自身生命周期语义。

## 完整重启流程

1. 构建成功并满足活动门控。
2. 守护器发送 `restart-planned`，桥接插件将状态推给浏览器。
3. client-plugin 把当前 `bootId` 写入 `sessionStorage` 并开始恢复探测。
4. 守护器向旧 DSH 发送正常终止信号。
5. 等待 Cordis 资源释放和端口关闭；超过配置宽限期后才升级终止方式。
6. 以保存的 Node 可执行文件、execArgv、argv、cwd 和内存环境启动新 DSH。
7. 新桥接插件连接同一守护器并发布新 `bootId`。
8. Web 健康检查和桥接握手都通过后，状态变为 `ready`。
9. 浏览器发现健康的新 `bootId`，执行一次页面刷新并清除恢复标记。

守护器始终复用原 URL，不启动另一个替代 Web 服务。

## 守护器自身更新

当本项目以本地 `link:` 安装并修改守护器源码时：

1. 旧守护器完成本项目构建。
2. 启动新版本守护器进入 `handoff` 模式。
3. 新进程验证令牌、当前 DSH PID、监听计划和待处理状态。
4. 旧进程停止接收新事件、关闭 watcher、释放锁。
5. 新进程原子取得锁并继续监管同一个 DSH。
6. 交接失败时旧进程继续工作，不留下双实例。

桥接和 client 部分仍优先使用各自 HMR。

## 配置模型

所有字段由 Schemastery 校验并提供默认值。首版配置至少包含：

- `enabled`：是否启动守护器，默认启用。
- `profile`：默认 `web`。
- `sourceRoots`：额外源码 checkout，默认空数组并自动发现。
- `webUrl`：默认从当前 Web 宿主解析。
- `debounceMs`：文件事件去抖窗口。
- `healthTimeoutMs`：新宿主健康检查总时限。
- `shutdownGraceMs`：正常退出宽限期。
- `bridgeGraceMs`：HMR 或启动期间等待桥接重新出现的时限。
- `crashWindowMs` 与 `maxCrashRestarts`：崩溃循环熔断。
- `ignored`：附加忽略 glob。
- `projectOverrides`：特殊源码根的构建/watcher argv 覆盖。
- `logLevel`：守护器日志等级。

修改配置时，桥接插件通过动态设置源把新配置发送给守护器。影响 watcher 的字段触发监听计划原子替换；`enabled: false` 显式停止守护器。

## 状态机

守护器对 GUI 暴露稳定状态：

```text
starting
  -> watching
  -> building
  -> hmr-wait
  -> pending-restart
  -> restarting
  -> recovering
  -> watching

任意可恢复状态 -> degraded
连续崩溃或不可恢复错误 -> failed
用户关闭 -> paused
```

状态事件包含时间、原因、受影响项目和有界错误摘要，不包含环境变量、令牌或完整敏感命令输出。

## 错误处理

### 构建失败

- 不停止当前 DSH。
- 保留最近一次成功构建产物。
- GUI 显示失败项目、退出码和截断日志。
- 下一次源码修改重新尝试。

### 守护器重复启动

- 锁文件同时记录 PID、进程启动事实和实例令牌。
- 新实例先验证旧 PID 与 socket，再决定复用或回收陈旧锁。
- 无法证明旧实例失效时拒绝抢锁。

### DSH 崩溃循环

- 使用指数退避。
- 在配置窗口内超过最大次数后进入 `failed`，停止自动拉起。
- 用户可从 GUI 或重新启动 DSH 后显式恢复。

### watcher 或发现失败

- 单个项目失败不会关闭其他 watcher。
- 无法监听的根标记为 degraded。
- 所有 watcher 都失败时仍保留桥接和人工重启能力。

### 健康检查失败

- 浏览器不刷新。
- 守护器保留失败子进程日志位置和最后健康错误。
- 若子进程仍在运行但不健康，不无限创建更多进程。

## 安全边界

1. 功能仅对环回 Web 宿主启用；非环回访问只能查看脱敏状态，不能触发重启。
2. GUI 写操作要求同源请求，并由服务端验证本地连接。
3. 本地控制 socket/pipe 和令牌文件仅当前用户可访问。
4. 不持久化完整环境变量、认证信息或启动令牌。
5. 进程启动使用可执行文件和 argv 数组，不用字符串拼接 shell。
6. watcher 只进入自动发现或用户明确配置的真实目录。
7. 构建脚本属于本地源码项目的受信代码；README 明确其会消耗真实本机资源。
8. 自动模式不强制中断活动任务，未知状态默认等待。

## 项目目录

```text
dsh-dev-reloader/
├── package.json
├── pnpm-lock.yaml
├── cordis.patch.yml
├── tsconfig.json
├── tsdown.config.ts
├── README.md
├── README.zh.md
├── LICENSE
├── src/
│   ├── index.ts
│   ├── client/
│   │   ├── index.tsx
│   │   ├── SettingsCard.tsx
│   │   └── reconnect.ts
│   ├── supervisor/
│   │   ├── cli.ts
│   │   ├── supervisor.ts
│   │   ├── discovery.ts
│   │   ├── watcher.ts
│   │   ├── classifier.ts
│   │   ├── builder.ts
│   │   ├── health-check.ts
│   │   ├── lifecycle.ts
│   │   └── handoff.ts
│   └── shared/
│       ├── protocol.ts
│       └── state.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── scripts/
│   └── link-dsh-workspace.mjs
└── docs/
    ├── README.md
    ├── architecture.md / architecture.html
    ├── design.md
    └── implementation-plan.md
```

模块边界如下：

- `src/index.ts` 只适配 Cordis 与 DSH 服务。
- `src/supervisor/supervisor.ts` 只编排状态机，不直接实现路径发现或文件分类。
- `discovery.ts` 输出纯项目描述，便于独立测试。
- `classifier.ts` 输入项目描述与路径，输出确定性动作计划。
- `builder.ts` 执行计划并返回结构化结果。
- `lifecycle.ts` 独占宿主进程与端口生命周期。
- `protocol.ts` 是宿主、守护器和客户端状态的唯一协议定义。

## README 结构

遵循 DSH 插件仓库惯例：英文 `README.md` 为默认入口，中文内容放入 `README.zh.md`，两者互相链接。README 包含：

1. 项目用途与本地开发限定。
2. 功能概览。
3. DSH 兼容版本矩阵。
4. GitHub bundle 的预编译、无安装脚本安装说明。
5. 本地 clone/build/link 安装。
6. 首次启动、GUI 开关和状态说明。
7. 自动发现与变更分类规则。
8. 可选配置示例。
9. 日志、故障排查、停用和卸载。
10. 安全边界。
11. 开发、测试和贡献方式。
12. 许可证。

README 不点名比较其他社区插件。

## 测试策略

### 单元测试

覆盖：

- DSH 源码根和本地链接插件发现。
- 符号链接去重与忽略规则。
- 文件分类和最高影响级别合并。
- 去抖、脏标记和串行构建调度。
- 活动任务门控。
- 状态机合法转换。
- argv 构造与脱敏日志。
- PID 锁、陈旧锁和 handoff。
- crash backoff 与熔断。
- client 的 `bootId` 恢复判断。

### 集成测试

使用临时 `DSH_HOME`、fixture 插件和临时端口验证：

1. bundle 能被 profile 识别并组合。
2. 插件加载后只启动一个守护器。
3. 服务端源码构建后走 HMR 路径。
4. client 源码由持久 watcher 处理。
5. manifest 或 Shell 变更触发完整重启。
6. 活动任务期间重启保持 pending，结束后继续。
7. 构建失败不影响旧服务。
8. 同 URL 健康恢复后 client 只刷新一次。
9. 正常 SIGINT 停止时守护器不复活 DSH。
10. 无处置信号崩溃时按退避恢复。
11. 守护器自身版本交接不产生双实例。

集成测试不得占用当前 `3080`，也不得启动替代当前 GUI 的服务器。

### 最终人工验证

自动测试通过后，在用户明确执行开发验证时：

- 使用当前 Web profile 安装本地 `link:` 包。
- 刷新现有 `http://127.0.0.1:3080`。
- 分别修改一个 host 插件、client-plugin 和需要完整重启的 Web Shell 测试夹具。
- 验证活动任务等待、健康恢复和页面自动刷新。

## 验收标准

1. 项目能以官方 bundle 形式通过 `dsh plugin --profile web add` 安装。
2. `dsh --profile web --dump-config` 中恰有一个启用的桥接插件行。
3. 首次手动重启后，插件自动启动守护器，不需要额外开发命令。
4. DSH 源码 checkout 与本地链接插件能被自动发现；不存在源码 checkout 时明确降级而不误报。
5. 四类更新路径均按设计工作：配置 HMR、Cordis HMR、client HMR、完整构建重启。
6. 完整重启在活动任务结束前不会发生。
7. 构建失败不会停止当前 DSH。
8. 重启复用原 cwd、argv、环境和 URL；健康后浏览器自动刷新一次。
9. 用户正常停止 DSH 时守护器退出；宿主崩溃时守护器有界恢复。
10. GUI 能启停、显示状态、重新构建和人工覆盖等待。
11. 控制通道、日志和状态文件不泄露 secret。
12. 单元与集成测试通过，README 与实际安装流程一致。

## 交付与仓库

项目在独立公开仓库维护：`https://github.com/lhzcode/dsh-dev-reloader`。

仓库发布 GitHub 源码，默认不发布 npm；Tag、Release 与其他分发动作独立执行。
