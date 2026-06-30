# ADR-0002：统一核心技能命令命名

## 状态

已接受

## 日期

2026-06-24

## 背景

核心插件中的部分技能沿用了上游命名。这些名称包含俚语、实现细节或冗长短语，在中文团队语境下不容易从命令名直接判断用途，也增加了记忆与沟通成本。

Claude Code 使用技能目录名生成插件命令，frontmatter 中的 `name` 只负责展示。因此，命令迁移必须同时修改目录、展示名、跨技能调用与文档，并通过自动化检查防止漂移。

## 决策

团队公开技能命令遵循以下规则：

1. 使用简单、常见的英文单词。
2. 优先使用动词或能直接表达用途的短语。
3. 通常不超过三个单词，避免俚语、品牌名与实现细节。
4. 已形成稳定工程含义的技术术语不为追求统一而改名。
5. 仅用于技能编排的能力不展示在用户命令菜单中。

本次迁移如下：

| 原名称 | 新名称 |
|---|---|
| `diagnosing-bugs` | `debug` |
| `git-guardrails-claude-code` | `git-safety` |
| `grill-me` | `plan-review` |
| `grill-with-docs` | `plan-review-docs` |
| `grilling` | `plan-review-core` |
| `improve-codebase-architecture` | `architecture-review` |
| `resolving-merge-conflicts` | `fix-conflicts` |
| `setup-pre-commit` | `setup-git-checks` |
| `teach` | `learn` |
| `triage` | `prepare-issue` |
| `writing-great-skills` | `write-skills` |

以下名称保持不变：`codebase-design`、`handoff`、`implement`、`prototype`、`tdd`、`text-naturalizer`、`to-issues`、`to-prd`。

`plan-review-core` 是 `plan-review` 与 `plan-review-docs` 的内部编排能力，设置 `user-invocable: false`。其余命令继续使用插件命名空间，例如 `/voidtech-core:debug`。

## 迁移策略

仓库尚未发布远端，也没有需要兼容的团队安装基线，因此直接移除旧命令，不提供别名。这样可以避免双名称长期共存，也不会把一次性的迁移成本带入后续维护。

可移植性检查维护唯一的核心技能名称集合。任何新增、删除或改名都必须显式更新该契约，并同步提升核心插件版本。

## 后续修订

- 2026-06-26：核心技能集合扩展为 21 个，新增公开发布入口 `ship`，用于用户显式触发 review、commit、push 与 PR/MR 创建流程。
- 2026-06-26：核心技能集合扩展为 22 个，新增公开调研入口 `research`，用于用户显式触发多信源开放网络调研；官方 `exa`、`firecrawl`、`youdotcom-agent-skills` 作为按需增强层，不进入 VoidTech 默认依赖。
- 2026-06-30：将 `domain-modeling` 迁移为 `feature-context`。原因是 `domain` 在中文团队沟通中容易被理解成抽象的“领域”，而该技能实际维护的是功能上下文、业务词汇、场景边界和 ADR。

## 影响

- 核心插件版本从 `0.2.0` 提升到 `0.3.0`。
- 用户需要使用新的完整命令名调用被迁移的技能。
- 内部跨技能调用统一使用 `voidtech-core:<技能名>`，避免与其他插件或个人技能冲突。
- 后续改名属于公共命令接口变更，必须更新迁移记录与自动化检查。
