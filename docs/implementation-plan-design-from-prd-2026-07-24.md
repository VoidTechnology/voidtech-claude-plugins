# 实施计划：`design-from-prd` 可追溯设计流水线

- **日期**：2026-07-24
- **状态**：Draft（待工程评审）
- **摘要**：在 `voidtech-design` 中新增 `/voidtech-design:design-from-prd`，以 Core Suite Atlas 中的新鲜 Product Fragment 为确定性输入，建立独立 Design Workspace，按端到端 flow 完成设计就绪判断、Design Packet、共享代码原型、状态验收、需求追溯和双重审查，并输出 Design Atlas Fragment。第一条垂直切片必须从真实 Product Artifact 走到 `accepted` 并进入 Suite Atlas，再接 claude.ai/design 与 Figma adapter。
- **架构决策**：`docs/decisions/0006-design-workspace-and-prd-to-design-pipeline.md`
- **上游决策**：`docs/decisions/0005-logic-atlas-read-model.md`
- **Suite 上位决策**：`docs/decisions/0007-voidtech-suite-plugin-architecture.md`
- **相关技术设计**：`docs/tech-design-prd-sync-and-logic-atlas-2026-07-21.md`

## 1. 目标

把当前“人工提炼 PRD → 单次生成页面”的设计方式升级为可持续流水线，使 PM、设计和工程能够共同验证：

1. 只有设计就绪的 flow 才进入高保真。
2. 生成输入只包含当前 E2E flow 的确定事实、缺口和来源。
3. 全部页面复用同一 IA、App Shell、交互语义和组件注册表。
4. PRD 已定义的正常、异常、权限、会话和业务状态都能在原型中观察。
5. 每个页面、动作、状态和路由都能回到 REQ 或已批准 DD。
6. PRD 变化后，只将受影响 flow 标记为 stale。

“完成”不是新增一个 Skill 文件，而是一条真实 flow 能执行：

```text
Product Atlas Fragment / Core Suite Atlas
→ readiness
→ Design Packet
→ Foundation
→ code prototype
→ state verification
→ PM review
→ Designer review
→ trace verification
→ accepted
→ PRD change
→ stale
```

## 2. 用户与核心场景

### 2.1 主要用户

- **PM**：判断哪些需求可以设计，逐条验证行为、权限、状态和边缘场景。
- **Designer**：在全局 IA 与组件规范内组合页面，识别交互和视觉漂移。
- **工程团队**：通过可点击原型和 trace 理解跨模块行为，不把验证代码误认为生产代码。

### 2.2 核心场景

1. PM 初始化 Design Workspace，查看全部 flow 的就绪分类和阻塞原因。
2. PM 选择一个 high-fidelity-ready flow，生成 Design Packet。
3. 系统建立或复用 Foundation，并生成共享原型中的相关路由。
4. PM 使用状态切换器验收 loading、empty、error、permission、session 和业务状态。
5. 系统输出 Missing、Orphan、Conflict、State Gap 和 Route Gap。
6. PM 与 Designer 分别审查，flow 通过后进入 accepted。
7. PRD 更新后，系统报告受影响的 flow、page、action、state、route 和 DD。

## 3. 明确不做

第一轮实现不做：

- 批量生成全部模块和页面。
- 把设计决策写回 Product Workspace 或 Product Atlas Fragment。
- 读取根 `full-prd.md` 作为生成输入。
- 自动关闭 Open Question 或填补 Product Fragment/Core Atlas gap。
- 自动批准 Design Decision。
- 连接真实生产后端。
- 默认把原型作为生产脚手架。
- 把 Figma 或 claude.ai/design 设为核心依赖。
- PRD 与 Figma 双向同步。

## 4. 目标架构

```text
Product Workspace
        |
        | voidtech-product projection
        v
Product Atlas Fragment
        |
        | Core Artifact/Atlas contract
        v
Core Suite Atlas
        |
        v
prd-design.py
  |-- init/readiness/status
  |-- packet
  |-- verify
  `-- refresh
        |
        v
