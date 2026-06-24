# voidtech-claude-plugins

> VoidTech 内部 Claude Code 插件市场：一套自包含的中文工程工作流，加上按需启用的 MCP。

`Claude Code ≥ 2.1.154` · `voidtech-core v0.5.0` · 内部分发

VoidTech 团队的 Claude Code Marketplace。它把团队约定固化成可独立安装、可验证、许可证明确的插件，让每位成员开箱即用同一套工程方法论，而把高权限的 MCP 留作按需启用。

## 亮点

- **20 个自包含工程技能**，覆盖从想法到交付的完整生命周期（规划、设计、实现、调试、Git、协作），不依赖插件目录之外的脚本或运行时。
- **中文协作约定**：核心插件通过 `SessionStart` hook 注入团队的中文交流约定，代码与标识符仍用英文。
- **副作用受用户掌控**：会提交、推送、合并、部署的动作只在你显式要求时发生。
- **MCP 与核心能力分离**：通用与 Apple 两组 MCP 默认禁用、固定精确版本，按需启用。
- **发布即合规**：第三方技能保留来源、上游 commit 与许可证；可移植性由自动检查约束。

## 快速开始

```bash
# 1. 添加 Marketplace
claude plugin marketplace add VoidTechnology/voidtech-claude-plugins

# 2. 安装核心插件（其余 MCP 按需安装）
claude plugin install voidtech-core@voidtech
```

进入 Claude Code 后即可调用技能，例如：

```text
/voidtech-core:to-prd        把当前讨论综合成 PRD
/voidtech-core:tdd           红绿重构地实现功能
/voidtech-core:debug         系统化定位疑难缺陷
```

完整安装、迁移与 MCP 配置见 [ONBOARDING.md](ONBOARDING.md)；每个技能的用途与工作流见 [USAGE.md](docs/USAGE.md)。

## 包含的插件

| 插件 | 版本 | 默认 | 内容 |
|---|---|---|---|
| [`voidtech-core`](plugins/voidtech-core) | 0.5.0 | ✅ 启用 | 中文约定 + 20 个自包含工程技能 |
| [`voidtech-mcp-common`](plugins/voidtech-mcp-common) | 0.1.0 | ⛔ 禁用 | Context7（库文档）、Chrome DevTools（无头浏览器验证） |
| [`voidtech-mcp-apple`](plugins/voidtech-mcp-apple) | 0.1.0 | ⛔ 禁用 | Apple Docs、XcodeBuildMCP（iOS/macOS 开发） |

MCP 插件安装后需 `claude plugin enable <plugin>@voidtech` 启用，并在首次连接时审查权限。

## 核心技能一览

按软件生命周期分四组，全部以 `/voidtech-core:<skill>` 调用。完整用法、触发规则、编排关系与场景速查见 [USAGE.md](docs/USAGE.md)。

- **规划与设计** — `domain-modeling`、`codebase-design`、`to-prd`、`to-issues`、`prepare-issue`、`plan-review`、`plan-review-docs`
- **实现与验证** — `implement`、`tdd`、`prototype`、`debug`、`architecture-review`
- **Git 与安全** — `git-safety`、`setup-git-checks`、`fix-conflicts`
- **协作与文档** — `handoff`、`learn`、`text-naturalizer`、`write-skills`

## 仓库结构

```text
.claude-plugin/marketplace.json   Marketplace 清单
plugins/
  voidtech-core/                  中文约定 + 20 个自包含工程技能（含 SessionStart hook）
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
| [docs/SKILL-CLOSURE-AUDIT.md](docs/SKILL-CLOSURE-AUDIT.md) | 逐技能逻辑闭环证据 |
| [docs/SKILL-LANGUAGE-AUDIT.md](docs/SKILL-LANGUAGE-AUDIT.md) | 中文可读性审计 |
| [docs/PORTABILITY-AUDIT.md](docs/PORTABILITY-AUDIT.md) | 可移植性与合规审计 |
| [ADR-0001](docs/decisions/0001-split-core-and-optional-mcp.md) | 核心与可选 MCP 拆分 |
| [ADR-0002](docs/decisions/0002-rename-core-skills.md) | 核心技能命名 |

## 本地开发与验证

前置条件：Claude Code 2.1.154 或更高版本、`jq`、`rg`。

```bash
scripts/check-portability.sh                 # 静态检查 + Claude 官方严格校验
scripts/check-portability.sh --install-smoke # 额外在隔离配置目录安装全部三个插件
```

## 发布流程

1. 修改插件内容时，提升该插件 `plugin.json` 的语义化版本（版本是发布边界）。
2. 运行完整可移植性检查。
3. 检查 `git diff`，确认没有密钥、浮动依赖或归档技能回流。
4. 推送 Marketplace 仓库后，让成员执行 `claude plugin marketplace update voidtech` 与对应插件更新。
5. 项目仓库只默认启用 `voidtech-core`；MCP 插件由成员按需安装。

## 分发原则

- 核心插件不得依赖插件目录之外的脚本、状态或配置。
- 跨技能调用必须指向同一插件已发布的完整技能名；随附资源使用插件内路径，缺失外部服务时必须有明确降级结果。
- MCP 与核心技能分离，默认禁用，并固定本地执行包的精确版本。
- GitHub 操作优先使用 `gh`；Figma 使用官方插件，不再分发第三方 MCP。
- 第三方技能只有在许可证允许时才能 vendored，并保留来源、上游 commit 与许可证。
- 会提交、推送、合并或部署的工作流只能由用户显式触发。
- 面向团队的技能命令使用简单、常见且能直接表达动作的英文；成熟技术术语与既有短命令保持稳定。
- 只承担技能编排的内部能力使用 `user-invocable: false`，避免污染用户命令菜单。
