# ADR-0001：拆分核心技能与可选 MCP

## 状态

已接受

## 日期

2026-06-23

## 背景

原 `voidtech-toolkit` 把技能、中文 hook 和 8 个 MCP 放在同一个默认启用的插件中。安装插件会同时暴露所有 MCP；其中本地服务依赖 Node.js 或 uv，Apple 服务只适用于 macOS，GitHub 包已经废弃，Figma 又与“使用官方插件”的既有决策冲突。

同一个插件还包含 8 个从 gstack 直接复制的技能。这些技能需要未随插件分发的 `~/.gstack` 状态、`gstack/bin`、遥测流程和其他已删除技能，因此能被发现但不能独立运行。

## 决策

1. 将默认插件改为 `voidtech-core`，只保留中文约定和自包含技能。
2. 将 MCP 拆成默认禁用的 `voidtech-mcp-common` 与 `voidtech-mcp-apple`。
3. 本地 MCP 包固定精确版本；Context7 改用官方 HTTPS 远端服务。
4. GitHub 操作默认使用 `gh`，Figma 使用官方插件。
5. 不可移植的 gstack 技能移出插件目录，待独立重写后逐个恢复。
6. 无法证明许可证的 `karpathy-guidelines` 移出发布区。
7. 中文约定改为 `SessionStart` 注入一次，不再每轮重复注入。

## 备选方案

### 保持单体插件并修补路径

改动较小，但无法解决不同平台、权限范围、依赖安装和 MCP 默认启动之间的耦合。

### 完全引用所有上游插件

维护成本最低，但无法物理去重、统一中文体验或控制团队发布节奏。

## 影响

- 旧插件 ID `voidtech-toolkit@voidtech` 被 `voidtech-core@voidtech` 取代，需要成员执行一次迁移。
- 只安装核心插件的成员不再需要 Node.js、uv 或任何 MCP 密钥。
- 需要浏览器或 Apple 工具的成员必须显式安装并启用相应 MCP 插件。
- 为支持 `defaultEnabled: false`，最低 Claude Code 版本为 2.1.154。
- gstack 的发布、评审、设计和性能能力暂时不可用，直到完成自包含重写。
