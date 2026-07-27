# 实施计划：VoidTech Product Delivery Suite 插件拆分

- **日期**：2026-07-24
- **状态**：Draft（待工程评审）
- **摘要**：将当前 `voidtech-core` 中混合的 Product、Design、Engineering、QA 能力拆分为四个领域插件，Core 收敛为公共 Artifact/Atlas/Archify 内核，Loop 保持确定性执行控制面。实施采用契约先行和垂直试点：先建立公共 Artifact 与 Suite Atlas，再用 `voidtech-design:design-from-prd` 验证跨插件交接，随后迁移 Product、Engineering，建立独立 QA，最后一次性完成公共命令切换。
- **架构决策**：`docs/decisions/0007-voidtech-suite-plugin-architecture.md`
- **关联 ADR**：`docs/decisions/0005-logic-atlas-read-model.md`、`docs/decisions/0006-design-workspace-and-prd-to-design-pipeline.md`
- **Design 子计划**：`docs/implementation-plan-design-from-prd-2026-07-24.md`

## 1. 目标

交付以下六层安装架构：

```text
voidtech-core
voidtech-product
voidtech-design
voidtech-engineering
voidtech-qa
voidtech-loop
```

完成标准：

1. 每个领域插件有独立写模型、状态和审批权。
2. 领域插件不直接调用彼此 Skill，只交换版本化 Artifact。
3. Core 能组合 Product、Design、Engineering、QA Atlas Fragment，输出 Suite Atlas。
4. Archify Runtime 和 Atlas→Archify Adapter 只有一份实现。
5. `to-prd`、`feature-context` 明确归 Engineering。
6. QA 能基于 Product/Design/Engineering Artifact 签发独立 Evidence 和 Release Recommendation。
7. Loop 只执行 Goal 和 eval，不拥有领域裁决。
8. 旧 Core 领域命令、内部引用和文档在同一发布中完成 Clean Cutover。

## 2. 不做

- 不新增 `voidtech-suite` 总包插件。
- 不复制 Skill 或 Agent 到多个插件。
- 不建立领域插件之间的代码依赖链。
- 不让 Core 读取 PRD、Design Workspace、源码或 QA Evidence。
- 不把当前 Product Logic Model 原样声明为公共 Atlas Schema。
- 不在 QA 首版覆盖所有性能、安全和兼容性测试类型；首版必须先完成一条独立端到端 Verification 闭环。
- 不保留长期 alias、双写实现或旧命令 shim。
- 不修改 MCP 插件的默认启用策略。

## 3. 目标目录

```text
plugins/
├── voidtech-core/
│   ├── contracts/
│   ├── atlas/
│   ├── vendor/archify/
│   ├── skills/
│   └── hooks/
├── voidtech-product/
│   ├── skills/
│   ├── agents/
│   ├── schemas/
│   └── scripts/
├── voidtech-design/
│   ├── skills/
│   ├── agents/
│   ├── schemas/
│   └── templates/
├── voidtech-engineering/
│   ├── skills/
│   ├── agents/
│   └── schemas/
├── voidtech-qa/
│   ├── skills/
│   ├── agents/
│   ├── schemas/
│   └── templates/
└── voidtech-loop/
```

具体目录可以按 Claude Code Plugin 约束调整，但权威归属不得变化。

## 4. 现有 Skill 迁移表

| 当前 Skill | 目标插件 | 处理 |
|---|---|---|
| `research` | Core | 原样保留，继续作为跨领域多信源研究能力 |
| `handoff` | Core | 保留，改为引用 Artifact Envelope |
| `learn` | Core | 保留 |
| `plan-review` | Core | 保留 |
| `plan-review-core` | Core | 保留 |
| `plan-review-docs` | Core | 保留 |
| `text-naturalizer` | Core | 保留 |
| `write-skills` | Core | 保留 |
| `prd-from-requirements` | Product | 整体迁移 PRD 写模型；拆出 Core Atlas/Archify 部分 |
| `prd-maintain` | Product | 迁移并改用 Product Artifact Contract |
| `prd-sync` | Product | 迁移；输出 Product Atlas Fragment |
| `to-design-brief` | Design | 改为 Design Packet 出口 |
| `prototype` UI 分支 | Design | 改名为 UI Prototype，服务 Design Workspace |
| 新 `design-from-prd` | Design | 按 ADR-0006 与子计划实现 |
| `architecture-review` | Engineering | 迁移 |
| `codebase-design` | Engineering | 迁移 |
| `feature-context` | Engineering | 迁移；维护 Repository Context，不维护 Product Workspace |
| `to-prd` | Engineering | 迁移；明确为 Engineering Delivery PRD |
| `to-issues` | Engineering | 迁移 |
| `prepare-issue` | Engineering | 迁移 |
| `implement` | Engineering | 迁移 |
| `debug` | Engineering | 迁移 |
| `tdd` | Engineering | 迁移，不进入 QA |
| `prototype` Logic 分支 | Engineering | 改名为 Logic Spike |
| `git-safety` | Engineering | 迁移 |
| `setup-git-checks` | Engineering | 迁移 |
| `fix-conflicts` | Engineering | 迁移 |
| `ship` | Engineering | 迁移，并消费 QA Release Recommendation（项目策略决定是否强制） |