Design Workspace
  |-- foundation
  |-- packets
  |-- decisions
  |-- prototype
  |-- traces
  `-- Design Atlas Fragment
        |
        +--> Core Suite Atlas
        +--> Code Prototype Adapter
        +--> to-design-brief Adapter
        `--> Figma Adapter
```

### 4.1 模块边界

| 模块 | 接口 | 隐藏的复杂度 |
|---|---|---|
| Artifact Reader | `load_product_artifact(path)` | Core Envelope、Fragment schema、digest、新鲜度检查 |
| Readiness Evaluator | `evaluate(flow_id)` | 模块成熟度、权限、状态、gap/OQ 阻塞规则 |
| Packet Compiler | `compile(flow_id)` | flow 闭包、来源裁剪、顺序与稳定输出 |
| Decision Store | `propose/approve/reject/supersede` | DD 生命周期、引用和冲突 |
| Design Projection | `build_fragment(flow_id)` | Workspace→Design Atlas Fragment、来源与稳定排序 |
| Trace Verifier | `verify(flow_id)` | Missing/Orphan/Conflict/State/Route 检查，并请求 Core 组合验证 |
| Impact Client | `refresh()` | 提交来源摘要给 Core Impact Analyzer，接收 stale 影响集合 |
| Output Adapter | `render(packet, workspace)` | Code、Brief 或 Figma 工具差异 |

CLI 和测试只调用这些公开接口，不直接访问内部文件布局。

### 4.2 目录规划

```text
plugins/voidtech-design/
├── skills/
│   └── design-from-prd/
│       ├── SKILL.md
│       ├── WORKFLOW.md
│       ├── schemas/
│       │   ├── design-workspace.schema.json
│       │   ├── design-readiness.schema.json
│       │   ├── design-packet.schema.json
│       │   ├── design-decision.schema.json
│       │   ├── design-trace.schema.json
│       │   └── prototype-manifest.schema.json
│       ├── templates/
│       │   ├── design-workspace.json
│       │   ├── foundation/
│       │   └── prototype/
│       ├── scripts/
│       │   ├── prd-design.py
│       │   └── prddesign/
│       └── tests/
└── agents/
    ├── designer.md
    └── design-reviewer.md
```

`prddesign` 只消费 Core Artifact Envelope 和 Atlas Fragment 公共契约，不导入 `voidtech-product`、`prdsync` 或 Core Atlas 私有实现。

## 5. 核心数据契约

### 5.1 Design Workspace Manifest

至少保存：

- workspace schema version。
- Product Artifact、Product Atlas Fragment 和 Core Suite Atlas manifest 的相对路径与摘要。
- Foundation 版本。
- flow 状态和最后验证结果。
- adapter 配置。
- 当前 accepted flow 集合。

路径必须相对项目根目录，可跨机器复制。

### 5.2 Design Readiness

每个 flow 保存：

- 分类：`high-fidelity-ready`、`low-fidelity-ready`、`blocked`。
- 命中的机械规则。
- blocker、warning 和 source reference。
- Product Fragment 与 Core Suite Atlas digest。
- 评估器版本。

不得保存综合分数。

### 5.3 Design Packet

JSON 为机器契约，Markdown 为模型和人工阅读投影。至少包含：

- flow、actor、precondition、postcondition。
- ordered steps。
- module/page/requirement/state/permission 引用。
- failure/recovery paths。
- business boundaries 和 data authority。
- gap、Open Question、out-of-scope。
- 每条内容的 source reference。

相同 Atlas、flow 和编译器版本必须产生相同 Packet 内容摘要。

### 5.4 Design Decision

字段至少包含：

- `decisionId`。
- `status`：Proposed、Approved、Rejected、Superseded。
- design question、candidate options、decision 和 rationale。
- affected flow/page/component。
- approver 和 approvedAt。
- sourceRefs。
- supersedes/supersededBy。

只有 Approved 且未被 supersede 的 DD 可以成为 trace 来源。

### 5.5 Design Trace

每条 trace 固定表达：

```text
requirementRef
→ flowStepRef
→ pageRef
→ componentOrActionRef
→ scenarioStateRef
→ routeRef
```

允许一个需求映射多个交互点，但每个交互点必须有唯一来源和适用条件。

### 5.6 Prototype Manifest

每个 route、action 和 scenario 必须引用：

- pageRef。
- requirementRef 或 approvedDecisionRef。
- stateRef。
- component registry ID。
- fixture/scenario ID。

无来源项不能只靠人工说明通过。

## 6. flow 状态机

```text
Unassessed
├── Blocked
├── LowFidelityReady
└── HighFidelityReady
         |
         v
      Packaged
         |
         v
      Prototyped
         |
         v
   BehaviorReviewed
         |
         v
     DesignReviewed
         |
         v
      Accepted
         |
         v
       Stale
         |
         `--> Unassessed
```

