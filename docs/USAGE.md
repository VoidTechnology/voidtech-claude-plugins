# voidtech-core 使用指南

本指南讲清楚 `voidtech-core` 的 22 个技能各自做什么、如何调用，以及怎样把它们串成从调研到交付的完整工作流。安装见 [ONBOARDING.md](../ONBOARDING.md)，发布约束见 [README.md](../README.md)。

## 1. 整体思路

`voidtech-core` 不是一堆零散命令，而是一套覆盖软件生命周期的**自包含工程工作流**：

```
想法 ──▶ 调研 ──▶ 规划与设计 ──▶ 实现与验证 ──▶ 协作与交接
           │          │                │              │
       多信源证据  功能上下文/架构    TDD/原型/调试    交接/学习/文案
```

三条设计约束决定了它的用法：

- **自包含**：发布技能只引用插件内资源，不依赖插件目录之外的脚本或运行时。外部服务（issue 跟踪器、CDN）缺失时一定有明确的降级产出（如完整 Markdown 草稿）。
- **业务词汇共享**：多个技能在动手前会读取 `CONTEXT.md` 与 ADR，使用项目业务词汇表的措辞。先用 `feature-context` 整理清楚功能上下文，后续技能的产出质量会显著提升。
- **用户掌控副作用**：会提交、推送、合并、部署的动作只在你显式要求时发生。技能默认交付"已验证但未提交"的工作树。

## 2. 如何调用

所有技能都用插件命名空间调用，避免与其他插件或个人技能冲突：

```text
/voidtech-core:<skill>
```

例如 `/voidtech-core:tdd`、`/voidtech-core:debug`。带 `argument-hint` 的技能可直接带参数，例如：

```text
/voidtech-core:handoff 下个会话继续做支付回调
/voidtech-core:learn Swift 并发模型
```

技能按"谁能触发"分三类。这里说的是 Claude 能不能看到并调用这个技能，不代表已经授权它写文件、提交、推送或发布评论；这些动作仍以各技能正文里的确认与验证规则为准。

| 可见性 | 含义 | 技能 |
|---|---|---|
| **模型可援引** | 命中场景时 Claude 可以主动使用，也可以手动调用；涉及文件或仓库状态变更时，按技能自己的流程确认 | `codebase-design`、`debug`、`feature-context`、`fix-conflicts`、`git-safety`、`setup-git-checks`、`tdd`、`text-naturalizer` |
| **仅用户显式触发** | 需要明确入口，可能带来较大副作用、网络/成本开销，或代表一次完整工作流授权；必须你手动 `/` 调用 | `architecture-review`、`handoff`、`implement`、`learn`、`plan-review`、`plan-review-docs`、`prepare-issue`、`prototype`、`research`、`ship`、`to-issues`、`to-prd`、`write-skills` |
| **仅内部编排** | 不出现在命令菜单，由其他技能调用 | `plan-review-core` |

> 经验法则：越像一次完整交付流程，越应该由你手动触发；越像方法、诊断纪律或文案规则，越适合让 Claude 在具体任务中按需使用。

## 3. 能力地图

### 调研、规划与设计

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `research` | 对不熟悉的问题做多信源开放网络调研，汇总证据、分歧、可信度和建议 | 调研结论、证据表、风险、下一步验证 |
| `feature-context` | 统一业务词汇、澄清场景边界、记录架构决策 | `CONTEXT.md`、ADR |
| `codebase-design` | 设计接口简单、内部完整的深模块，确定可替换 seam | 模块/接口设计、seam 方案 |
| `to-prd` | 把当前对话综合成 PRD（不重新访谈） | 发布到跟踪器的 PRD，或 Markdown 草稿 |
| `to-issues` | 把计划/PRD 拆成端到端垂直切片 | 可独立认领验证的 issue 列表 |
| `prepare-issue` | 按分类+状态整理 issue/PR，验证主张，补信息 | agent 可直接执行的实现说明 |
| `plan-review` | 逐项检查方案，找遗漏、冲突和未验证假设 | 审查结论 |
| `plan-review-docs` | 同上，并同步整理 ADR 与业务词汇表 | 审查结论 + 文档更新 |