QA 首版从新契约实现，不从 Engineering 复制 TDD。

## 5. Agent 归属

| 当前/新增 Agent | 目标插件 | 职责 |
|---|---|---|
| `product-manager` | Product | Product readiness、需求裁决、验收标准 |
| `architect` | Engineering | 技术架构、模块边界、实施顺序 |
| 新 `designer` | Design | IA、交互、组件和视觉一致性 |
| 新 `design-reviewer` | Design | 独立 Design 审查 |
| 新 `test-engineer` | QA | Verification Plan、场景和证据 |
| 新 `qa-reviewer` | QA | 独立 Release Recommendation 审查 |

Core 原则上不发布领域 Agent。Loop reviewer 只审查 Goal/eval/执行证据，不替代领域 reviewer。

## 6. 依赖图

```text
M0 Contract Kernel
      |
      v
M1 Suite Atlas and Archify Core
      |
      v
M2 Design Vertical Pilot
      |
      +----------+
      v          v
M3 Product    M4 Engineering
      \          /
       v        v
        M5 Independent QA
               |
               v
        M6 Loop Artifact Wiring
               |
               v
        M7 Clean Cutover Release
```

M0–M2 必须顺序完成。M3 和 M4 在公共契约稳定后可以并行，但首次 Clean Cutover 仍需统一发布。

## 7. Milestone 0：公共 Artifact Contract

### Task 0.1：定义 Artifact Envelope

**说明**：定义所有插件交接产物的公共外壳，不包含领域 detail。

至少包含：

```text
artifactId
kind
schemaVersion
producer
status
sourceRefs
sourceDigest
contentDigest
createdAt
```

**验收标准：**

- 所有路径为相对路径且禁止 `..`。
- sourceRefs 支持 artifact、文件锚点、REQ/DD/Issue/Commit 等稳定 ID。
- status 至少表达 Draft、Approved、Rejected、Superseded、Stale。
- contentDigest 使用固定 canonical JSON 规则。
- Schema 默认 `additionalProperties: false`。

### Task 0.2：定义兼容矩阵

**说明**：每个插件声明支持的 Core Contract 和 Atlas Fragment Schema 版本。

**验收标准：**

- 兼容版本不匹配时在工作流入口 fail closed。
- 报错包含生产插件、消费插件、实际版本和支持范围。
- 不依赖插件安装顺序猜测兼容性。
- One-Version Rule：同一运行中只接受一套公共 Contract 版本。

### Task 0.3：实现 Core Contract Validator

**说明**：提供领域无关的 JSON Schema、digest、source reference 和 compatibility 校验接口。

**验收标准：**

- 合法/非法 fixture 覆盖缺来源、错摘要、stale、未知版本和路径逃逸。
- Domain detail 不由 Core validator 解释。
- validator 可被所有插件通过稳定接口调用。

### Checkpoint M0

- 四种示例 Artifact 均通过同一 Envelope 校验。
- 删除任何 source reference 或修改内容不更新 digest 时校验失败。
- Core 不包含 product/design/engineering/qa 枚举。

## 8. Milestone 1：Suite Atlas 与 Archify Core

### Task 1.1：定义 Atlas Fragment Envelope

**说明**：把当前 Product Logic Model 拆成公共 Fragment 与 Product detail。

公共字段：

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

**验收标准：**

- node/edge kind 使用命名空间。
- Core 校验 ID 唯一、边端点存在、sourceRefs 有效和 Fragment 新鲜度。
- 领域 detail 由领域 schema 校验。
- 无来源 node/edge 不能进入正式 Fragment。

### Task 1.2：实现 Atlas Composer

**说明**：组合多个领域 Fragment，不合并来源不同但标题相似的节点。

**验收标准：**