规则：

- Blocked 只能回到 Unassessed。
- LowFidelityReady 不得进入高保真 Accepted。
- BehaviorReviewed 和 DesignReviewed 必须保存独立结果。
- verify 有阻塞项时不得进入 Accepted。
- 来源变化后必须进入 Stale，不能自动保持 Accepted。

## 7. 依赖图

```text
M0 Architecture and Schemas
        |
        v
M1 Atlas Reader and Readiness
        |
        v
M2 Packet, Decision and Trace Compiler
        |
        v
M3 Skill Orchestrator and Foundation
        |
        v
M4 Shared Prototype Vertical Pilot
        |
        v
M5 Verification and Dual Review
        |
        v
M6 Refresh and Change Impact
        |
        v
M7 Output Adapters
        |
        v
M8 Plugin Integration and Rollout
```

M4 必须在真实 PRD 工作树上完成 smoke test，之后才进入 M5–M8 的收尾能力。

## 8. Milestone 0：架构与 Schema

### Task 0.1：建立新 Skill 与 CLI 骨架

**说明**：创建 `design-from-prd` 目录、CLI 入口和 `prddesign` 包；只实现 `--help` 与错误码，不接业务。

**验收标准：**

- Skill 名与目录名均为 `design-from-prd`。
- CLI 通过 `${CLAUDE_PLUGIN_ROOT}` 定位资源，不写死用户目录。
- CLI 未找到 PRD 或 Atlas 时返回结构化错误，不创建半成品 Workspace。
- `prddesign` 不导入 `prdsync` 私有实现。

**验证：**

```bash
python3 plugins/voidtech-design/skills/design-from-prd/scripts/prd-design.py --help
python3 -m unittest discover plugins/voidtech-design/skills/design-from-prd/tests
```

**依赖**：ADR-0006、ADR-0007，以及 Suite 拆分计划 Checkpoint M1。

### Task 0.2：定义六份公共 Schema

**说明**：定义 Workspace、Readiness、Packet、Decision、Trace 和 Prototype Manifest 契约及合法/非法 fixture。

**验收标准：**

- 所有对象默认 `additionalProperties: false`。
- ID、状态枚举、相对路径和 source reference 有明确约束。
- Approved DD、stale flow 和 N/A state reason 可以被机械表达。
- 每份 Schema 至少有一个合法和两个针对真实失败模式的非法 fixture。

**依赖**：Task 0.1。

### Checkpoint M0

- Schema 与 ADR 权威边界一致。
- Schema fixture 全部通过。
- Design detail 只进入 Design Schema/Fragment，不污染 Core Atlas Fragment Envelope。

## 9. Milestone 1：Artifact Reader 与 Gate 0

### Task 1.1：实现 `init`、`status` 与 Atlas 新鲜度门

**说明**：从项目根定位 Core Artifact/Atlas manifest 和 Product Atlas Fragment，校验 schema、兼容版本、输入摘要和路径后原子创建 `design/design-workspace.json`；不读取 Product Workspace 主本。

**验收标准：**

- Product Fragment 或 Core Suite Atlas stale、manifest 缺失、schema 不兼容时 fail closed。
- 重复 `init` 对相同配置幂等。
- 已存在 Workspace 且输入不同时拒绝静默覆盖。
- 所有写入使用同目录临时文件加原子替换。

**依赖**：Task 0.2。

### Task 1.2：实现 flow 级 readiness 分类

**说明**：从 Product Fragment 在 Core Suite Atlas 中的显式关系计算 flow 闭包并执行规则分类，不使用综合分数。

**验收标准：**