### 实现与验证

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `implement` | 按 PRD/issue 实现、测试、自审、交付检查 | 已验证的工作树 + 变更摘要 |
| `tdd` | 红→绿→重构小步循环，通过公开行为验证 | 测试 + 实现 |
| `prototype` | 一次性原型验证设计（终端验逻辑 / 同路由比 UI） | 抛弃型验证产物 |
| `debug` | 建稳定复现→二分定位→根因→补回归测试 | 修复 + 防回归测试 |
| `architecture-review` | 扫描代码库找整合浅模块/简化接口的机会 | HTML 报告 + 选中方案审查 |
| `ship` | 审查 diff、运行验证、提交、推送并创建 PR/MR | 远端 PR/MR + 验证摘要 |

### Git 与安全

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `git-safety` | 配置钩子，拦截 push/reset --hard/clean/branch -D 等危险命令 | Claude Code hook 配置 |
| `setup-git-checks` | 配置 Husky 预提交：lint-staged(Prettier)+类型检查+测试 | 预提交钩子 |
| `fix-conflicts` | 解决进行中的 merge/rebase 冲突，保留双方意图并验证 | 已解决冲突的工作树 |

### 协作与文档

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `handoff` | 把当前任务整理成交接文档供另一 agent 接力 | 临时目录中的 handoff 文件 |
| `learn` | 在工作区持续教授一项技能，记录目标/资料/进展 | 学习记录文件 |
| `text-naturalizer` | 润色中/英/混排文本，去除 AI 写作痕迹 | 改写后的文本 |
| `write-skills` | 编写/改进技能，保持触发准确、流程清楚、可验证 | 新建或优化的 SKILL.md |

## 4. 端到端工作流

### 入口选择：先走最短有效路径

```text
/voidtech-core:implement <已明确的功能或 issue>
   └─▶ 技能内部尽可能使用 tdd，完成实现、测试、自审和交付检查
   └─▶ 工作树保持未提交；准备提交、推送和创建 PR/MR 时再手动调用 ship

/voidtech-core:ship <本次改动说明>
   └─▶ 审查 diff、运行验证、提交、推送并创建 PR/MR
```

这是日常最常见的路径。需求已经说清楚时，不必先写 PRD 或 issue；让 `implement` 直接围绕当前上下文完成代码和验证。

### 主线：需要拆分的功能

```text
（已有计划、规格、PRD 或需求讨论）
   └─▶ /voidtech-core:to-issues            拆成端到端垂直切片
   └─▶ /voidtech-core:implement            逐个 issue 实现与验证
   └─▶ （可选）官方 `pr-review-toolkit` / `code-review` 做独立审查
   └─▶ /voidtech-core:ship                 提交、推送并创建 PR/MR
```

适用于多人协作、范围超过一次改动、或需要把任务交给多个 agent 认领的功能。`to-issues` 负责让每个 issue 能独立验证，`implement` 负责实际落地。

### 主线：不确定性高或风险高的功能

```text
（讨论需求）
   └─▶ /voidtech-core:research             需要外部证据、版本现状或竞品事实时
   └─▶ /voidtech-core:feature-context      首次进入新业务场景，或术语/边界还不稳定时
   └─▶ /voidtech-core:codebase-design      涉及新接口、seam 或模块边界时
   └─▶ /voidtech-core:prototype            设计或交互还停留在猜测阶段时
   └─▶ /voidtech-core:to-prd               需要正式化产品范围时
   └─▶ /voidtech-core:plan-review          风险、依赖或迁移路径需要动手前审查时
   └─▶ /voidtech-core:to-issues            拆成可独立交付的垂直切片
   └─▶ /voidtech-core:implement            实现、测试、自审
   └─▶ /voidtech-core:ship                 提交、推送并创建 PR/MR
```

这不是默认流程，而是复杂功能才需要的升级路径。每一步都有触发条件：不需要外部事实就跳过 `research`，没有新接口就跳过 `codebase-design`，不需要正式产品文档就跳过 `to-prd`。

### 支线：修一个 bug