- 同 ID 同摘要幂等。
- 同 ID 不同内容报告 conflict。
- 跨 Fragment trace 只接受显式稳定 ID。
- 缺失目标保留 gap，不猜测相似节点。
- 组合顺序不影响输出字节。

### Task 1.3：迁移 Archify Runtime

**说明**：将 vendored Archify、digest、validate/deliver、diagnostics、SVG/CSS 安全处理和 Render Receipt 从 `prd-from-requirements` 私有目录迁入 Core 深模块。

**验收标准：**

- vendor 只有一份。
- `doctor` 与五种图型 validate/deliver 通过。
- 运行时仍为 Node >=18、零 npm 安装依赖。
- vendor digest 变化使旧呈现证明失效。
- Node 缺失时返回结构化 presentation risk。

### Task 1.4：泛化 Atlas→Archify Adapter

**说明**：把当前 Product Logic Model→Lifecycle 改为 Atlas subgraph→Lifecycle；按真实需求保留其他四种 adapter seam，不提前生成无来源关系。

**验收标准：**

- Lifecycle Adapter 只读取 `state`/`transition` 语义，不读取 PRD 文件。
- 相同 subgraph 生成相同 IR 和 SVG digest。
- Product、Design、Engineering、QA Fragment 均可在满足相同状态契约时使用。
- 其他图型没有真实输入时不接线、不生成空图。

### Task 1.5：升级 Atlas Viewer

**说明**：在同一组合模型上提供 Product、Design、Engineering、QA 和 Delivery Trace 视图。

**验收标准：**

- 领域过滤不改变底层模型。
- 每个节点可返回来源 Artifact。
- Delivery Trace 能显示断点、stale 和 gap。
- Viewer 无外链运行时，浏览器控制台无错误。

### Checkpoint M1

- 当前 Example PRD 先投影为 Product Fragment，再生成与现有 Logic Atlas 等价的 Product View。
- 13 个现有状态机继续通过 Lifecycle fail-closed deliver。
- Atlas Composer 加入伪 Design/Engineering/QA fixture 后能显示跨域 trace，删除显式 edge 后只报告 gap，不自动连线。

## 9. Milestone 2：`voidtech-design` 垂直试点

### Task 2.1：创建 Design 插件清单与公共目录

**验收标准：**

- Marketplace 可独立安装 Design。
- Design 只依赖 Core Contract，不调用 Product Skill。
- 未安装 Product 但存在兼容 Product Artifact 时仍可运行。

### Task 2.2：实现 `design-from-prd`

按 `docs/implementation-plan-design-from-prd-2026-07-24.md` 执行，但所有路径改为 `plugins/voidtech-design/`，coverage/change impact 接入 Core Atlas。

### Task 2.3：输出 Design Atlas Fragment

**验收标准：**

- Design Decision、page、component/action、scenario state、route 带来源。
- trace 指向 Product REQ/flow/page 等显式 ID。
- 未批准 DD 不进入正式 Fragment。
- 无来源界面行为报告 Orphan 并阻止 accepted。

### Task 2.4：完成首条真实 flow

**验收标准：**

- 从 Product Artifact 到 Design Packet、共享原型、状态切换、双审查、Design Fragment 和 Suite Atlas 全链路通过。
- PRD 变化后 Core impact 能将关联 Design flow 标记 stale。
- Figma 与 claude.ai/design 不作为试点前置。

### Checkpoint M2

Design 纵向试点通过后，公共 Contract 才允许作为 Product 与 Engineering 迁移基础。未通过时修正 Contract，不通过跨插件特例绕过。

## 10. Milestone 3：`voidtech-product` 迁移

### Task 3.1：创建 Product 插件

**说明**：迁移 PRD 写模型、Agent、schema、模板和测试，不迁入 Core Atlas/Archify 实现。

**验收标准：**

- `prd-from-requirements`、`prd-maintain`、`prd-sync` 在 Product 安装后独立可用。
- Product 不依赖 Design、Engineering、QA 或 Loop。
- PRD 工作树与 Requirement Ledger 路径保持稳定，除非另有明确迁移。

### Task 3.2：实现 Product Atlas Projection

**说明**：从 PRD、领域规格、ledger、OQ 和 trace matrix 输出 Product Fragment。

**验收标准：**

- requirement/flow/state/page/permission/dataObject 使用 `product.*` kind。
- Product detail schema 保留当前 Logic Model 的强校验。
- 未解析结构继续进入 gaps。
- Core Composer 不读取 PRD 文件。

### Task 3.3：迁移 Product Agent 与文档

**验收标准：**