- 骨架级模块、缺页面契约、高风险 OQ、关键权限缺口能阻止高保真。
- 非关键 warning 不把 flow 错判为 blocked。
- 每个结果列出 rule ID、原因和 source reference。
- 同一输入重复运行结果和排序稳定。

**验证：**

```bash
python3 plugins/voidtech-design/skills/design-from-prd/scripts/prd-design.py readiness \
  --product-artifact /Users/dodo/projects/Example-prd-from-requirements/prd/_generated/atlas/product-fragment.json
```

**依赖**：Task 1.1。

### Checkpoint M1

在 `Example-prd-from-requirements` 上人工对照：

- 骨架级 flow 不得进入 high-fidelity-ready。
- 当前可设计 flow、低保真 flow 和 blocked flow 的原因可判真伪。
- Atlas 的 gap/OQ 没有被隐藏或自动裁决。

Gate 0 与人工判断不一致时停在 M1，修正规则，不进入原型开发。

## 10. Milestone 2：Packet、Decision 与 Trace

### Task 2.1：实现确定性 Design Packet Compiler

**说明**：只裁剪当前 flow 需要的 module/page/requirement/state/permission/data/gap/OQ/sourceRef，生成 JSON 和 Markdown。

**验收标准：**

- 不读取 `full-prd.md`、聚合 PRD、历史 Packet 或原型。
- Packet 不包含 flow 闭包外的无关需求。
- 未知关系保持 gap，不生成推断关系。
- 相同输入生成相同 digest。

**依赖**：Task 1.2。

### Task 2.2：实现 Design Decision Store

**说明**：支持 propose、approve、reject、supersede，并验证受影响范围和审批信息。

**验收标准：**

- Proposed DD 不能作为正式 trace 来源。
- Approved DD 必须有 approver、时间、rationale 和 affected refs。
- Superseded DD 不再为新设计提供来源，但历史 trace 可审计。
- 相同 decision 操作幂等，冲突操作失败。

**依赖**：Task 0.2。

### Task 2.3：实现 Trace Compiler

**说明**：从 Packet、Foundation、Prototype Manifest 和 Approved DD 编译固定追溯链。

**验收标准：**

- 每个 component/action/scenario/route 都能追到 REQ 或 Approved DD。
- withdrawn/removed requirement 不进入当前有效设计路径。
- 一个需求映射多个交互点时保留适用条件。
- 编译结果排序和摘要稳定。

**依赖**：Task 2.1、Task 2.2。

### Checkpoint M2

- 选定 flow 的 Packet 可独立供 Agent 阅读，不需要回读全量 PRD。
- 任意删除一个 sourceRef 后，Schema 或 trace 编译失败。
- 人工加入一个无来源按钮后，能被识别为 Orphan。

## 11. Milestone 3：Skill 编排与 Foundation

### Task 3.1：实现 `/voidtech-design:design-from-prd` 工作流

**说明**：Skill 依次调用 status、readiness、packet，处理 flow 选择、阻塞信息和 DD 审批，不让生成步骤跳过门禁。

**验收标准：**

- 用户只需调用一个 Skill。
- blocked flow 明确返回需要补齐的 PRD/OQ/gap，不继续生成。
- low-fidelity-ready 只允许带不确定性标记的线框。
- 所有模型生成内容先落为候选，机械验证后才写正式 Workspace。

**依赖**：Checkpoint M2。

### Task 3.2：建立 Foundation 契约和模板

**说明**：建立 IA、App Shell、Token、interaction semantics、page archetype 和 component registry。

**验收标准：**

- 三端导航和同一业务对象的名称唯一。
- loading、empty、filtered-empty、error、permission 和 session 语义唯一。
- page archetype 可覆盖列表、筛选、详情、分步创建、批量操作和审批工作台。
- 新组件必须记录不能复用既有组件的原因。

**依赖**：Task 3.1。

### Task 3.3：新增 Designer Agent

**说明**：新增只负责 IA、交互、视觉层级、组件复用和 AI slop 的 `designer` Agent；不允许修改产品规则。

**验收标准：**

- Designer 输出引用 flow、page、component 和 state ID。
- 发现产品缺口时退回 PM/OQ，不自行补规则。
- 与 `product-manager` 的行为审查职责无重叠。

