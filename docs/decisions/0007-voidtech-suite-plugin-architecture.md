# ADR-0007：VoidTech Suite 插件架构、共享 Atlas 与领域验收权

## 状态

已接受（待实现）

## 日期

2026-07-24

## 摘要

VoidTech Marketplace 从“一个承载多数工作流的 `voidtech-core` + 一个执行控制面 `voidtech-loop`”演进为六层 Product Delivery Suite：`voidtech-core` 作为共享契约和呈现内核，`voidtech-product`、`voidtech-design`、`voidtech-engineering`、`voidtech-qa` 分别拥有产品、设计、工程和独立验证写模型，`voidtech-loop` 继续作为确定性执行控制面。领域插件只通过版本化 Artifact Contract 和 Atlas Fragment 交接，不直接调用彼此 Skill。Logic Atlas 升级为 Core 的 Suite Atlas Engine；Archify Runtime、Atlas Viewer 和 Atlas→Archify Adapter 均归 Core，各领域仅负责将权威事实投影为带来源的 Atlas Fragment。`to-prd` 与 `feature-context` 归 `voidtech-engineering`。

## 背景

ADR-0001 将默认核心能力与高权限、可选 MCP 拆开，解决了安装面和权限面问题，但没有建立产品生命周期分层。当前 `voidtech-core` 同时发布产品需求、设计简报、原型、工程实现、调试、测试、Git、交付和通用协作技能；`scripts/check-portability.sh` 固定检查 26 个 Core Skill 与 2 个 Core Agent。用户需要先理解单个技能，无法从插件边界判断谁拥有产品事实、设计决策、实现事实和最终验收权。

当前还存在两类结构风险：

1. 同一个 Agent 可以整理需求、实现需求并运行测试，缺少独立 QA 验收权。
2. Logic Atlas 与 Archify 已成为确定性关系、缺口、新鲜度和可视化基础设施，但物理上仍嵌在 `prd-from-requirements` 中；Design、Engineering 和 QA 如果各自重建关系视图，会产生重复模型和跨域追溯断裂。

目标不是创建四个拟人化角色包，而是为产品交付的四种权威事实建立独立写模型、生命周期、审批权和可追溯交接。

## 决策

### 1. Suite 固定为六个插件层级

```text
voidtech-core
voidtech-product
voidtech-design
voidtech-engineering
voidtech-qa
voidtech-loop
```

命名使用 `voidtech-engineering`，不使用 `voidtech-engineer`。插件代表能力领域和多个 Agent，不代表单个角色。

`voidtech-qa` 保留用户熟悉的名称，内部权威写模型称为 Verification Workspace。

现有 `voidtech-mcp-common` 与 `voidtech-mcp-apple` 继续作为可选外部能力插件，不进入六层领域架构，也不默认启用。

### 2. Core 是共享契约与呈现内核，不承载领域工作流

`voidtech-core` 负责：

- Artifact Envelope、稳定 ID、source reference、status、error 和 digest。
- Artifact schema version 与跨插件 compatibility check。
- Suite Atlas Fragment Schema、Atlas Engine、Atlas Viewer、coverage、gaps、freshness 和 change impact。
- Archify Runtime、typed IR、validator、deterministic deliver、diagnostics、SVG/CSS 安全处理和 Render Receipt。
- Atlas→Archify Lifecycle、Workflow、Architecture、Sequence、Data Flow Adapter。
- 通用 research、handoff、learn、plan review、文本自然化和 Skill 编写能力。
- Marketplace 级可移植性、许可证和离线安装约束。

Core 不直接读取 PRD、Design Workspace、源码实现或 QA Evidence，不拥有产品、设计、工程或 QA 的领域裁决。

### 3. Product 拥有产品事实写模型

`voidtech-product` 负责：

- 原始需求转结构化产品事实。
- 模块 PRD、领域规格、产品总览和追溯矩阵。
- Requirement Ledger、Open Questions 和产品裁决。
- 权限、状态、流程、字段规则和验收标准。
- 产品成熟度、模块深化和 PRD Source Sync。
- 将 Product Workspace 确定性投影为 Product Atlas Fragment。

归属技能：

- `prd-from-requirements`
- `prd-maintain`
- `prd-sync`
- Product Manager Agent

`voidtech-product` 不拥有 `to-prd` 和 `feature-context`。

### 4. Design 拥有设计决策写模型

`voidtech-design` 负责：

