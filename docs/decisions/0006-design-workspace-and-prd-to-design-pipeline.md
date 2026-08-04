# ADR-0006：Design Workspace 与 PRD 到设计流水线

## 状态

已接受（待实现；插件归属由 ADR-0007 修订）

## 日期

2026-07-24

## 摘要

在 `voidtech-design` 新增公共技能 `/voidtech-design:design-from-prd`，以 Core Suite Atlas 中的新鲜 Product Fragment 为确定性输入，建立独立于 Product Workspace 的 Design Workspace。Product Workspace 继续作为产品事实写模型；Design Workspace 保存经人确认的设计决策，并确定性输出 Design Atlas Fragment；原型、Design Brief 与 Figma 仅作为可替换出口。系统按端到端 flow 而非 module 执行设计就绪分类、Design Packet 生成、状态覆盖、需求追溯和一致性验证，跨领域 coverage、gaps、freshness 与 change impact 统一交给 Core Atlas Engine。任何页面、动作和状态都必须引用有效 REQ 或已批准 DD；无来源行为阻塞验收。

## 背景

现有 PRD 工作树已经具备模块 PRD、领域规格、跨系统流程、状态、权限、追溯矩阵和机器可解析交互契约。ADR-0005 已将 Logic Atlas 定义为从权威主本确定性编译的只读投影，并要求未知关系进入 gaps，不允许 Agent 补写正式逻辑关系。

现有设计相关技能不能承载长期设计生产线：

- `to-design-brief` 将设计语言与单份 PRD 压缩为一次性、自包含 brief，面向 claude.ai/design 逐页生成；它没有设计就绪门、跨 flow 追溯、状态覆盖报告和变更影响分析。
- `prototype` 明确用于回答一个设计问题，默认验证后清理；把它扩展为长期共享原型会破坏其一次性实验职责。

直接执行“单份 PRD → 高保真页面”会产生四类问题：

1. 骨架级 PRD 被视觉完成度掩盖，AI 将缺口误写成产品事实。
2. 以 module 为单位生成页面，跨模块、跨角色和跨端流程容易断裂。
3. 页面之间重新发明组件、间距、状态和交互，形成不可复用的 AI slop。
4. PRD 更新后无法判断哪些页面、动作和状态已经过期。

需要新增一层能够保存设计决策、执行机械校验并支持多种设计出口的工作模型，同时保持 PRD 和 Logic Atlas 的权威边界不变。

## 决策

### 1. 新增独立公共技能 `design-from-prd`

在 `voidtech-design` 发布 `/voidtech-design:design-from-prd`，统一编排：

1. Core Suite Atlas 与 Product Fragment 新鲜度检查。
2. flow 级设计就绪分类。
3. Design Packet 生成。
4. 全局 IA、App Shell 与交互设计系统建立或复用。
5. 共享可点击原型生成。
6. PM 行为审查与 Designer 视觉/交互审查。
7. trace、状态覆盖、Orphan 和 Conflict 校验。
8. PRD 更新后的 stale 标记与影响分析。

该技能是工作流入口，不直接解析整份 `full-prd.md`，不成为新的产品事实来源。

### 2. 新增独立确定性 CLI `prd-design.py`

`prd-design.py` 与 Product 插件的 `prd-sync.py` 分离：

- `prd-sync.py` 负责 Product Workspace 维护并输出 Product Atlas Fragment。
- `prd-design.py` 消费 Core Artifact/Atlas Fragment 公共契约，维护 Design Workspace、输出 Design Atlas Fragment，并请求 Core Atlas Engine 重建跨领域报告。

CLI 第一版只暴露六个命令：

```text
init
readiness
packet
verify
status
refresh
```

`prd-design.py` 不导入 Product 插件或 `prdsync` 私有实现；二者只通过 Core Artifact Envelope、Atlas Fragment Schema 和内容摘要连接。Product 编译器内部重构不会迫使 Design 工作流同步重写；只要已有兼容 Product Artifact，Design 不要求运行时安装 Product 插件。