- Product Manager Agent 不修改代码实现或 Design Decision。
- 所有 `/voidtech-core:prd-*` 文档更新为 `/voidtech-product:prd-*`。
- 不保留 Core 旧实现副本。

### Checkpoint M3

- Example PRD 全部 prdsync 测试通过。
- Product Fragment 经 Core Atlas 生成 Product View。
- Source Sync、Requirement Ledger、Atlas 内容门和呈现降级无回归。

## 11. Milestone 4：`voidtech-engineering` 迁移

### Task 4.1：创建 Engineering 插件

迁移 Architecture、Implementation、Debug、TDD、Git 和 Ship 能力及 Architect Agent。

### Task 4.2：迁移 `to-prd`

**验收标准：**

- 新命令为 `/voidtech-engineering:to-prd`。
- 描述明确为已讨论需求→工程交付 PRD/ready-for-agent Issue。
- 继续包含 seam、实现和测试决策。
- 与 Product 的 `prd-from-requirements` 在 README/USAGE 中并列说明，不产生两套产品权威主本。

### Task 4.3：迁移 `feature-context`

**验收标准：**

- 新命令为 `/voidtech-engineering:feature-context`。
- `CONTEXT.md` 明确是 Repository Context，不是 Product Workspace。
- 与 Product Contract 冲突时生成待裁决项，不直接修改产品规则。
- 代码、Context 和 ADR 的关系保持现有行为。

### Task 4.4：拆分 `prototype`

**验收标准：**

- UI Prototype 归 Design。
- Logic Spike 归 Engineering。
- 两者名称、输入、生命周期和清理规则不含糊。
- 无重复实现或共享可变模板。

### Task 4.5：输出 Engineering Atlas Fragment

**验收标准：**

- issue/module/api/change/commit/build 节点带真实仓库来源。
- `implements` 只连接显式 Requirement/Design Artifact 引用。
- 不根据文件名相似度猜模块与需求关系。
- Change Manifest 可供 QA 计算回归范围。

### Checkpoint M4

- 一条已批准 Product/Design Contract 能生成 Engineering Issue、实现计划、指定 commit 和 Engineering Fragment。
- Core Delivery Trace 显示 REQ→Design/NA→Issue→Change→Commit。

## 12. Milestone 5：`voidtech-qa` 独立验证

### Task 5.1：定义 Verification Workspace 与 Evidence Pack

至少包含：

- verification scope。
- environment 和 build/commit reference。
- scenario、expected behavior、observed evidence。
- defect、severity、reproduction。
- residual risk。
- Release Recommendation。

**验收标准：**

- Evidence 绑定具体 commit/build 和输入 Artifact digest。
- Engineering 测试结果可以作为证据，但不能自动变成 QA Verdict。
- Stale Product/Design/Engineering Artifact 阻止最终 Recommendation。

### Task 5.2：实现 Test Plan 生成

**验收标准：**

- Product AC 生成行为场景。
- Design state 生成 UI 状态场景。
- Engineering Change Manifest 生成回归范围。
- 缺失场景进入 gap，不用通用测试模板伪装覆盖。

### Task 5.3：实现 Verification 执行与证据采集

首条闭环至少覆盖：

- 正常端到端路径。
- 权限拒绝。
- 会话过期。
- 服务失败和恢复。
- 数据或状态变化。
- 一个回归场景。

### Task 5.4：输出 QA Atlas Fragment

**验收标准：**

- scenario/evidence/defect/verdict 均带来源。
- `verifies` 指向具体 REQ/DD/change/commit。
- 缺证据的 scenario 不能进入 passed verdict。
- Release Recommendation 与缺陷和残余风险一致。

### Checkpoint M5

- QA Agent 不修改 Product、Design 或 Engineering 写模型。
- Core Delivery Trace 从 REQ 走到 QA Verdict。
- Engineering 无法用自己的 TDD 结果绕过 QA 审批。

## 13. Milestone 6：Loop Artifact 接线

### Task 6.1：扩展 Goal Spec Artifact Reference

**验收标准：**

- Goal 可以引用任意兼容 Artifact ID/digest。
- Loop 只检查存在性、新鲜度和 eval 约定，不解释领域 detail。
- Artifact 更新后旧 Goal 明确 stale 或要求重新批准。

### Task 6.2：保持执行控制面中立

**验收标准：**

- Loop reviewer 不替代 Product/Design/QA reviewer。
- `EVALS_PASSED` 继续只表示指定 commit 通过约定 eval。
- Loop 不自动发布 Release Recommendation、push、merge 或部署。

### Checkpoint M6

