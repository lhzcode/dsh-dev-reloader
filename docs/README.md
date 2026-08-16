# 文档索引

架构、设计与实施文档统一收纳在本目录。DSH 包入口 README 与 `CHANGELOG.md` 保留在仓库根目录；GitHub 识别的贡献指南和安全策略保留在 `.github/`。

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 当前 | 三进程边界、IPC 信任边界、变更分类、状态机与重启序列 |
| [architecture.html](architecture.html) | 当前 | 可在浏览器中直接打开的可视化架构页；图内容与架构文档保持一致 |
| [design.md](design.md) | 设计基线 | 已确认的完整设计与安全约束 |
| [implementation-plan.md](implementation-plan.md) | 历史计划 | 已执行的分阶段 TDD 实施计划，保留用于追溯 |

## 事实来源优先级

发生冲突时按以下顺序判断：

1. 当前源码、`package.json`、`cordis.patch.yml` 与测试。
2. 当前用户文档：根目录 README 与 `architecture.md`。
3. `design.md` 的设计约束。
4. `implementation-plan.md` 的历史记录。

## 维护规则

- 新增非包入口文档时直接放在 `docs/`，避免重新创建多层临时计划目录。
- 行为、配置、命令或安全边界变化时，同时更新中英文 README 与架构文档。
- `architecture.html` 只负责可视化呈现；不要让它成为独立的架构事实来源。