**依赖**：Task 3.2。

## 12. Milestone 4：共享代码原型垂直试点

### Task 4.1：建立共享 Prototype App 和 Manifest

**说明**：在 `design/prototype/` 建立单一 App Shell、route、fixture、scenario、状态切换器和 Manifest 校验。

**验收标准：**

- 原型一条命令启动。
- route/action/scenario 缺少来源时构建失败。
- fixtures 与真实后端隔离，不持久化业务数据。
- 状态切换器可从 UI 操作，不要求 PM 修改代码。

**依赖**：Task 3.2。

### Task 4.2：选择第一条真实 E2E flow

**说明**：从 readiness 输出中选择一条 high-fidelity-ready flow。必须涉及至少两个模块，并包含权限或失败路径与业务状态变化。

**验收标准：**

- 选择依据保存到 Workspace，不预先指定一个可能不成熟的模块。
- flow 从明确入口走到明确终点。
- 跨模块对象名称、状态和返回路径一致。
- Packet 中所有 in-scope step 都有 prototype route。

**依赖**：Checkpoint M1、Task 4.1。

### Task 4.3：实现状态场景与 PM 可验收切换器

**说明**：为试点 flow 实现 PRD 要求的 UI 和业务状态；不适用状态保存 N/A 理由。

**验收标准：**

- loading、empty、error、permission、session、weak-network、long-content 和业务状态全部可观察或有 N/A。
- 切换状态不会破坏当前 flow 导航。
- 失败和恢复路径都能走回稳定状态。
- 页面不包含无来源字段、按钮或跳转。

**依赖**：Task 4.2。

### Smoke Checkpoint M4

必须实际启动原型并完成：

1. 正常路径。
2. 权限不足路径。
3. 至少一个服务失败与恢复路径。
4. 会话过期路径。
5. 一个业务状态变化路径。
6. 超长内容展示。

M4 未通过前，不实现输出 adapter 和发布收尾。

## 13. Milestone 5：Verify 与双重审查

### Task 5.1：实现 `verify`

**说明**：生成 Missing、Orphan、Conflict、State Gap、Route Gap、Stale 报告和阻塞级别。

**验收标准：**

- Orphan、未处理 Conflict、高风险 OQ、stale 来源阻止 accepted。
- 报告同时输出 JSON 与 Markdown。
- 每个问题包含 flow/page/action/state/route 和 source reference。
- 修复后重新 verify 只消除对应问题，不隐藏其他问题。

**依赖**：Smoke Checkpoint M4。

### Task 5.2：接入 PM 行为审查

**说明**：由 `product-manager` 检查任务闭环、权限、状态、边缘场景和 trace，不评价视觉风格。

**验收标准：**

- 每条审查结论引用 REQ/step/page/state。
- 未覆盖需求不能通过“后续再做”进入 accepted。
- 审查结论保存 reviewer、输入 digest 和结果。

**依赖**：Task 5.1。

### Task 5.3：接入 Designer 审查

**说明**：检查 IA、层级、间距、组件复用、交互语义和 AI slop，不改变产品规则。

**验收标准：**

- 与 PM 审查分别保存。
- 组件漂移能定位到 component registry ID。
- 需要产品裁决的问题生成 DD candidate 或 OQ，不直接修改设计事实。
- 每完成 3–5 个 flow 自动建议执行一致性审查。

**依赖**：Task 3.3、Task 5.1。

### Checkpoint M5

试点 flow 只有在以下条件同时成立时进入 Accepted：

- PM 行为审查通过。
- Designer 审查通过。
- verify 没有阻塞项。
- 需求和状态覆盖达到 100%，或状态有明确 N/A。
- 无来源行为数为 0。

## 14. Milestone 6：Refresh 与 Change Impact

### Task 6.1：保存来源快照

**说明**：在 Packaged 和 Accepted 时保存 flow 实际消费的 requirement/state/page/permission/DD 摘要。

**验收标准：**

- 快照只包含当前 flow 闭包。
- 使用内容摘要，不依赖修改时间。
- 快照版本与 Packet、Trace 和 Atlas digest 可关联。