### 3. Design Workspace 与 Product Workspace 同级

默认目录：

```text
<project>/
├── prd/
└── design/
    ├── design-workspace.json
    ├── readiness/
    ├── foundation/
    ├── packets/
    ├── decisions/
    ├── prototype/
    ├── traces/
    └── _generated/
```

职责固定为：

| 层级 | 权威内容 | 写入者 |
|---|---|---|
| Product Workspace | 用户行为、业务规则、字段、权限、状态、验收标准 | Product 工作流与人工裁决 |
| Product Atlas Fragment | Product Workspace 中已明确关系的确定性投影 | `prd-sync`/Product Projection |
| Design Workspace | 经确认的 IA、交互规则、组件规则和设计决策 | `design-from-prd` 与人工审批 |
| Design Atlas Fragment | Design Workspace 的确定性关系投影 | `prd-design.py`/Design Projection |
| Suite Atlas 与跨领域报告 | Product、Design、Engineering、QA Fragment 的组合视图 | Core Atlas Engine |
| 原型、Brief、Figma | Design Workspace 的交付表达 | 对应 adapter |

设计信息不写回 Product Workspace 或 Product Atlas Fragment；Design Fragment 只由 Design Workspace 重建；Suite Atlas、coverage、gaps、freshness 与 change impact 报告均为 Core 可重建读模型。

### 4. 设计就绪度按 flow 分类，不使用综合分数

每个端到端 flow 只能处于以下一种就绪结果：

- `high-fidelity-ready`：可以进入高保真设计。
- `low-fidelity-ready`：只能生成带不确定性标记的低保真线框。
- `blocked`：影响主流程的事实不足，禁止生成设计。

分类由规则决定，不计算会掩盖阻塞项的总分。至少检查：

- Logic Atlas 是否新鲜。
- flow、step、page 与 requirement 是否完整关联。
- 涉及模块和领域规格的成熟度。
- 角色、权限、feature gating 和数据边界。
- 主流程状态与失败/恢复路径。
- 高风险 Open Question 和 Logic Atlas gap。

### 5. Design Packet 是唯一生成输入

每次设计只消费当前 flow 的 Design Packet。Packet 同时生成 JSON 与 Markdown，包含：

- actors、preconditions 和 postconditions。
- flow steps、module/page/requirement 引用。
- permissions、feature gating 和 data boundaries。
- business states、UI states、failure/recovery paths。
- cross-system interactions。
- gaps、Open Questions 和明确不做范围。
- 每条内容的 source reference。

Packet 不读取根 `full-prd.md`、系统聚合 PRD、上一次 Packet 或原型。无法从 Logic Atlas 确定的关系保持缺失，不根据产品常识补齐。

### 6. 引入受审批的 Design Decision

PRD 不必规定抽屉或独立页、保存后去向、筛选持久化等设计表达。此类选择写入 `DD-*`，生命周期为：

```text
Proposed → Approved | Rejected → Superseded
```

AI 可以生成 `DD-CANDIDATE`，但候选在人工批准前：

- 不得进入正式 Design Packet。
- 不得作为原型行为来源。
- 不得让 Orphan 校验通过。

正式界面行为只允许引用有效 `REQ-*` 或已批准 `DD-*`。

### 7. 追溯链固定且机械验证

设计追溯链固定为：

```text
REQ
→ flow step
→ page
→ component/action
→ scenario state
→ prototype route
```

`verify` 至少输出：

- `Missing`：需求没有设计落点。
- `Orphan`：界面行为没有 REQ 或已批准 DD 来源。
- `Conflict`：同一规则在不同页面或流程中表达不一致。
- `State Gap`：PRD 定义的状态未在设计中覆盖。
- `Route Gap`：flow step 没有可访问路由。
- `Stale`：来源 PRD 已变化，设计尚未重审。