对 Product、Design、Engineering、QA 各选一个 Artifact fixture，验证 Loop 可以引用和记录，但无法修改领域状态。

## 14. Milestone 7：Clean Cutover

### Task 7.1：更新 Marketplace 和可移植性契约

**验收标准：**

- Marketplace 登记 Product、Design、Engineering、QA。
- 每个插件 Skill/Agent 名称和数量独立校验。
- Core 只保留通用 Skill 和共享运行时。
- 隔离安装矩阵覆盖单插件 Preset 和 Full Lifecycle。

### Task 7.2：迁移全部内部引用

**验收标准：**

- 仓库不再引用已迁移的 `/voidtech-core:<domain-skill>`。
- Skill、Agent、README、USAGE、模板和测试引用全部指向新插件。
- 无跨领域 Skill 调用。

### Task 7.3：删除 Core 旧实现

**验收标准：**

- 同一 Skill 只有一个发布位置。
- Core 不保留 alias、re-export 或弃用副本。
- `prototype` 旧双分支被 Design/Engineering 新能力替代。
- Archify vendor 只有一份。

### Task 7.4：发布安装 Preset 与迁移表

至少提供：

- Product Discovery。
- Product Design。
- Engineering。
- Release Verification。
- Full Lifecycle。
- 旧命令→新命令完整映射。

### Task 7.5：全量验证与版本发布

**验证范围：**

```text
Core contract/Atlas/Archify tests
Product prdsync tests
Design flow/prototype/trace tests
Engineering skill contract tests
QA verification/evidence tests
Loop regression tests
check-portability
isolated marketplace install
browser smoke
```

所有领域插件和 Marketplace 版本、README、USAGE、CHANGELOG 必须一致。

## 15. 架构门禁

以下任一情况阻止发布：

1. 一个 Skill 或 Agent 在两个领域插件重复发布。
2. 领域插件直接引用另一个领域插件的 Skill 名称。
3. Core Schema 包含未经命名空间隔离的领域枚举。
4. Core 直接读取 PRD、Design Workspace、源码或 QA Evidence。
5. 无来源 Atlas node/edge 进入正式模型。
6. Engineering 自动签发 QA passed/release recommendation。
7. Archify vendor 出现多份或版本不一致。
8. 旧 Core 命令仍通过 alias 工作。
9. 某 Preset 只能依赖未声明的安装顺序才能运行。

## 16. 风险与控制

| 风险 | 影响 | 控制 |
|---|---|---|
| 公共 Contract 过早泛化 | 四个领域被迫使用空洞模型 | Core 只定义 Envelope；领域 detail 保持强 Schema |
| Product Atlas 迁移丢失现有质量门 | Logic Atlas 回归 | 先建立 Product Fragment 等价证明，再移动目录 |
| Core 再次膨胀 | 新的单体插件 | Core 只收公共契约、组合和呈现，不收领域工作流 |
| 插件数量增加安装负担 | 用户不知道装什么 | Preset + 明确缺失依赖错误，不增加总包插件 |
| QA 与 TDD 重叠 | 独立验收失效 | TDD 永远归 Engineering；QA 拥有 Evidence/Verdict |
| 跨插件引用易过期 | 追溯失真 | digest、新鲜度、stale 传播和兼容矩阵 |
| Clean Cutover 破坏旧命令 | 用户迁移失败 | 完整命令迁移表、同版本更新全部文档和内部调用 |

## 17. 成功指标

### 北极星指标

**跨角色交付闭环率**：

```text
拥有 Product Contract、Design Contract 或明确 N/A、Implementation Contract、
独立 Verification Evidence 与 Release Recommendation 的 in-scope 需求数
÷
in-scope 需求总数
```

### 架构反指标

- 重复 Skill 数 = 0。
- 跨领域 Skill 直接调用数 = 0。
- 无来源 Atlas node/edge 数 = 0。
- Engineering 自签 QA 通过数 = 0。
- 同一事实双写模型权威数 = 0。

## 18. 第一实施切片

第一批只执行：

1. Task 0.1–0.3：Artifact Contract 和 compatibility。
2. Task 1.1–1.4：Atlas Fragment、Composer、Archify Runtime 和通用 Lifecycle Adapter。
3. 用当前 Example PRD 生成 Product Fragment，并证明 Product View 与现有 Logic Atlas 等价。

该切片首先验证最危险的假设：现有 Product Logic Model 能否在不损失来源、gap、coverage、状态机和呈现证明的情况下，拆成领域 Fragment + Core Atlas。未通过前不移动 Product Skill，也不创建 QA 空壳。