**依赖**：Task 2.3。

### Task 6.2：实现 `refresh`

**说明**：对比当前 Atlas 与来源快照，计算受影响范围并标记 stale。

**验收标准：**

- 修改一个被试点 flow 引用的 requirement 后，该 flow 变为 Stale。
- 未引用该 requirement 的 accepted flow 状态不变。
- 报告列出受影响 page/action/state/route/DD。
- Stale flow 重新经过 readiness、verify 和双审查后才能恢复 Accepted。

**依赖**：Task 6.1、Checkpoint M5。

### Checkpoint M6

在示例 PRD 的副本上完成一次变更演练：

1. 修改一条已引用需求。
2. 重建 Product Atlas Fragment 与 Core Suite Atlas。
3. 执行 Design refresh。
4. 观察只影响关联 flow。
5. 回滚需求并再次 refresh。

## 15. Milestone 7：输出 Adapter

### Task 7.1：Code Prototype Adapter 固化

**说明**：将试点中的原型生成规则封装为默认 adapter，并保持核心 Trace 接口不依赖具体前端框架。

**验收标准：**

- Adapter 只能读取已验证 Packet、Foundation 和 Approved DD。
- 替换 adapter 不改变 trace 语义。
- 原型显著标注为设计验证产物，不承诺生产可用。

**依赖**：Checkpoint M5。

### Task 7.2：收缩 `to-design-brief`

**说明**：将 `to-design-brief` 改为从已验证 Design Packet 和 Foundation 导出 claude.ai/design brief，不再直接自由提炼任意 PRD。

**验收标准：**

- Brief 中的页面、状态和需求范围与 Packet 一致。
- 不添加未批准组件或行为。
- 保留一次粘贴的自包含特性。
- 对旧用法给出明确迁移说明，不保留两套含糊入口。

**依赖**：Task 7.1。

### Task 7.3：增加 Figma Adapter seam

**说明**：先定义 adapter 契约和输出验证，不把 Figma MCP 设为插件安装依赖。

**验收标准：**

- 未安装 Figma 能力时核心流水线完整可用。
- Figma 节点保留 flow/page/component/state/REQ/DD 标识。
- Figma 输出仍由同一个 verify 报告检查覆盖关系。

**依赖**：Task 7.1。

## 16. Milestone 8：插件接入与全量推广

### Task 8.1：更新公共插件契约

**说明**：登记新 Skill 和 Designer Agent，更新可移植性校验与隔离安装资源清单。

**验收标准：**

- `EXPECTED_CORE_SKILLS` 包含 `design-from-prd`。
- Skill 数量断言同步更新。
- `EXPECTED_CORE_AGENTS` 包含 `designer`，Agent 数量断言同步更新。
- 隔离安装后 CLI、Schema、模板和 Agent 全部存在。
- Skill 与 Agent 名称符合公共命令契约。

**依赖**：Checkpoint M6、Task 7.2。

### Task 8.2：插件级验证

**说明**：执行定向单元测试、Schema fixtures、可移植性检查和隔离安装 smoke。

**验收标准：**

- `design-from-prd` 单元测试通过。
- 现有 prdsync 测试无回归。
- Pyright 无新增错误。
- `scripts/check-portability.sh` 通过。
- 隔离安装后可以针对示例 PRD 完成 `status/readiness/packet/verify`。

**建议验证命令：**

```bash
python3 -m unittest discover plugins/voidtech-design/skills/design-from-prd/tests
python3 -m unittest discover plugins/voidtech-product/skills/prd-from-requirements/tests
pyright
bash scripts/check-portability.sh
```

**依赖**：Task 8.1。

### Task 8.3：更新发布文档和版本

**说明**：在真实垂直 flow、verify 和 stale 演练通过后，更新公共说明、使用指南、变更记录和插件版本。

**验收标准：**

- README 可在两次点击内到达实施计划和 ADR。
- `docs/USAGE.md` 覆盖 init、readiness、packet、verify、refresh 主路径与失败路径。
- CHANGELOG 说明新公共命令、Design Workspace 和迁移影响。
- `plugin.json` 与 Marketplace 版本一致。
- 文档不把原型描述为生产脚手架。

