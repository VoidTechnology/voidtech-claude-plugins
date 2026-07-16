# VoidTech 插件使用指南

本指南覆盖 `voidtech-core` 的 25 个技能、2 个专业 subagent，以及 `voidtech-loop` 的 2 个工程内循环技能。前者服务日常回合式协作，后者只用于完成条件可由命令退出码判定的无人值守任务。安装见 [ONBOARDING.md](../ONBOARDING.md)，发布约束见 [README.md](../README.md)。

## 1. 整体思路

`voidtech-core` 不是一堆零散命令，而是一套覆盖软件生命周期的**自包含工程工作流**：

```
想法 ──▶ 调研 ──▶ 规划与设计 ──▶ 实现与验证 ──▶ 协作与交接
           │          │                │              │
       多信源证据  功能上下文/架构    TDD/原型/调试    交接/学习/文案
```

`voidtech-loop` 不属于这条日常主线。只有任务已有机器验收命令、适合交给后台 worker 逐轮推进时，才进入[工程内循环](#9-voidtech-loop-工程内循环)。

四条设计约束决定了它的用法：

- **自包含**：发布技能只引用插件内资源，不依赖插件目录之外的脚本或运行时。外部服务不可用时，仍会留下可用产物，例如本地 Markdown 草稿或离线调研计划。
- **业务词汇按需维护**：相关技能会读取已有 `CONTEXT.md` 与 ADR。确认新术语、澄清概念边界或形成值得记录的决策后，再用 `feature-context` 写回；仅仅读取不需要调用该技能。
- **用户掌控副作用**：实现类技能默认交付"已验证但未提交"的工作树。发布 issue 或评论，以及提交、推送、合并、部署等动作，按各技能的显式触发和确认规则执行。
- **重任务隔离**：复杂架构设计和产品破题可以交给 `architect` / `product-manager` subagent，让主会话只接收结论、风险和可执行下一步。

## 2. 如何调用

`voidtech-core` 技能使用 core 命名空间：

```text
/voidtech-core:<skill>
```

例如 `/voidtech-core:tdd`、`/voidtech-core:debug`。带 `argument-hint` 的技能可直接带参数，例如：

```text
/voidtech-core:handoff 下个会话继续做支付回调
/voidtech-core:learn Swift 并发模型
```

工程内循环使用独立命名空间：

```text
/voidtech-loop:goal "修复支付模块测试" --check "npm test -- payment" --max-iterations 12
/voidtech-loop:goal-spec "迁移支付 API，保持契约测试通过，并保护公开 fixtures"
```

专业 subagent 使用插件命名空间通过 @ mention 调用：

```text
@voidtech-core:architect 设计支付回调幂等与重试架构
@voidtech-core:product-manager 把这个想法整理成 MVP PRD
```

下面的可见性表只统计 `voidtech-core`。这里说的是 Claude 能不能看到并调用技能，不代表已经授权它写文件、提交、推送或发布评论；这些动作仍以各技能正文里的确认与验证规则为准。`voidtech-loop` 的 `goal` 和 `goal-spec` 都只能由用户显式调用。

| 可见性 | 含义 | 技能 |
|---|---|---|
| **模型可援引** | 命中场景时 Claude 可以主动使用，也可以手动调用；涉及文件或仓库状态变更时，按技能自己的流程确认 | `codebase-design`、`debug`、`feature-context`、`fix-conflicts`、`git-safety`、`setup-git-checks`、`tdd`、`text-naturalizer` |
| **仅用户显式触发** | 需要明确入口，可能带来较大副作用、网络/成本开销，或代表一次完整工作流授权；必须你手动 `/` 调用 | `architecture-review`、`handoff`、`implement`、`learn`、`plan-review`、`plan-review-docs`、`prd-from-requirements`、`prd-maintain`、`prepare-issue`、`prototype`、`research`、`ship`、`to-design-brief`、`to-issues`、`to-prd`、`write-skills` |
| **仅内部编排** | 不出现在命令菜单，由其他技能调用 | `plan-review-core` |

> 经验法则：越像一次完整交付流程，越应该由你手动触发；越像方法、诊断纪律或文案规则，越适合让 Claude 在具体任务中按需使用。

## 3. 能力地图

### 调研、规划与设计

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `research` | 对不熟悉的问题做多信源开放网络调研，汇总证据、分歧、可信度和建议 | 调研结论、证据表、风险、下一步验证 |
| `feature-context` | 把已经确认的业务术语和概念边界写入上下文；仅为难逆转且存在真实取舍的决策提议 ADR | 更新后的 `CONTEXT.md`，必要时为 ADR |
| `codebase-design` | 设计接口简单、内部完整的深模块，确定可替换 seam | 模块/接口设计、seam 方案 |
| `to-prd` | 把当前对话综合成 PRD（不重新访谈） | 发布到跟踪器的 PRD，或 Markdown 草稿 |
| `prd-from-requirements` | 从原始需求、整理稿、访谈纪要或旧 PRD 生成模块化 PRD 工作树 | 模块 PRD、全局文档、追溯矩阵、开放问题清单、状态看板 |
| `prd-maintain` | 维护既有 PRD 工作树：深化模块、合入需求变更、定案开放问题、落实评审修订 | 修订后的主本、重生成的汇总与状态看板、变更记录 |
| `to-design-brief` | 把设计语言文档与 PRD 合成自包含设计 brief，供 claude.ai/design 逐页生成 UI | `claude-design-brief.md` |
| `to-issues` | 把计划/PRD 拆成端到端垂直切片 | 可独立认领验证的 issue 列表 |
| `prepare-issue` | 按分类+状态整理 issue/PR，验证主张，补信息 | agent 可直接执行的实现说明 |
| `plan-review` | 逐项检查方案，找遗漏、冲突和未验证假设 | 审查结论 |
| `plan-review-docs` | 同上，并同步整理 ADR 与业务词汇表 | 审查结论 + 文档更新 |

### 实现与验证

| 命令 | 用途 | 主要产出 |
|---|---|---|
| `implement` | 按已有 PRD 或一组 issue 实现、测试、自审、交付检查 | 已验证的工作树 + 验收证据 + 变更摘要 |
| `tdd` | 红→绿→重构小步循环，通过公开行为验证 | 测试 + 实现 |
| `prototype` | 用一次性原型回答一个明确问题（终端推演状态/逻辑，或在同一路由比较 UI 结构） | 可运行原型 + 问题答案；清理临时外壳/变体，保留部分仍需生产级验证 |
| `debug` | 建稳定复现→二分定位→根因→补回归测试 | 修复 + 防回归测试 |
| `architecture-review` | 扫描整个代码库，寻找整合浅模块、简化接口的候选项；由用户选中后再深入审查 | 临时 HTML 候选报告 + 选中方案审查 |
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
| `learn` | 跨多个会话持续教授一个主题，根据学习目标整理可信资料、短课程、练习和进度 | `MISSION.md`、课程、资料与学习记录 |
| `text-naturalizer` | 润色中/英/混排文本，去除 AI 写作痕迹 | 改写后的文本 |
| `write-skills` | 编写/改进技能，保持触发准确、流程清楚、可验证 | 新建或优化的 SKILL.md |

### 专业 subagent

| Agent | 用途 | 主要产出 |
|---|---|---|
| `architect` | 只读侦察复杂技术问题，设计架构、模块边界、接口契约、迁移和验证策略 | 推荐方案、现状证据、设计、风险与实施顺序 |
| `product-manager` | 把模糊想法或需求转成用户场景、MVP 边界、PRD/User Story，或评审既有体验 | 产品判断、范围边界、验收标准、PRD/User Story |

## 4. 入口选择与端到端工作流

### 先区分容易混淆的技能

| 当前情况 | 应使用 | 不是 |
|---|---|---|
| 当前对话已经把需求讨论清楚，要整理成一份单体 PRD | `to-prd` | 重新访谈需求，或生成模块化工作树 |
| 手上是原始需求、Excel、访谈纪要、需求清单或旧 PRD，要建立可追溯的模块化主本 | `prd-from-requirements` | `to-prd` 的后续步骤 |
| 已经有 `prd-from-requirements` 生成的工作树，要深化、合入变更或落实评审意见 | `prd-maintain` | 重新运行生成流程 |
| 已知具体模块，需要设计或改进它的 interface、seam 与可测试性 | `codebase-design` | 全仓架构体检 |
| 尚不知道最值得改哪里，要扫描全仓并比较多个模块深化候选 | `architecture-review` | 直接实施重构；它先生成报告，等用户选择候选项 |
| 没有 PRD/issue，但要用测试先行实现一个范围明确的行为 | `tdd` | 先写完全部测试，或跳过接口与行为确认 |
| 已有 PRD 或一组 issue，需要完成实现、验收核对和交付检查 | `implement` | 接任意一段模糊对话直接开工 |
| 现有行为出错、变慢或偶发失败 | `debug` | 先猜原因再改代码 |
| 有一个明确但纸面难以回答的状态模型或 UI 结构问题 | `prototype` | 生产实现、视觉精修或长期保留的实验分支 |
| 对话中已经确认了新业务术语、概念边界或重要决策，需要写回项目上下文 | `feature-context` | 新项目初始化必跑，或把 `CONTEXT.md` 当规格文档 |
| 要进行跨会话的系统学习，并持续维护课程、可信资料、练习和进展 | `learn` | 回答一次技术问题或临时查资料 |

### 日常实现：走最短有效路径

```text
范围明确、没有 PRD/issue
   └─▶ /voidtech-core:tdd                  确认接口与关键行为，逐个红→绿→重构

已有 PRD 或一组 issue
   └─▶ /voidtech-core:implement            实现、测试、逐条核对验收标准、自审
       └─▶ 技能内部尽可能使用 tdd

工作树已验证，且明确要提交、推送并创建 PR/MR
   └─▶ /voidtech-core:ship                 审查 diff、运行质量门、提交、推送、建 PR/MR
```

`implement` 的输入契约是 PRD 或 issue；只有一段范围明确的行为描述时，直接使用 `tdd` 更符合设计。`ship` 是单独的发布授权，不会因为实现完成而自动运行。

### 需要正式化或拆分的功能

先按输入形态选择一个产品文档入口，而不是全部串行执行：

```text
当前对话已讨论清楚 ──▶ /voidtech-core:to-prd
原始需求/Excel/访谈纪要 ──▶ /voidtech-core:prd-from-requirements
既有模块化 PRD 工作树 ──▶ /voidtech-core:prd-maintain
```

得到计划、规格或 PRD 后，只有确实需要多人认领或拆成多个独立交付单元时才继续：

```text
计划/规格/PRD
   └─▶ /voidtech-core:to-issues            与用户确认垂直切片后发布 issue
       └─▶ /voidtech-core:implement        按 issue 实现与验证
           └─▶ （可选）独立审查
               └─▶ /voidtech-core:ship     明确授权后发布远端变更
```

### 不确定性高或风险高的功能

这类任务没有固定流水线，按问题选用即可：

- 需要核实外部事实、版本、政策、价格或竞品信息时，用 `research`。
- 已知模块但 interface、seam 或测试面需要设计时，用 `codebase-design`；要先扫描全仓寻找候选项时，用 `architecture-review`。
- 有一个明确的状态模型或 UI 结构问题，且文档难以回答时，用 `prototype`；得到答案后记录结论并清理临时代码。
- 已有 PRD 与设计语言文档，需要生成给 claude.ai/design 的自包含输入时，用 `to-design-brief`。
- 方案存在关键约束、依赖或未经验证的假设时，在实现前用 `plan-review`；还需要同步已确认的业务词汇或 ADR 时改用 `plan-review-docs`。
- 会话中确认了新的业务词汇或概念边界时，再用 `feature-context` 就地更新；不要为了“先跑一遍流程”而创建空上下文。

### 支线：修一个 bug

```text
/voidtech-core:debug    建稳定复现 → 最小化 → 排序并验证假设 → 修复 → 回归测试
   └─（在正确 seam 先写能捕获缺陷的失败测试，再修复）
   └─（修复后若确认测试 seam 或模块边界存在架构阻力，再建议手动进入 architecture-review）
```

### 支线：处理外部贡献 / 堆积的 issue

```text
/voidtech-core:prepare-issue   按 bug/enhancement 分类、按 5 种状态流转、验证主张、写 agent 实现说明
   └─▶ ready-for-agent 的 issue 可交给 /voidtech-core:implement
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
/voidtech-core:git-safety        配置 Claude Code 钩子，拦截破坏性 git 命令
/voidtech-core:setup-git-checks  为 JS/TS 仓库配置 Husky 预提交门禁
/voidtech-core:fix-conflicts     仅在 merge/rebase 已发生冲突时调用
```

`ship` 属于发布收尾，不是卫生配置；只有准备提交、推送并创建 PR/MR 时再调用。

### 支线：文案、学习与技能维护

```text
/voidtech-core:text-naturalizer  保留事实、结构和术语，润色 PR 描述/文档/对外文案
/voidtech-core:learn <主题>      为跨会话持续学习建立课程、资料与进度记录
/voidtech-core:write-skills      团队要新增或改进 voidtech 技能时
```

## 5. 技能编排关系

部分技能会使用底层规则，或在满足特定条件后建议进入另一个入口。这张图表达调用条件，不代表所有箭头都会无条件执行：

```text
implement ──────尽可能使用──────▶ tdd ───────────▶ codebase-design（需要架构词汇时）
ship ───────────润色 PR/MR 文案──▶ text-naturalizer
to-prd ─────────润色正文────────▶ text-naturalizer
prd-from-requirements ───────▶ product-manager subagent
                        └────▶ text-naturalizer（需要润色对外文档时）
prd-maintain ──规则与脚本单源──▶ prd-from-requirements（红线/模板/自检脚本/看板生成器）
to-issues ──────轻量自审文案────▶ text-naturalizer

plan-review ────────────────▶ plan-review-core
plan-review-docs ───────────▶ plan-review-core
                              └──▶ feature-context（同步已确认的术语/决策）
prepare-issue ──信息不足时──▶ feature-context
                              └──▶ plan-review-core

architecture-review ────────▶ codebase-design
                              ├──▶ feature-context（出现新术语/长期决策时）
                              └──▶ plan-review-core（用户选中候选项后）

debug ──修复后若确认架构阻力，建议手动进入──▶ architecture-review
research ──工具可用时配合──▶ 官方 exa / firecrawl / youdotcom-agent-skills
```

含义：你只需调用面向用户的入口（如 `implement`、`plan-review`、`architecture-review`）。`plan-review-core` 永远不用手动调用；`architecture-review`、`research`、`ship` 这类仅用户显式触发的技能，不会因为图里有箭头就在后台自动启动。

## 6. 场景速查

| 我想… | 用 |
|---|---|
| 对陌生问题做开放网络调研并拿到建议 | `research` |
| 把当前对话中已经讨论清楚的需求整理成单体 PRD，不重新访谈 | `to-prd` |
| 从原始需求、Excel 整理稿或访谈纪要生成模块化 PRD 工作树 | `prd-from-requirements` |
| 维护既有 PRD 工作树（深化到验收级、合入需求变更、定案开放问题、落实评审意见） | `prd-maintain` |
| 拿 PRD 和设计语言文档生成给 claude.ai/design 用的设计 brief | `to-design-brief` |
| 把 PRD/计划拆成能干活的 issue | `to-issues` |
| 按已有 PRD 或一组 issue 实现并核对验收标准 | `implement` |
| 审查、提交、推送并创建 PR/MR | `ship` |
| 没有正式 PRD/issue，但要测试先行实现一个范围明确的行为 | `tdd` |
| 某个东西坏了/变慢了/偶发失败 | `debug` |
| 用可运行的一次性代码回答一个明确的状态模型或 UI 结构问题 | `prototype` |
| 整理别人提的 issue 或外部 PR | `prepare-issue` |
| 动手前逐项审查方案；还要同步已确认的词汇/ADR 时选择 docs 版本 | `plan-review` / `plan-review-docs` |
| 为一个已知模块设计更深的 interface 与 seam | `codebase-design` |
| 扫描全仓寻找架构改进候选，再挑一个深入审查 | `architecture-review` |
| 把会话中已经确认的新业务术语、概念边界或重要决策写回项目 | `feature-context` |
| 防止误删/误推/误重置 | `git-safety` |
| 给 JS/TS 仓库加 Husky 提交前格式、类型和测试门禁 | `setup-git-checks` |
| 卡在合并冲突里 | `fix-conflicts` |
| 换会话/交给别人继续 | `handoff` |
| 按明确目标跨多个会话系统学习一个主题 | `learn` |
| 让 PR 描述/文档读起来不像 AI 写的 | `text-naturalizer` |
| 给团队加一个新技能 | `write-skills` |
| 让 agent 在后台反复推进一个可由单条命令验收的任务 | `/voidtech-loop:goal` |
| 把多目标、守护条件和人工复核项编译成循环规格 | `/voidtech-loop:goal-spec` |

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
| 实现前端界面或比较原型 UI | `frontend-design`、`figma` | 生产级 UI 直接使用 `frontend-design`。只有要比较多个结构方案时，才先用 `prototype`；选定方向后清理临时代码，并补齐生产级实现。需要设计稿上下文时接入 `figma` |
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
- **原型代码不是生产代码**：`prototype` 用来回答一个明确问题；验证后记录答案，删除切换器、一次性路由或终端外壳，选中部分也要补齐生产级实现与验证。
- **功能上下文按需更新**：相关技能可以直接读取已有 `CONTEXT.md` 与 ADR；只有新增、修改或澄清上下文时才调用 `feature-context`，且 `CONTEXT.md` 只记录业务词汇，不承载规格或实现细节。
- **技能改名属公共接口变更**：若你要扩展或重命名技能，走 `write-skills` 并更新 [ADR-0002](decisions/0002-rename-core-skills.md) 与可移植性检查。

## 9. voidtech-loop 工程内循环

`voidtech-loop` 用于无人值守推进工程任务。它把任务和验收条件冻结为 Goal Spec，由确定性控制器在独立 worktree 的专属分支上逐轮驱动 worker，并对每轮 checkpoint commit 运行 eval。

一期工程内循环已经完成，当前试点版仅支持 macOS arm64。运行环境需要 Claude Code 2.1.210 或更高版本、Node.js 18+、Git 和 `jq`。

### 9.1 何时使用

| 任务 | 入口 | 说明 |
|---|---|---|
| 单一目标可由一条安全命令的退出码判定 | `goal` | 直接传入任务、`--check` 和用户指定的 `--max-iterations` |
| 多个 target，或包含 invariant、protected paths、manual review | `goal-spec` | 先生成并验证 Goal Spec，再由用户决定是否启动 `goal --spec` |
| 依赖产品 taste、用户研究或主观判断 | 不使用 loop | 这类条件不能伪装成机器 eval |
| 需要开放网络、外部服务或自定义 worker 能力 | 一期不支持 | 停止并说明能力缺口，不降级成不受约束的循环 |

`voidtech-core:implement` 适合人在会话中跟进、按 PRD 或 issue 完成一次实现；`voidtech-loop:goal` 适合验收命令已经明确、希望控制器在后台多轮推进的任务。二者不会自动互相启动。

### 9.2 简单任务

```text
/voidtech-loop:goal "修复支付模块测试" --check "npm test -- payment" --max-iterations 12
```

`--check` 必须在缺陷存在时失败、目标达成后通过。`--max-iterations` 没有默认值，必须由用户指定；`--max-duration` 可选，默认 3600 秒。启动前会检查运行环境、Git、base commit 和基线 eval。若目标在基线已经满足，或基线 invariant 已经失败，循环不会启动。

启动分两阶段：校验、基线、加锁、建 worktree 都在前台完成，任何一步失败都会直接报错并以非零退出码返回；准备成功后后台控制器接管，启动命令直接输出 run ID 与循环分支。之后用 `loop status <runId>` 看进度。Goal Spec 含 `shell: true` 的 eval 或 `setup` 命令时，启动命令会完整展示这些命令并要求追加 `--allow-shell` 单独确认。关闭当前 Claude Code 会话不会停止循环；需要中断时使用 `loop cancel <runId>`，不要依赖 Ctrl+C。

### 9.3 复杂任务

复杂任务先编译 Goal Spec：

```text
/voidtech-loop:goal-spec "迁移支付 API，保持契约测试通过，并保护公开 fixtures"
```

`goal-spec` 会读取仓库已有的测试、构建和 CI 命令，把要求分为：

- `target`：本轮必须达成、可机器判定的变化；
- `invariant`：base commit 上已经成立、循环中不得退化的条件；
- `manual_review`：只能由人判断的产品或设计要求，不进入 eval；
- `out_of_scope`：本轮明确不做的内容。

若任务其实只有一个 target，且能用一条安全命令表达，`goal-spec` 不会生成 YAML，而是返回一行 `goal --check` 命令。复杂任务会运行 schema 校验和基线 dry-run，草稿默认写入 `.voidtech-loop/specs/<slug>.yaml`。spec 含 `shell: true` 的 eval 或 `setup` 命令时，基线命令也会展示完整命令清单，并要求显式追加 `--allow-shell` 后才执行。`goal-spec` 只生成和验证规格，不会启动循环，也不会修改业务代码。确认草稿后再调用：

```text
/voidtech-loop:goal --spec .voidtech-loop/specs/<slug>.yaml
```

### 9.4 状态与安全边界

```text
goal → RUNNING → VERIFYING → EVALS_PASSED → 人工复核 → ACCEPTED
                  └────────────失败/阻塞/取消/预算耗尽────────────▶ STOPPED
```

- `EVALS_PASSED` 只说明指定 commit 通过当前 Goal Spec 的 target 与 invariant，不代表产品方向正确，也不代表代码已经合入。
- `accept` 只把 run 从 `EVALS_PASSED` 标记为 `ACCEPTED`；合入仍由人执行。
- 循环不会自动 push、merge、创建 PR/MR、rebase、删除分支或改写用户分支。
- worker 只能进行只读 Git 操作；checkpoint commit 由控制器生成。
- 一期提供的是固定 best-effort 隔离，不承诺 OS 级文件系统或网络沙箱。
- 一个项目同一时间只允许一个活动循环；取消后不提供 resume，需要从已有 checkpoint 或其他 commit 发起新 run。

完整产品范围见 [voidtech-loop PRD](prd-voidtech-loop-2026-07-15.md)，控制器与隔离设计见 [技术设计](tech-design-voidtech-loop-2026-07-15.md)。
