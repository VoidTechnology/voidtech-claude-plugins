# voidtech-claude-plugins

> VoidTech 内部 Claude Code 插件市场：中文工程工作流、可机器验收的工程内循环，以及按需启用的 MCP。

`voidtech-core v0.11.2` · `voidtech-loop v0.2.0` · Claude Code ≥ 2.1.154（loop ≥ 2.1.210） · 内部分发

VoidTech 团队的 Claude Code Marketplace。`voidtech-core` 固化团队工程方法，`voidtech-loop` 负责有机器验收条件的无人值守工程循环；高权限 MCP 仍按需启用。

## 亮点

- **25 个自包含工程技能 + 2 个专业 subagent**，覆盖从调研到交付的完整生命周期（调研、规划、设计、实现、调试、Git、协作），不依赖插件目录之外的脚本或运行时。
- **独立的工程内循环**：`voidtech-loop` 用不可变 Goal Spec、隔离 worktree 和指定 commit eval 推进可机器判定的任务；验收通过后仍由人复核、接受和合入。
- **中文协作约定**：核心插件通过 `SessionStart` hook 注入团队的中文交流约定，代码与标识符仍用英文。
- **每日更新提示**：核心插件每天最多检查一次远端版本；只提示更新命令，不自动修改本地环境。
- **副作用受用户掌控**：会提交、推送、合并、部署的动作只在你显式要求时发生。
- **MCP 与核心能力分离**：通用与 Apple 两组 MCP 默认禁用、固定精确版本，按需启用。
- **发布即合规**：第三方技能保留来源、上游 commit 与许可证；可移植性由自动检查约束。

## 快速开始

```bash
# 1. 添加 Marketplace
claude plugin marketplace add VoidTechnology/voidtech-claude-plugins

# 2. 安装核心工作流（MCP 按需安装）
claude plugin install voidtech-core@voidtech

# 3. 试点环境再安装工程内循环：macOS arm64、Claude Code 2.1.210+、Node.js 18+
claude plugin install voidtech-loop@voidtech
```

`voidtech-loop` 一期工程内循环已经完成，当前试点环境仅支持 macOS arm64；不满足试点环境时可以只安装 `voidtech-core`。

进入 Claude Code 后即可调用技能，例如：

```text
/voidtech-core:research "比较 iOS 崩溃日志脱敏方案，给出当前证据、风险和选型建议"
/voidtech-core:to-prd "把刚才已经讨论清楚的支付回调需求整理成单体 PRD"
/voidtech-core:prd-from-requirements "读取 docs/raw-requirements.xlsx，生成可追溯的模块化 PRD 工作树"
/voidtech-core:prototype "用一次性终端原型验证订单状态机能否处理乱序事件"
/voidtech-core:debug "支付回调偶发重复入账，先建立稳定复现再定位根因"
/voidtech-loop:goal "修复支付模块测试" --check "npm test -- payment" --max-iterations 12
/voidtech-loop:goal-spec "迁移支付 API，保持契约测试通过，并保护公开 fixtures"
```

`to-prd` 和 `prd-from-requirements` 处理的是两类输入，不应串着使用。`prototype` 只回答一个明确的设计问题，产物不能直接当作生产实现。完整边界见 [USAGE.md](docs/USAGE.md)。

完整安装、迁移与 MCP 配置见 [ONBOARDING.md](ONBOARDING.md)；每个技能的用途与工作流见 [USAGE.md](docs/USAGE.md)。

## AI 一键安装（复制提示词）