**依赖**：Task 8.2。

### Checkpoint M8

- 试点 flow 端到端验收通过。
- 公共插件隔离安装可用。
- 文档、Skill、Agent、CLI、Schema 和版本一致。
- 才开始按 readiness 结果扩展更多 flow。

## 17. 全量推广策略

完成试点后按 flow 推广，不按目录批量生成：

1. 优先覆盖 high-fidelity-ready 且跨模块价值最高的 flow。
2. 每完成 3–5 个 flow 执行 PM 与 Designer 一致性审查。
3. low-fidelity-ready flow 只用于发现缺口和验证 IA，不纳入高保真覆盖率。
4. blocked flow 回到 `/voidtech-product:prd-maintain` 或 OQ 裁决，不在 Design 层补需求。
5. 每轮结束运行全量 trace 和 change-impact 报告。

## 18. 风险与控制

| 风险 | 用户影响 | 控制 |
|---|---|---|
| 骨架级 PRD 被误判可设计 | 高保真稿固化错误行为 | 规则式 readiness；关键缺口直接 blocked |
| Packet 丢失跨模块关系 | 用户流程中途断裂 | 以 flow 闭包生成，保留 sourceRefs 与 gaps |
| Agent 擅自增加常见后台交互 | PRD 与设计事实不一致 | REQ/Approved DD 双来源门；Orphan 阻塞 |
| 设计系统逐 flow 漂移 | 页面拼起来不像同一产品 | Foundation、archetype、component registry 与周期审查 |
| 原型被误认为生产代码 | 工程继承隐性安全和维护债务 | 独立 design 目录、显式标识、无真实后端 |
| PRD 修改导致设计静默过期 | PM 验收的是旧规则 | 来源摘要、refresh 和 Stale 状态 |
| 核心被 Figma 工具锁定 | 无 Figma 环境时流程不可用 | adapter seam；Code Prototype 为默认出口 |
| Product 与 Design 工具互相耦合 | 任一侧改动扩大回归 | 只通过 Core Artifact Envelope、Atlas Fragment 和 digest 连接 |

## 19. 成功指标与发布门禁

### 北极星指标

**可设计需求闭环率**：

```text
有唯一 page/action/state/route 映射且通过验收的 in-scope 需求数
÷
in-scope 需求总数
```

### 反指标

**AI 新增但无 PRD 或 Approved DD 来源的行为数 = 0。**

### 每个 accepted flow 的机械门禁

- 需求追溯覆盖率 100%。
- PRD 已定义状态覆盖率 100%，或有明确 N/A 理由。
- Missing = 0。
- Orphan = 0。
- 未处理 Conflict = 0。
- Route Gap = 0。
- 高风险 Open Question = 0。
- Product Fragment、Suite Atlas、Packet、Design Fragment、Trace 和审查输入均为最新摘要。

## 20. 实施起点

第一批只实施：

1. 先完成 Suite 拆分计划 Task 0.1–1.4：Artifact Contract、Atlas Fragment、Composer、Archify Runtime 与通用 Adapter。
2. Task 0.1–0.2：Design Skill/CLI 骨架和 Schema。
3. Task 1.1–1.2：Artifact Reader 与 readiness。
4. 在 `Example-prd-from-requirements` 的 Product Fragment 上完成 Checkpoint M1。

Design M1 首先验证最危险的产品假设：Core Suite Atlas 中的 Product Fragment 是否足以稳定区分“可以高保真、只能低保真、不能设计”。该假设未通过前，不投入共享原型和出口 adapter。

## 21. 变更记录

| 日期 | 变更摘要 | 原因 |
|---|---|---|
| 2026-07-24 | 初版：在 Core 规划 `design-from-prd`、Design Workspace、共享原型、状态和追溯门禁 | 将验收级 PRD 转换为可持续设计生产线 |
| 2026-07-24 | 按 ADR-0007 改为 `voidtech-design:design-from-prd`；输入 Product Fragment/Core Suite Atlas，输出 Design Fragment；跨领域 coverage/freshness/change impact 交给 Core Atlas Engine | Suite 采用 Core 共享契约/Atlas/Archify内核与领域插件独立写模型 |