- Design Workspace。
- flow readiness、Design Packet 和 Design Decision。
- Information Architecture、App Shell、Token、interaction semantics、page archetype 和 component registry。
- 共享代码原型、状态切换器、Design Trace 和一致性审查。
- Design Workspace → Design Atlas Fragment。
- Code Prototype、claude.ai/design Brief 和 Figma adapter。

归属技能：

- `design-from-prd`
- `create-design-md`
- `to-design-brief`
- 从现有 `prototype` 拆出的 UI prototype
- Designer Agent 与 Design Reviewer

Design 可以读取 Product Artifact，但不能直接调用 Product Skill，也不能修改 Product Workspace。

`create-design-md` 从当前项目已有的 PRD、实现与设计资产建立或修订标准 `DESIGN.md`，持有 Design Foundation 的可执行 token 与组件表达；它不建立 Product 事实、不把 `DD-CANDIDATE` 当成已批准决定，也不替代 `design-from-prd` 的 readiness、trace、Design Workspace 与 accepted 生命周期。

### 5. Engineering 拥有工程交付和代码实现

`voidtech-engineering` 负责：

- Repository 与 Git 中的实现事实。
- Engineering Workspace、Implementation Plan、Issue、Architecture Decision 和 Change Manifest。
- 实现、调试、TDD、代码审查、Git 安全和 Ship。
- 工程上下文、领域词汇与代码边界的映射。
- Repository/Engineering Workspace → Engineering Atlas Fragment。

归属技能：

- `architecture-review`
- `codebase-design`
- `feature-context`
- `to-prd`
- `to-issues`
- `prepare-issue`
- `implement`
- `debug`
- `tdd`
- 从现有 `prototype` 拆出的 logic spike
- `git-safety`
- `setup-git-checks`
- `fix-conflicts`
- `ship`
- Architect Agent

`to-prd` 的实际职责是把已讨论清楚的对话和代码库上下文整理成包含实现、seam 与测试决策的单体工程交付 PRD，并发布为 `ready-for-agent` Issue，因此归 Engineering。

`feature-context` 写入代码仓库的 `CONTEXT.md`/`CONTEXT-MAP.md`，将产品术语与代码现状交叉核对并在必要时记录 ADR，因此归 Engineering。Product 的产品词汇仍保存在 Product Workspace 和领域规格中。

Engineering 可以证明构建和工程检查通过，但不能为自己签发独立 QA 通过结论。

### 6. QA 拥有独立验证事实和发布建议

`voidtech-qa` 负责：

- Verification Workspace。
- Test Plan、Scenario Matrix、Evidence Pack、Defect Record 和 Regression Baseline。
- 浏览器 E2E、API/数据链路、权限、会话、失败恢复和非功能验证。
- Verification Workspace → QA Atlas Fragment。
- Release Recommendation。

QA 读取 Product、Design 与 Engineering Artifact，验证用户契约是否成立。QA 不修改产品规则、设计决策或实现事实；发现问题时通过 Defect/OQ/DD candidate 回流对应领域。

TDD 留在 Engineering。QA 验证外部用户契约，不以“工程测试命令退出码为 0”替代独立验收。

### 7. Loop 是执行控制面，不拥有领域事实

`voidtech-loop` 继续负责：

- Goal Spec。
- 确定性执行计划。
- 隔离 worktree、指定 commit、重试、恢复和操作日志。
- 约定 eval 的执行与结果记录。

Loop 可以引用 Product、Design、Engineering 和 QA Artifact，但不解释、修改或批准其中的领域事实。领域插件决定“做什么、什么算通过”，Loop 决定“如何可控地执行和记录”。

### 8. 插件通过 Artifact Graph 协作，不形成固定瀑布

```text
Product Contract ───────┬──> Design Contract
                        ├──> Implementation Contract
                        └──> Verification Plan
Design Contract ────────┬──> Implementation Contract
                        └──> Verification Plan
Implementation Contract ───> Verification Pack
Verification findings ─────> Product | Design | Engineering
```

并非所有需求都必须经过全部领域：纯后端改动可以不产生 Design Contract，设计探索可以暂时没有实现，技术债可以从 Engineering 进入 QA。每个 Artifact 明确输入、来源摘要、所有者、审批者和 stale 传播规则。

### 9. 禁止领域插件直接调用彼此 Skill

禁止：

```text
voidtech-design → voidtech-product:prd-sync
voidtech-qa → voidtech-engineering:ship
```

允许：