不想手敲命令？把下面整段提示词复制给 Claude Code，它会自动添加 Marketplace、安装核心插件和工程内循环，并按[官方插件搭配](#官方插件搭配)矩阵补齐增强插件。提示词内已带上仓库地址，避免模型无法定位本仓库。

```text
请帮我安装 VoidTech 的 Claude Code 插件市场及其官方搭配插件。

仓库地址：https://github.com/VoidTechnology/voidtech-claude-plugins
（GitHub 简写：VoidTechnology/voidtech-claude-plugins）

按以下步骤执行，每步用 claude CLI 完成并校验结果：

【第 1 步：添加 Marketplace，安装核心插件和工程内循环】
- claude plugin marketplace add https://github.com/VoidTechnology/voidtech-claude-plugins
  （若该写法不被支持，改用 GitHub 简写：claude plugin marketplace add VoidTechnology/voidtech-claude-plugins）
- claude plugin install voidtech-core@voidtech
- 检查 uname -s、uname -m、claude --version、node --version、git 和 jq；仅在 macOS arm64、Claude Code 2.1.210+、Node.js 18+ 且命令齐全时执行：claude plugin install voidtech-loop@voidtech。不满足时跳过并说明缺口。
voidtech-core 提供 25 个自包含中文工程技能 + 2 个专业 subagent + 中文协作约定（SessionStart hook）。
voidtech-loop 提供 goal 与 goal-spec：只用于完成条件可由命令退出码判定的工程任务；它不会自动 push、merge、建 PR 或改写用户分支。

【第 2 步：按搭配矩阵安装官方插件（来自 claude-plugins-official）】
安装命令格式：claude plugin install <名称>@claude-plugins-official
要安装的插件：
- plugin-dev            （配 write-skills：补充 hooks/commands/MCP/打包）
- frontend-design、figma （frontend-design 做生产级界面，figma 接入设计稿；prototype 仅用于一次性方案比较）
- security-guidance      （配 git-safety：代码安全风险提醒）
- sentry、datadog、posthog、amplitude （配 debug：线上问题需生产证据时按监控栈启用）
- swift-lsp、kotlin-lsp、typescript-lsp、pyright-lsp （大型代码库重构/跳转/引用分析）

【第 3 步：发布前审查插件——二选一，装一个即可，避免重复审查噪音】
先问我要 pr-review-toolkit（多 agent、覆盖全）还是 code-review（轻量、低噪音），
按我的选择只安装其中一个（同样 @claude-plugins-official）。

【要求】
- 安装前先列出 marketplace 实际存在的插件名，确认拼写无误再装。
- 逐个安装并汇报每个的成功/失败；失败的给出原因。
- 全部完成后用 claude plugin list 输出最终启用清单。
- 提醒我：插件在下次启动会话后生效；sentry/datadog/posthog/amplitude/figma 等 MCP 型插件首次使用需登录或配置 API key；LSP 插件依赖本机对应语言工具链。
- 提醒我：voidtech-loop 当前为一期试点版，仅支持 macOS arm64；不满足试点条件时跳过 loop，不影响 core 使用。
```

## 包含的插件

| 插件 | 版本 | 默认 | 内容 |
|---|---|---|---|
| [`voidtech-core`](plugins/voidtech-core) | 0.11.2 | ✅ 启用 | 中文约定 + 25 个自包含工程技能 + 2 个专业 subagent |
| [`voidtech-loop`](plugins/voidtech-loop) | 0.2.0 | ✅ 启用 | Goal Spec + 确定性控制器 + 隔离 worktree + 指定 commit 验收（一期试点版） |
| [`voidtech-mcp-common`](plugins/voidtech-mcp-common) | 0.1.0 | ⛔ 禁用 | Context7（库文档）、Chrome DevTools（无头浏览器验证） |
| [`voidtech-mcp-apple`](plugins/voidtech-mcp-apple) | 0.1.0 | ⛔ 禁用 | Apple Docs、XcodeBuildMCP（iOS/macOS 开发） |

MCP 插件安装后需 `claude plugin enable <plugin>@voidtech` 启用，并在首次连接时审查权限。

## 官方插件搭配

`voidtech-core` 负责团队默认工程工作流；官方插件适合作为按需增强层。推荐先安装核心插件，再按项目场景补充官方插件：

| 场景 | 推荐官方插件 | 搭配方式 |
|---|---|---|
| 维护本仓库这类 Claude plugin | `plugin-dev` | 辅助开发 hooks、skills、commands、MCP 集成 |
| 代码安全提醒 | `security-guidance` | 和 `git-safety` 互补；前者看代码风险，后者防危险 Git 命令 |
| PR/MR 二次审查 | `pr-review-toolkit` 或 `code-review` | 优先放在 `/voidtech-core:ship` 前；若 PR/MR 已创建，则在合并前审查，二选一即可 |
| 前端视觉实现 | `frontend-design` | 生产级 UI 直接使用 `frontend-design`。只有需要比较多个结构方案时，才先用 `prototype` 做一次性验证；选定方案后，清理原型脚手架并补齐生产级实现 |
| 设计稿协作 | `figma` | 使用官方 Figma 插件，不在 VoidTech Marketplace 分发第三方替代 |
| 开放网络调研 | `exa`、`firecrawl`、`youdotcom-agent-skills` | 和 `research` 搭配；官方插件负责搜索、抓取和带引用研究，VoidTech 技能负责分工、证据分级和决策建议 |
| 线上排障 | `sentry`、`datadog`、`posthog` 等 | 按团队实际监控栈安装，不作为默认依赖 |
| 语言服务 | `swift-lsp`、`kotlin-lsp`、`typescript-lsp` 等 | 按项目语言启用，增强代码导航与重构 |

不建议常态重复安装：`commit-commands` 与 `ship` 重叠，`feature-dev` 与 `to-prd`/`to-issues`/`implement` 重叠，`superpowers` 会引入另一套工程方法论，`context7` 和 `chrome-devtools-mcp` 已由 `voidtech-mcp-common` 覆盖。

## 核心技能一览

按软件生命周期分四组，全部以 `/voidtech-core:<skill>` 调用。完整用法、触发规则、编排关系与场景速查见 [USAGE.md](docs/USAGE.md)。

- **调研、规划与设计** — `research`、`feature-context`、`codebase-design`、`to-prd`、`prd-from-requirements`、`prd-maintain`、`to-design-brief`、`to-issues`、`prepare-issue`、`plan-review`、`plan-review-docs`
- **实现与验证** — `implement`、`tdd`、`prototype`、`debug`、`architecture-review`、`ship`
- **Git 与安全** — `git-safety`、`setup-git-checks`、`fix-conflicts`
- **协作与文档** — `handoff`、`learn`、`text-naturalizer`、`write-skills`

## 核心 subagent 一览

安装并启用 `voidtech-core` 后，可通过 @ mention 使用插件命名空间下的专业 subagent：

- `voidtech-core:architect`：只读侦察复杂技术问题，产出架构方案、模块边界、接口设计、风险与实施顺序。
- `voidtech-core:product-manager`：把模糊想法转成用户场景、MVP 边界、PRD/User Story 与体验评审结论。

## 工程内循环

`voidtech-loop` 是独立插件，只在任务有明确、可机器判定的完成条件时使用：

- `/voidtech-loop:goal`：用一条 `--check` 命令启动简单循环；`--max-iterations` 必须由用户指定。
- `/voidtech-loop:goal-spec`：把多 target、invariant、protected paths 或 manual review 组成的复杂任务编译为 Goal Spec；它只生成并验证规格，不会自动启动循环。

循环在独立 worktree 和专属分支上运行。`EVALS_PASSED` 只表示指定 commit 通过约定的 eval，仍需人工复核；循环不会自动 push、merge、创建 PR/MR 或改写用户分支。一期试点版仅支持 macOS arm64，要求 Claude Code 2.1.210 或更高版本，并依赖 Node.js 18+、Git 与 `jq`。详细用法见 [USAGE.md](docs/USAGE.md#9-voidtech-loop-工程内循环)。

## 仓库结构

```text
.claude-plugin/marketplace.json   Marketplace 清单
plugins/
  voidtech-core/                  中文约定 + 25 个自包含工程技能 + 2 个专业 subagent（含 SessionStart hook）
  voidtech-loop/                  Goal Spec、确定性控制器、隔离 worktree 与指定 commit 验收
  voidtech-mcp-common/            可选：Context7、Chrome DevTools
  voidtech-mcp-apple/             可选：Apple Docs、XcodeBuildMCP
docs/                             审计、ADR 与使用指南
scripts/check-portability.sh      可移植性与合规检查
templates/project-settings.json   项目 .claude/settings.json 合入样板
```

## 文档导航

| 文档 | 用途 |
|---|---|
| [ONBOARDING.md](ONBOARDING.md) | 安装、迁移、MCP 与外部工具配置 |
| [USAGE.md](docs/USAGE.md) | 技能用法、工作流与场景速查 |
| [TRIAGE.md](TRIAGE.md) | 第三方技能的处置依据 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [docs/SKILL-CLOSURE-AUDIT.md](docs/SKILL-CLOSURE-AUDIT.md) | 逐技能自洽性证据 |
| [docs/SKILL-LANGUAGE-AUDIT.md](docs/SKILL-LANGUAGE-AUDIT.md) | 中文可读性审计 |
| [docs/PORTABILITY-AUDIT.md](docs/PORTABILITY-AUDIT.md) | 可移植性与合规审计 |
| [voidtech-loop PRD](docs/prd-voidtech-loop-2026-07-15.md) | 工程内循环的一期范围、用户路径与安全边界 |
| [voidtech-loop 技术设计](docs/tech-design-voidtech-loop-2026-07-15.md) | 控制器、Git 隔离、验收与状态设计 |
| [voidtech-loop 二期 PRD](docs/prd-voidtech-loop-phase-2-2026-07-16.md) | Agent-first Review、Decision Authority、授权级别与质量门 |
| [voidtech-loop 二期技术设计](docs/tech-design-voidtech-loop-phase-2-2026-07-16.md) | Operation Journal、Execution Plan、补充验证与 snapshot review |
| [voidtech-loop 二期实施计划](docs/implementation-plan-voidtech-loop-phase-2-2026-07-16.md) | 按依赖拆分的工程里程碑、任务、验收与检查点 |
| [ADR-0001](docs/decisions/0001-split-core-and-optional-mcp.md) | 核心与可选 MCP 拆分 |
| [ADR-0002](docs/decisions/0002-rename-core-skills.md) | 核心技能命名 |
| [ADR-0003](docs/decisions/0003-agent-first-review-and-decision-authority.md) | Agent-first Review 与确定性 Decision Authority |

## 本地开发与验证

前置条件：core 需要 Claude Code 2.1.154 或更高版本；loop 需要 2.1.210 或更高版本、macOS arm64、Node.js 18+、Git 与 `jq`。本仓库验证还使用 `rg`、`gh`、`glab`。

```bash
brew install gh glab
gh auth login
glab auth login
```

```bash
scripts/check-portability.sh                 # 静态检查 + Claude 官方严格校验
scripts/check-portability.sh --install-smoke # 额外在隔离配置目录安装全部四个插件
```

## 发布流程

1. 修改插件内容时，提升该插件 `plugin.json` 的语义化版本（版本是发布边界）。
2. 运行完整可移植性检查。
3. 检查 `git diff`，确认没有密钥、浮动依赖或归档技能回流。
4. 推送 Marketplace 仓库后，让成员执行 `claude plugin marketplace update voidtech` 与对应插件更新。
5. 项目仓库启用 `voidtech-core`；`voidtech-loop` 按试点安排安装，MCP 插件由成员按需安装。

## 分发原则

- 核心插件不得依赖插件目录之外的脚本、状态或配置。
- 跨技能调用必须指向同一插件已发布的完整技能名；随附资源使用插件内路径，缺失外部服务时必须有明确降级结果。
- MCP 与核心技能分离，默认禁用，并固定本地执行包的精确版本。
- GitHub 操作优先使用 `gh`，GitLab 操作优先使用 `glab`；Figma 使用官方插件，不再分发第三方 MCP。
- 第三方技能只有在许可证允许时才能 vendored，并保留来源、上游 commit 与许可证。
- 会提交、推送、合并或部署的工作流只能由用户显式触发。
- `voidtech-loop` 只验收指定 commit，不自动 push、merge、创建 PR/MR 或改写用户分支；`EVALS_PASSED` 不能替代人工复核。
- 面向团队的技能命令使用简单、常见且能直接表达动作的英文；成熟技术术语与既有短命令保持稳定。
- 只承担技能编排的内部能力使用 `user-invocable: false`，避免污染用户命令菜单。