```text
/voidtech-core:debug    建稳定复现 → 定位 → 根因 → 补回归测试
   └─（修复阶段用 tdd 的红绿循环）
   └─（若根因是架构腐化，debug 会建议手动进入 architecture-review）
```

### 支线：处理外部贡献 / 堆积的 issue

```text
/voidtech-core:prepare-issue   按 bug/enhancement 分类、按 5 种状态流转、验证主张、写 agent 实现说明
   └─▶ ready-for-agent 的 issue 可直接交给 /voidtech-core:implement
```

### 支线：开放网络调研一个陌生问题

```text
/voidtech-core:research "比较 iOS 崩溃日志脱敏与上报方案，给 SDK 选型和接入风险建议"
   └─▶ 官方 exa / firecrawl / youdotcom-agent-skills 插件可用时，多信源并行收集证据
   └─▶ 插件不可用时，退化为离线调研计划、查询清单和待验证假设
```

适用于不应该只靠模型记忆做决策的场景，例如依赖版本、平台政策、安全合规、价格、竞品现状或线上服务能力。

### 支线：保障仓库 Git 卫生

```text
/voidtech-core:git-safety        一次性配置，拦截破坏性 git 命令
/voidtech-core:setup-git-checks  一次性配置 Husky 预提交门禁
/voidtech-core:fix-conflicts     遇到 merge/rebase 冲突时按需调用
```

`ship` 属于发布收尾，不是卫生配置；只有准备提交、推送并创建 PR/MR 时再调用。

### 支线：文案、学习与技能维护

```text
/voidtech-core:text-naturalizer  发布 PR 描述/文档/对外文案前去 AI 味
/voidtech-core:learn <主题>      边做边学一项新技能/概念
/voidtech-core:write-skills      团队要新增或改进 voidtech 技能时
```

## 5. 技能编排关系

部分技能会使用底层规则，或在发现特定问题后建议进入另一个入口。这张图用来判断该从哪个用户入口开始：

```text
implement ──────尽可能使用──────▶ tdd ───────────▶ codebase-design（需要架构词汇时）
ship ───────────润色 PR/MR 文案──▶ text-naturalizer
to-prd ─────────润色正文────────▶ text-naturalizer
to-issues ──────轻量自审文案────▶ text-naturalizer

plan-review ────────────────▶ plan-review-core
plan-review-docs ───────────▶ plan-review-core
                              └──▶ feature-context
prepare-issue ──────────────▶ feature-context
                              └──▶ plan-review-core

architecture-review ────────▶ codebase-design
                              ├──▶ feature-context
                              └──▶ plan-review-core

debug ──若根因指向架构腐化，建议手动进入──▶ architecture-review
research ──工具可用时配合──▶ 官方 exa / firecrawl / youdotcom-agent-skills
```

含义：你只需调用面向用户的入口（如 `implement`、`plan-review`、`architecture-review`）。`plan-review-core` 永远不用手动调用；`architecture-review`、`research`、`ship` 这类仅用户显式触发的技能，不会因为图里有箭头就在后台自动启动。

## 6. 场景速查

| 我想… | 用 |
|---|---|
| 对陌生问题做开放网络调研并拿到建议 | `research` |
| 把一段需求讨论变成正式 PRD | `to-prd` |
| 把 PRD/计划拆成能干活的 issue | `to-issues` |
| 实现一个已经定义好的功能 | `implement` |
| 审查、提交、推送并创建 PR/MR | `ship` |
| 写新逻辑但想要测试保证 | `tdd` |
| 某个东西坏了/变慢了/偶发失败 | `debug` |
| 验证一个还没想清楚的设计或交互 | `prototype` |
| 整理别人提的 issue 或外部 PR | `prepare-issue` |
| 动手前请人挑方案的毛病 | `plan-review` / `plan-review-docs` |
| 改善模块边界与接口 | `codebase-design` / `architecture-review` |
| 统一业务词汇、澄清场景边界、记录架构决策 | `feature-context` |
| 防止误删/误推/误重置 | `git-safety` |
| 加提交前的格式与测试门禁 | `setup-git-checks` |
| 卡在合并冲突里 | `fix-conflicts` |
| 换会话/交给别人继续 | `handoff` |
| 学一门新技术 | `learn` |
| 让 PR 描述/文档读起来不像 AI 写的 | `text-naturalizer` |
| 给团队加一个新技能 | `write-skills` |