任何 Orphan、未处理 Conflict、高风险 Open Question 或来源过期都会阻止 flow 进入 `accepted`。

### 8. 全局设计基础只建立一次

Design Workspace 保存并复用：

- 三端 Information Architecture。
- App Shell 和全局导航。
- 视觉 token 与语义 token。
- interaction semantics。
- page archetypes。
- component registry。

独立公开技能 `create-design-md` 可以从当前项目事实创建或修订符合 Google specification 的 `DESIGN.md`，作为上述 Foundation 的人工可读、可 lint 表达；它不建立 `accepted` flow，不写 Product Workspace，也不绕过本 ADR 的 readiness、trace、双审查与 Design Decision 审批。

后续 flow 必须优先组合既有 archetype 和组件。新增组件需要记录适用范围和无法复用既有组件的原因。

外部 `design-consultation` 可以协助产生候选，但不能成为插件硬依赖；Foundation Schema 才是稳定接口。

### 9. 原型是共享设计读模型，不是生产代码承诺

`design/prototype/` 保存单一共享 App Shell、route、fixture、scenario 和 `prototype-manifest.json`。每个 route、action 和 scenario 都必须引用 page、REQ/DD 或 state。

原型内置状态切换器，至少能呈现 PRD 要求的：

- loading、refreshing、empty、filtered-empty。
- error、partial failure、weak network、offline。
- permission denied、session expired。
- long content。
- 业务对象状态。

不适用状态允许标记 `N/A`，但必须保存理由。

原型默认是可长期维护、但可整体丢弃的验证产物。只有明确复用生产技术栈、生产组件和工程契约时，才可单独评估转为开发脚手架。

### 10. 输出工具使用 adapter seam

核心流水线只依赖 Design Packet、Design Workspace 和 trace 契约。输出按 adapter 接入：

1. Code Prototype Adapter，作为第一默认出口。
2. `to-design-brief` Adapter，将已验证 Packet 导出到 claude.ai/design。
3. Figma Adapter，后续接入。

更换设计工具不修改 readiness、trace、decision 和 change-impact 核心规则。

### 11. 审查职责分离

- `product-manager` Agent：Gate 0、端到端行为、需求和状态追溯审查。
- 新增 `designer` Agent：IA、层级、交互一致性、组件复用和 AI slop 审查。
- 主 Agent：编排工作流、生成原型并执行机械验证。
- 用户：批准重要 DD 和最终设计范围。

每完成 3–5 个 flow，分别执行 PM 行为审查与 Designer 视觉/交互审查；两类结论不合并为单一综合结论。

### 12. PRD 变化按来源摘要触发 stale

Design Workspace 保存 flow 所消费 requirement、state、page、permission 和 DD 的来源快照。`refresh` 对比当前 Logic Atlas 后：

- 未受影响 flow 保持原状态。
- 来源变化的 flow 标记 `stale`。
- 报告受影响的 page、action、state、route 和 DD。
- stale flow 重新经过 readiness、verify 和审查后才能恢复 `accepted`。

不以文件修改时间判断新鲜度。

## 设计生命周期

```text
Unassessed
├── Blocked ───────────────┐
├── LowFidelityReady       │ PRD/OQ/gap 处理后
└── HighFidelityReady      │
          │                │
          v                │
       Packaged <──────────┘
          │
          v
       Prototyped
          │
          v
    BehaviorReviewed
          │
          v
      DesignReviewed
          │
          v
       Accepted
          │ PRD/领域规格变化
          v
        Stale
          │
          └──────────────> Unassessed
```

不允许跳过 readiness、双审查或 verify 直接进入 `accepted`。

## 被否决的方案

### 扩展 `prd-sync` 承担设计生成

否决原因：PRD 同步和设计决策具有不同权威边界与生命周期。合并后会让同步工具成为同时读写需求、设计和原型的浅接口，任何一层变化都会扩大回归范围。

### 把设计内容写回 Logic Atlas