```text
Product 写 Product Contract / Atlas Fragment
Design 读取 Artifact Contract
Engineering 读取 Product/Design Contract
QA 读取 Product/Design/Engineering Contract
```

所有领域插件只依赖 Core 公共契约，形成星形依赖，不形成 Product→Design→Engineering→QA 的代码依赖链。某领域插件未安装时，其他插件仍可消费已经存在且兼容的 Artifact。

### 10. Logic Atlas 升级为 Core Suite Atlas

Logic Atlas 不再只是 PRD 阅读器。Core 接受各领域输出的 Atlas Fragment，组合为 Suite Atlas，并提供五种视图：

1. Product View：requirement、flow、state、permission、gap。
2. Design View：requirement → page → action → state → route。
3. Engineering View：requirement → issue → module/API → change → commit。
4. QA View：requirement → scenario → evidence → defect/verdict。
5. Delivery Trace View：REQ → Design/NA → Implementation → Verification → Release Recommendation。

Core 只验证公共结构、引用、新鲜度和跨 Fragment 关系；领域插件验证自己 `detail` 的语义。

### 11. Atlas Fragment 使用命名空间类型

公共 Envelope 至少包含：

```text
fragmentId
domain
schemaVersion
producer
sourceDigest
nodes
edges
gaps
coverage
generatedAt
```

节点与边使用命名空间：

```text
product.requirement
product.flow
product.state
design.decision
design.page
design.action
design.route
engineering.issue
engineering.module
engineering.change
engineering.commit
qa.scenario
qa.evidence
qa.defect
qa.verdict

product.transition
design.renders
engineering.implements
qa.verifies
core.traces
```

Core 校验公共 Envelope、ID、sourceRefs 和引用完整性；各领域插件拥有并版本化本领域 detail schema。无法确定的关系进入当前 Fragment 的 gaps，Core 不根据名称猜边。

### 12. Archify 与 Atlas→Archify Adapter 归 Core

Core 拥有：

- vendored Archify 和升级证明。
- 五种 typed IR 与校验。
- 确定性 render/deliver、diagnostics 和 digest。
- Atlas state/transition → Lifecycle IR。
- Atlas ordered steps → Workflow IR。
- Atlas modules/relations → Architecture IR。
- Atlas messages/interactions → Sequence IR。
- Atlas reads/writes/data authority → Data Flow IR。

当前 `prd-from-requirements` 中混合了通用运行时、Atlas→Lifecycle 和 Product→Logic Model 三类职责。迁移时先把 Lifecycle Adapter 的输入改为通用 Atlas state/transition subgraph，再迁入 Core；Product 只保留 PRD→Product Atlas Fragment 投影和 Product View 规则。

Node 或 Archify 不可用时，单图降级和 presentation risk 规则继续成立，不让呈现能力阻塞领域内容门。

### 13. 通用 Skill 留在 Core

以下现有 Skill 不拥有领域写模型，继续留在 Core：

- `research`
- `handoff`
- `learn`
- `plan-review`
- `plan-review-core`
- `plan-review-docs`
- `text-naturalizer`
- `write-skills`

现有 `prototype` 不继续保留含混双分支，迁移为 Design 的 UI Prototype 和 Engineering 的 Logic Spike。

### 14. 使用安装 Preset，不增加总包插件

不新增 `voidtech-suite` 元插件，避免重复发布和版本配对。文档提供：

- Product Discovery：Core + Product。
- Product Design：Core + Product + Design。
- Engineering：Core + Engineering，Loop 可选。
- Release Verification：Core + QA，Loop 可选。
- Full Lifecycle：Core + Product + Design + Engineering + QA + Loop。

MCP 继续按项目需要显式安装和启用。

### 15. 采用一次性 Clean Cutover

当前插件仍处于 `0.x`，新插件实现和兼容矩阵完成后，在同一发布中：

1. 迁移全部内部引用、文档、安装资源和验证脚本。
2. 从 Core 删除已迁移领域 Skill 与 Agent。
3. 更新公共命令路径。
4. 发布命令迁移表。
5. 不保留重复实现、长期 alias 或跨插件 shim。

## 插件权威矩阵

