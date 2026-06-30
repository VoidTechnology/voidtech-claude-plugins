# Changelog

## 0.8.3 - 2026-06-30

### Changed

- 更新检查从单纯的命令提示改为「先征求同意」：发现新版时由助手先询问用户是否现在升级，同意后才运行更新命令并提醒重开会话生效，拒绝则当次会话不再提及。钩子自身仍只注入上下文，不自动改动本地插件或 Marketplace。

## 0.8.2 - 2026-06-30

### Changed

- `to-prd` 发布前默认按 `text-naturalizer` 规则润色 PRD 正文，去掉模板腔和抽象表达，同时保留事实、结构、范围与决策内容。
- `to-issues` 发布前增加轻量文案自审，只处理标题、目标描述和背景说明，不改写验收标准、依赖、标签、代码片段、接口名、字段名或业务术语。

## 0.8.1 - 2026-06-30

### Changed

- 继续审查 22 个核心技能及其参考文件的中文表达，清理“追问”“提取能力”“极其详尽”“每片切片”等不贴合中文工程语境的表述。
- 将部分发布文档中的“逻辑闭环”“心智模型”“沉淀架构决策”等抽象表达改为更直接的中文。

## 0.8.0 - 2026-06-30

### Changed

- 将 `domain-modeling` 技能迁移为 `feature-context`，降低 `domain` 在中文语境中的理解成本。
- 同步更新跨技能调用、使用指南、审计文档和可移植性检查中的公共技能名称契约。
- 将 `voidtech-core` 版本提升到 `0.8.0`。

## 0.7.0 - 2026-06-26

### Added

- 新增 `research` 技能：对陌生问题开展多信源开放网络调研，优先委派低成本子 agent 使用官方 `exa`、`firecrawl`、`youdotcom-agent-skills` 收集证据，再由主 agent 汇总结论、分歧、风险和建议。
- 在 README、上手指南和使用指南中补充开放网络调研工作流，以及 `exa`、`firecrawl`、`youdotcom-agent-skills` 官方插件的安装与配合方式。

## 0.6.0 - 2026-06-26

### Added

- 为 `voidtech-core` 增加 `SessionStart` 更新检查：每天最多访问一次远端 `plugin.json`，发现新版本时提示用户运行 Marketplace 与插件更新命令。
- 增加更新检查脚本的行为测试，覆盖版本相同静默、发现新版本提示、缓存有效期内不重复检查、离线静默降级。
- 在安装、使用与 issue 跟踪器契约中补充 `gh`、`glab` CLI 依赖、安装命令与认证检查。
- 新增 `ship` 技能：审查当前 diff、运行验证、提交、推送，并使用 `gh` 或 `glab` 创建 PR/MR；PR/MR 标题和正文必须按 `text-naturalizer` 的口吻规则润色。
- 在 README、上手指南和使用指南中补充官方插件搭配建议，说明推荐安装项、工作流接入点和不建议重复安装的插件。

## 0.5.0 - 2026-06-24

### Changed

- 审查 20 个核心技能及其参考文件的汉化内容，清理生硬直译、夸张比喻、口语化表达和未解释的中英混用。
- 统一技能入口说明、工作流标题、Issue 模板和架构术语的中文表达；保留命令、字段名、代码块及必要的通用技术术语。
- 重写技能写作术语表和学习类参考格式，使定义更短、更直接，并在首次出现时解释必要术语。
- 增加汉化文案回归检查，防止已淘汰的生硬译法重新进入发布技能。

## 0.4.0 - 2026-06-24

### Changed

- 对 20 个核心技能完成插件内自洽性审计，清除对未分发上游命令、目录和远程前端运行时的依赖。
- 为 issue 工作流增加插件内跟踪器适配契约、标签发现、认证检查与 Markdown 草稿降级路径。
- 随附脚本统一通过 `${CLAUDE_PLUGIN_ROOT}` 定位；Git 防护脚本增加输入校验与行为测试。
- 架构审查报告改为纯内联 HTML、CSS 与 SVG，断网时仍可完整阅读。
- 修正技能编写指南，使调用可见性与当前 Claude Code 的 `disable-model-invocation`、`user-invocable` 语义一致。
- 补齐 `text-naturalizer` 的本地许可证，并将第三方声明更新为“已汉化并完成插件内自包含适配”。

## 0.3.0 - 2026-06-24

### Changed

- 将 11 个不够直观的技能命令迁移为简单英文名称：`debug`、`git-safety`、`plan-review`、`plan-review-docs`、`plan-review-core`、`architecture-review`、`fix-conflicts`、`setup-git-checks`、`learn`、`prepare-issue`、`write-skills`。
- 保留 `codebase-design`、`domain-modeling`、`handoff`、`implement`、`prototype`、`tdd`、`text-naturalizer`、`to-issues`、`to-prd`。
- 将 `plan-review-core` 标记为仅供模型编排的内部技能，不在用户命令菜单中展示。
- 增加核心技能公共命令名称契约检查，避免目录名与展示名再次漂移。

## 0.2.0 - 2026-06-23

### Changed

- 将 `voidtech-toolkit` 拆分为 `voidtech-core`、`voidtech-mcp-common` 与 `voidtech-mcp-apple`。
- MCP 改为默认禁用并固定本地执行包版本。
- 中文约定改为每个会话注入一次。

### Removed

- 从发布区移除依赖完整 gstack 运行时的 8 个技能。
- 从工作树删除缺少明确许可证的 `karpathy-guidelines` 原文，只保留审计记录。
- 停止分发已废弃的 GitHub npm MCP、第三方 Figma MCP、Desktop Commander 与 Fetch MCP。

### Added

- 增加可移植性检查、隔离安装冒烟测试与 GitHub Actions 质量门。