否决原因：Atlas 是 ADR-0005 定义的确定性只读投影。设计表达包含人工选择，不是 PRD 事实；写回会建立第二套产品权威源。

### 继续以单 module 作为主要生成单位

否决原因：module 是文档归属，不是用户完成任务的边界。跨模块、跨角色和跨端状态只能在 E2E flow 中完整验证。

### 每个模块生成独立原型

否决原因：会重复 App Shell、组件和状态语义，无法机械发现组件漂移，也无法验证跨模块路由。

### 直接把代码原型定义为生产脚手架

否决原因：验证原型默认不承担生产数据、性能、安全和维护契约。可运行不等于可上线，必须在真实技术栈和工程审查后单独决定。

### 第一版绑定 Figma 或 claude.ai/design

否决原因：会把核心追溯能力锁定在单一出口。Code Prototype 最适合先证明端到端行为闭环，其他工具通过 adapter 后接。

## 后果

### 正向后果

- PRD 未成熟范围不会被高保真视觉掩盖。
- PM 可以在原型内逐状态验收，而不是只检查静态 happy path。
- 每条界面行为都有来源，AI 无法静默新增产品规则。
- PRD 变化只使相关 flow 过期，不要求全量重做。
- Code、Brief 和 Figma 共享同一事实与追溯契约。
- 设计系统成为跨 flow 复用资产，而不是 Prompt 中的风格描述。

### 成本与限制

- 首次生成页面前必须先完成 readiness 和 Foundation，早期出图速度会变慢。
- Design Workspace 增加一套需要维护的人类设计决策写模型。
- 高保真质量仍需要 PM 与 Designer 审查，不能完全自动化。
- 骨架级 PRD 可能只得到 blocked 或低保真结果，这是有意暴露缺口，而不是工具失败。

## 成功门禁

每个 `accepted` flow 必须满足：

- 需求追溯覆盖率 100%。
- PRD 已定义状态覆盖率 100%，或保存明确 `N/A` 理由。
- 无来源界面行为数为 0。
- 未处理 Conflict 为 0。
- 高风险 Open Question 为 0。
- Logic Atlas 与 Design Packet 新鲜度检查通过。
- PRD 变化后的 stale 检测通过。

北极星指标为“可设计需求闭环率”：

```text
有唯一 page/action/state/route 映射且通过验收的 in-scope 需求数
÷
in-scope 需求总数
```

反指标为“AI 新增但无 PRD 或已批准 DD 来源的行为数”，目标恒为 0。

## 关联文档

- `docs/decisions/0005-logic-atlas-read-model.md`
- `docs/decisions/0007-voidtech-suite-plugin-architecture.md`
- `docs/tech-design-prd-sync-and-logic-atlas-2026-07-21.md`
- `docs/implementation-plan-design-from-prd-2026-07-24.md`
- `plugins/voidtech-design/skills/to-design-brief/SKILL.md`（目标路径）
- `plugins/voidtech-design/skills/ui-prototype/SKILL.md`（目标路径，由现有 `prototype` UI 分支迁移）

## 变更记录

| 日期 | 变更摘要 | 原因 |
|---|---|---|
| 2026-07-24 | 初版：Design Workspace、flow readiness、Design Packet、共享原型、Design Decision 与 trace 门禁 | 将验收级 PRD 转换为可持续、可追溯的设计生产线 |
| 2026-07-24 | 按 ADR-0007 将 `design-from-prd` 从 Core 调整到 `voidtech-design`；输入改为 Core Atlas 中的 Product Fragment，输出 Design Fragment；跨领域 coverage、freshness 与 change impact 统一由 Core Atlas Engine 负责 | Core 收敛为共享契约/Atlas/Archify 内核，Design 拥有设计写模型但不拥有跨领域关系引擎 |
| 2026-08-04 | 补充 `create-design-md` 与 Design Workspace 的边界 | 允许独立维护标准 Design Foundation 文档，但不让单文件工作流冒充 flow readiness、trace 或 accepted 生命周期 |