| 插件 | 写模型 | 可重建读模型 | 审批权 |
|---|---|---|---|
| Core | 公共契约与兼容规则 | Suite Atlas、Viewer、coverage、impact | 公共 Schema/兼容门 |
| Product | Product Workspace、PRD、OQ、产品决策 | Product Atlas Fragment、成熟度 | 产品行为与范围 |
| Design | Design Workspace、DD、Foundation | Design Atlas Fragment、原型、设计覆盖 | 设计表达与一致性 |
| Engineering | Repository、Git、工程决策 | Engineering Atlas Fragment、Build Evidence | 实现和工程质量 |
| QA | Verification Workspace、Evidence、Defect | QA Atlas Fragment、Release Recommendation | 独立验收结论 |
| Loop | Goal/Execution Journal | Run 状态和 eval 结果 | 执行授权，不含领域裁决 |

## 被否决的方案

### 按角色把现有 Skill 简单分箱

否决原因：只有目录变化，没有独立写模型、生命周期和审批权，无法解决越权和追溯问题。

### Core 继续承载所有默认工作流

否决原因：用户心智、依赖和发布范围持续扩大，无法从插件边界判断事实所有者。

### Logic Atlas 留在 Product，其他领域各建一套关系模型

否决原因：会产生重复 Viewer、重复关系语义和跨域追溯断裂。Suite Atlas 应是共享基础设施，各领域只输出 Fragment。

### 把当前 Product Logic Model 原样搬进 Core

否决原因：当前 scope/node/edge 枚举写死 module、requirement、page、permission 等 Product 语义。必须先拆成公共 Fragment Envelope 与领域 detail schema。

### 让领域插件直接调用彼此 Skill

否决原因：造成安装顺序、命令名和版本耦合，并形成依赖菱形。Artifact Contract 是唯一跨域接口。

### 把 TDD 迁入 QA

否决原因：TDD 是实现过程反馈；QA 是独立用户契约验证。合并会让 Engineering 以自己的测试替代独立验收。

### 单独创建 Archify 插件

否决原因：Archify 是 Suite 内部深模块，没有独立用户生命周期；当前 vendored 体积和运行依赖不足以支持新增第七个插件的安装与版本成本。

## 后果

### 正向后果

- 产品、设计、实现和验收拥有明确且互不越权的事实。
- Suite Atlas 提供跨领域端到端追溯和变更影响分析。
- Design、Engineering、QA 不再重复建设关系图与 Viewer。
- QA 可以独立签发证据和发布建议。
- 所有领域复用同一 Archify fail-closed 呈现基础设施。
- 单个领域插件可以独立演进，只需保持 Core Artifact Contract 兼容。

### 成本与限制

- 需要迁移现有 26 个 Core Skill、2 个 Agent、文档、安装校验和公共命令。
- 当前 Product Logic Model 必须先解耦为 Product Fragment，不能简单移动目录。
- Core Atlas Contract 成为高稳定性公共接口，后续变更需要版本与兼容策略。
- Full Lifecycle 安装包含更多插件，必须用 Preset 和清晰错误降低配置成本。

## 成功指标

北极星指标为“跨角色交付闭环率”：

```text
拥有 Product Contract、Design Contract 或明确 N/A、Implementation Contract、
独立 Verification Evidence 与 Release Recommendation 的 in-scope 需求数
÷
in-scope 需求总数
```

架构反指标：

- 跨插件重复 Skill 数 = 0。
- 领域插件直接调用其他领域 Skill 数 = 0。
- 无来源 Atlas node/edge 数 = 0。
- Engineering 为自己的实现签发独立 QA 通过结论数 = 0。
- 同一事实被两个写模型同时声明权威的数量 = 0。

## 迁移顺序

1. 定义 Core Artifact Envelope、Atlas Fragment 和兼容矩阵。
2. 将 Archify Runtime、Atlas Engine 与 Atlas→Archify Adapter收敛为 Core 深模块。
3. 新建 `voidtech-design`，用 `design-from-prd` 完成首条跨插件垂直试点。
4. 新建 `voidtech-product`，迁移 PRD 写模型并输出 Product Atlas Fragment。
5. 新建 `voidtech-engineering`，迁移 `to-prd`、`feature-context` 与工程交付技能。
6. 新建 `voidtech-qa`，建立 Verification Workspace 和 Evidence Pack。
7. 让 Loop 只消费通用 Artifact Reference。
8. 完成安装矩阵后一次性 Clean Cutover。

## 关联文档

- `docs/decisions/0001-split-core-and-optional-mcp.md`
- `docs/decisions/0005-logic-atlas-read-model.md`
- `docs/decisions/0006-design-workspace-and-prd-to-design-pipeline.md`
- `docs/implementation-plan-voidtech-suite-plugin-split-2026-07-24.md`
- `docs/implementation-plan-design-from-prd-2026-07-24.md`