## 7. 与外部工具和 MCP 配合

核心技能本身不绑定外部服务，但下列配合能放大效果：

- **GitHub / GitLab / issue 跟踪器**：GitHub 先 `gh auth login`，GitLab 先 `glab auth login`。`to-prd`、`to-issues`、`prepare-issue` 会按 [Issue 跟踪器适配契约](../plugins/voidtech-core/skills/_shared/ISSUE-TRACKER.md) 探测平台与标签；跟踪器不可用时退化为本地 Markdown 草稿。
- **可选 MCP 插件**（默认禁用，按需 `claude plugin enable`）：
  - `voidtech-mcp-common`：Context7（查库文档）、Chrome DevTools（无头浏览器验证，对 `debug` / `prototype` 的 UI 验证很有用）。
  - `voidtech-mcp-apple`：Apple Docs、XcodeBuildMCP（iOS/macOS 开发）。
- **开放网络调研**：安装官方 `exa`、`firecrawl`、`youdotcom-agent-skills` 后，`research` 会把它们作为搜索、抓取和带引用研究的增强层；未安装时退化为调研计划与查询清单。
- **Figma / Vercel**：使用各自官方插件，团队 Marketplace 不分发第三方替代实现。

### 官方插件搭配表

| 工作流位置 | 可搭配官方插件 | 使用方式 |
|---|---|---|
| 维护 VoidTech Marketplace 或新增插件能力 | `plugin-dev` | 在 `write-skills` 前后使用，补充 hooks、commands、MCP 与插件打包细节 |
| 实现前端界面或原型 UI | `frontend-design`、`figma` | `prototype` 验证交互后，用 `frontend-design` 打磨界面；需要设计稿时接入 `figma` |
| 陌生业务场景或开放网络调研 | `exa`、`firecrawl`、`youdotcom-agent-skills` | `research` 负责问题拆解、source lane 分工、证据分级和建议汇总；官方插件负责搜索、抓取和带引用研究 |
| 实现后、发布前 | `pr-review-toolkit` 或 `code-review` | 在 `ship` 前做独立审查；二选一，避免重复审查噪音 |
| 日常安全提醒 | `security-guidance` | 与 `git-safety` 并用：代码安全风险由官方插件提醒，危险 Git 操作由 VoidTech hook 拦截 |
| 线上问题定位 | `sentry`、`datadog`、`posthog`、`amplitude` 等 | `debug` 确认需要生产证据时按监控栈启用 |
| 语言级代码导航 | `swift-lsp`、`kotlin-lsp`、`typescript-lsp`、`pyright-lsp` 等 | 大型代码库重构、跳转和引用分析时启用 |

### 不建议重复的官方插件

- `commit-commands`：和 `ship` 的 commit/push/PR/MR 流程重叠。
- `feature-dev`：和 `to-prd`、`to-issues`、`implement`、`plan-review` 的主线重叠。
- `superpowers`：会引入另一套工程方法论，容易和 VoidTech 工作流混用。
- `context7`、`chrome-devtools-mcp`：已由 `voidtech-mcp-common` 覆盖。

## 8. 边界与注意事项

- **不会擅自提交**：`implement` 等技能默认只交付已验证的工作树，提交/推送需你明确发话。
- **不会重新访谈**：`to-prd` 只综合已讨论的内容；信息不足时应先把需求聊清楚再调用。
- **临时产物落在临时目录**：`handoff`、`debug` 的 HITL 脚本写入操作系统临时目录，不污染工作区。
- **功能上下文是前置投资**：在新项目或新业务场景先跑一次 `feature-context`，后续所有技能都会复用其术语与 ADR。
- **技能改名属公共接口变更**：若你要扩展或重命名技能，走 `write-skills` 并更新 [ADR-0002](decisions/0002-rename-core-skills.md) 与可移植性检查。
