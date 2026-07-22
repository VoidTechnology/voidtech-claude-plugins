# ADR-0004：PRD 源需求同步与需求身份

## 状态

已接受（设计方向，尚未实现）

## 日期

2026-07-17（2026-07-20 修订）

## 摘要

为既有 PRD 工作树新增 `prd-sync` 能力：外部需求源按数据源独立注册和版本化；需求身份由追加式 reconciliation journal 裁决，由可重建的 Requirement Ledger 归并；同步采用「Base revision / Incoming revision / Current Ledger」三方归并，而不是两方 revision 对比；需求生命周期分五态，只由用户裁决、经 `prd-maintain` 新增的工况 5 修改主本。面向人阅读的 Logic Atlas 读模型拆分至 ADR-0005。

## 背景

`prd-from-requirements` 把 Excel、访谈纪要或旧版 PRD 转成模块化 PRD 工作树。工作树同时保存模块主本、领域规格、追溯矩阵、开放问题、两级汇总 PRD 和状态看板。`prd-maintain` 负责后续深化、需求变更、开放问题定案和评审修订。

人工维护的原始 Excel 会持续变化。现有维护流程允许把一次变更存入 `_source/changes/`，但没有定义同一数据源反复导入时的稳定需求身份、语义差异、幂等行为、当前已应用版本和过期检测。如果直接用新版 Excel 重跑生成流程，工作树中已经形成的产品裁决、领域抽象、开放问题和人工深化结果可能被覆盖；如果完全依赖维护者描述变化，又容易漏掉删除、移动和隐式影响。

2026-07-20 的多维度审查确认了初版设计的四个缺口，本版按审查定案重写：

- 两方 revision 对比无法处理带外变更：经 `_source/changes/` 合入的需求随后出现在新版 Excel 中时，会被误判为新增并产生重复编号。
- 「行 → 需求编号」的映射是系统裁决，初版没有给它权威落点，Ledger 无法重建。
- 「删除」只有检测侧分类，没有合入语义；「未交付即撤回」与「已上线待下线」被混为一谈。
- 单源 `source-state.json` 无法支撑「Excel + 访谈纪要 + 邮件变更」的多数据源工作树。

初版第 5–13 节的 Logic Atlas 读模型与本主题耦合点很少，独立为 ADR-0005。

## 决策

### 1. 职责分层与完整链路

新增面向既有 PRD 工作树的 `prd-sync` 能力。职责边界：

- `prd-from-requirements`：从未建树的原始需求建立首个 PRD 工作树，并为初始编号分配写入裁决记录（`initial-import`）。
- `prd-sync`：导入某个数据源的新版本，计算差异，与当前需求账本归并，形成可审阅的变更集与候选项。
- `prd-maintain`：按已确认变更集修改模块主本和全局主本，执行统一收尾不变式。

`prd-sync` 不直接重跑首建流程，也不绕过 `prd-maintain` 的影响面确认、追溯更新、汇总重生成、机械自检、状态看板和变更记录规则。

分工的规范表述：

> Revision Diff 负责发现外部源发生了什么；Requirement Ledger 负责判断这是否是新需求；三方归并负责决定 PRD 应该怎么变。

多数据源下的完整链路：

> 每个源独立 revision diff → 更新该源 source occurrence → 全局 assertion 聚合 → 来源分歧或撤回候选 → 用户裁决 → `prd-maintain` 修改需求生命周期与主本 → 机械检查 → 生成物更新。

### 2. 数据源注册与不可变版本

`_source/` 目录结构：

```text
_source/
├── original/                        # 首建原件，永不覆盖
├── source-registry.json             # 数据源注册表
├── sync-state.json                  # 每个源的同步游标
├── revisions/
│   ├── requirements-xlsx/
│   │   └── <revision-id>/
│   │       ├── requirements.xlsx
│   │       ├── normalized.jsonl             # 规范化源记录（只保存观测，不保存裁决）
│   │       ├── normalization-manifest.json  # 规范化契约版本与 fingerprint 列清单
│   │       └── import-report.md
│   └── interview-20260701/
├── changes/
│   └── <change-id>/
│       └── manifest.json
└── reconciliation/
    ├── decisions/
    │   └── <seq>-<operation-id>.jsonl   # 已提交裁决事务 segment（追加式）
    └── operations/
        ├── <operation-id>.json          # 事务阶段清单（幂等恢复用）
        └── <operation-id>/
            ├── staging/                 # 本次暂存修改（发布前的唯一写入位置，不可变）
            └── backup/                  # 发布前既有目标的不可变快照（回滚用）
```

`source-registry.json` 保存稳定的数据源身份和默认策略：

```json
{
  "sources": [
    { "sourceId": "requirements-xlsx", "kind": "workbook", "mode": "versioned", "defaultAssertionRole": "normative" },
    { "sourceId": "interview-20260701", "kind": "interview-notes", "mode": "immutable", "defaultAssertionRole": "contextual" },
    { "sourceId": "email-changes", "kind": "change-stream", "mode": "append-only", "defaultAssertionRole": "normative" }
  ]
}
```

`sync-state.json` 为每个源维护三个不可合并的游标：

- `observedRevision`：已经见过的最新版本。
- `appliedRevision`：已完成归并裁决的版本，是下次同步的对比基线。
- `pendingRevision`：已导入但仍在等待确认的版本。pending 未处理时源又更新，下一次仍从 `appliedRevision` 对比最新 revision，不得把未确认版本当基线。

约束：

- `original/` 与既有 revision 不可覆盖；revision ID 始终带 sourceId 作用域，不存在全局 current revision。
- 幂等判重以 `normalized.jsonl` 的规范化记录哈希为准，xlsx 二进制哈希只做快速短路。另存不改内容不产生新 revision；相同规范化内容重复同步必须是 no-op。
- `sync-state.json` 是权威游标而非生成物，写入必须原子替换。
- 工作树外绝对路径只能作为导入便利信息，不能成为唯一权威来源。
- `_source/changes/` 登记为 append-only 的 change-stream 源，是无可比源文件时的降级入口（邮件、口头、会议结论）。change manifest 不拥有独立的映射真相，只引用 reconciliation decision，并维护状态：`pending`（已导入未合入）、`applied`（已合入 PRD，外部主源尚未收录）、`absorbed`（后续 revision 已含等价需求）、`superseded`（被后续变更替代）、`rejected`（确认不进入 PRD）。

### 3. 需求身份与 source occurrence

需求编号是跨版本追溯锚点，新增后永不重排、永不复用。行号只作为定位信息，不参与身份。

每条规范化记录携带两级标识——稳定匹配指纹与 revision 作用域 ID，两者语义不同，不得混用：

```json
{
  "sourceOccurrenceId": "requirements-xlsx@rev-c261ab57/occ-8f91.0",
  "recordKey": "sha256:8f91...",
  "duplicateOrdinal": 0,
  "locator": { "sheet": "membership", "row": 201 },
  "externalRequirementId": null,
  "normalizedText": "Support membership renewal reminders"
}
```

- `recordKey`：排除 revision、行号和展示顺序，仅由业务列规范化内容计算的稳定匹配指纹。插行、排序、移动 sheet 不改变 `recordKey`。
- `sourceOccurrenceId` = sourceId + revisionId + recordKey + duplicateOrdinal，只在单个 revision 内唯一；`locator` 只供人打开 Excel 定位，不参与身份。
- journal 映射的对象是 revision 作用域的 occurrence；跨 revision 的身份继承靠稳定外部 ID 或 `recordKey` 命中（`basis: exact-fingerprint`），不靠相同的 occurrence ID。
- 同一 revision 内 `recordKey` 重复的记录（复制粘贴出的等价行）以 `duplicateOrdinal` 消歧，且涉及它们的匹配一律降级为歧义项进确认报告，永不自动裁决——重复行本身通常是源数据质量问题，应当暴露。
- 原始 Excel 提供稳定需求 ID 列时优先使用（`externalRequirementId`）。

身份匹配优先级，从高到低：

1. Excel 自带稳定需求 ID。
2. change manifest 中显式登记的外部 ID 或别名。
3. 历史 fingerprint 精确命中。
4. 模块路径与规范化正文精确匹配。
5. 语义相似候选，必须人工确认。
6. 全部不匹配，才创建新编号。

语义相似度和语义等价判断都只能产生候选，不能独自决定身份；自动通道只留给规范化正文字节级相等。

规范化算法是版本化公共契约：业务列选择、Unicode 与空白折叠、日期与数字取值、公式结果、合并单元格回填、空行与尾部空白的处理规则随 `normalizedSchemaVersion` 定义。每个 revision 的 `normalization-manifest.json` 固化 `normalizedSchemaVersion`、`normalizerVersion`、source adapter 配置摘要和参与 fingerprint 的列清单及规范化策略。`normalizedSchemaVersion` 不同的两个 revision 不允许直接 diff：normalizer 升级后先对 `appliedRevision` 的原始文件用新规则重建基线（rebaseline operation，生成新旧 recordKey 对照并按等价继承既有映射），仅因规范化规则变化产生的差异归类为基线重建，不得呈现为业务变更——否则插件升级会把整份未变的 Excel 判成大规模变更。

### 4. 裁决 journal 与 Requirement Ledger

「source occurrence → 需求编号」的映射是 PRD 系统作出的身份裁决，可能发生在导入之后，也可能被人工纠正。它不写入 revision（revision 是不可变观测），唯一裁决主本是全局追加式 journal：`_source/reconciliation/decisions/`。

journal 以事务 segment 组织：每次确认事务把全部裁决写入临时 segment，fsync 后原子 rename 提交为 `<seq>-<operation-id>.jsonl`。Ledger 与机械检查只读取已提交 segment；进程中断残留的临时文件按崩溃恢复清理，不影响有效历史。已提交 segment 永不修改，纠错只追加新裁决。

一次确认事务涉及多个文件，无法一起原子写入，提交顺序固定为：journal segment 提交 → change manifest 更新 → PRD 主本修改（经 `prd-maintain`）→ 该源 `appliedRevision` 最后推进。中断后按 operation ID 幂等恢复：已完成步骤重放为 no-op；`appliedRevision` 未推进前，该 revision 保持 pending。

每个确认事务在 `_source/reconciliation/operations/<operation-id>.json` 维护阶段清单：candidate revision、关联 segment 文件、预期输入摘要、当前阶段、受影响文件与最终提交状态。恢复程序据此判断 change manifest 和 PRD 主本各自完成到哪一步并幂等续跑，不靠猜测文件状态。

提交点唯一：同步类事务的提交点是 `appliedRevision` 推进，operation 清单的最终状态随之写入，是观察记录而不是第二个提交点；非同步事务（如工况 5）没有 `appliedRevision`，提交点是 operation 清单最终状态的原子更新。任何事务只有一个提交点。

内容门在 operation 进行中执行，针对的是「预提交验证视图」而不是当前有效视图：当前有效输入 + 本 operation 已提交的裁决 segment + 本次暂存的 manifest、追溯矩阵与主本修改。全部检查通过后才推进提交点；失败时不推进，当前有效视图保持不变，fail closed 不被破坏——既不会因为「新矩阵配旧 journal」产生假不一致，也不会让坏状态先进入有效视图再发现。candidate overlay 只承载未确认候选，不兼任验证视图。

暂存与发布协议：operation 进行中的全部文件修改（change manifest、追溯矩阵、模块与全局主本）写入 `operations/<operation-id>/staging/`，按工作树相对路径镜像存放，不直接修改原路径。内容门通过后进入发布阶段：阶段清单标记 `publishing`，暂存文件逐个原子替换到原路径，随后推进提交点、写入最终状态并清理暂存。不追求跨文件真正原子提交，靠以下读取栅栏保证一致性。

未完成 operation 构成读取栅栏：存在 `publishing` 或发布冲突（`publish-conflict`）状态的阶段清单时，一切读取当前有效视图的命令（Ledger 重建、Atlas 构建、状态看板、机械自检）必须先完成恢复或拒绝读取，不得读取半发布状态。恢复是幂等的——暂存文件在最终状态写入前一直保留，重放逐文件替换即可。同步事务中提交点（`appliedRevision`）已推进而最终状态未写入时，恢复程序据提交点确定性补写最终状态，不需要人工判断。

`check-prd-tree.py` 支持 `--operation-id`：对「当前有效输入 + 该 operation 暂存修改」的预提交视图执行检查；不带参数时检查已发布工作树，且先验证读取栅栏。

journal 保存三类记录，共用同一提交纪律：

**身份映射**（`action: map / remap`）：

```json
{
  "decisionId": "MAP-20260717-001",
  "sourceOccurrenceId": "requirements-xlsx@rev-c261ab57/occ-8f91.0",
  "requirementId": "REQ-200",
  "action": "map",
  "assertionRole": "normative",
  "basis": "manual-confirmation",
  "confidence": "confirmed",
  "decidedAt": "2026-07-17T16:30:00+08:00",
  "decidedBy": "dodo",
  "supersedes": null
}
```

**lifecycle controller 指定**（`action: set-lifecycle-controller`）：控制权裁决的键是「requirementId × scopeId」，控制者 sourceId 是值；跨 revision 保持，不挂在单条 occurrence 映射上。机械检查保证同一「requirementId × scopeId」最多一个生效 controller。

**生命周期迁移**（`action: transition`）：字段至少包含 `transitionId`、`requirementId`、`from`、`to`、`action`、`effectiveAt`、`decisionSource`、`supersedes`。生命周期迁移历史以此为权威，追溯矩阵只保存当前投影（见第 7 节）。状态链起点：需求编号被有效身份裁决首次引入时，初始状态隐式为 `active`；以非 `active` 状态引入（如存量迁移中的历史需求）必须显式写 genesis transition（`from: null`）。迁移历史必须能从 journal 单独确定性重建，不依赖矩阵当前值。

规则：

- `basis` 枚举：`stable-external-id`、`change-manifest`、`exact-fingerprint`、`manual-confirmation`、`initial-import`（首建编号分配）、`migration-backfill`（存量工作树迁移合成）。
- `supersedes` 仅用于纠错：修正一条从未真实生效的错误记录（写错编号、映射错人），被修正记录不再生效，状态链重算。产品后来改变决定时追加普通记录，不 supersede 旧记录——例如取消下线的 `deprecated → active` 是新迁移，不 supersede 当初的 `active → deprecated`，否则历史会变成从未废弃过，而旧状态曾真实生效。有效记录取未被 supersede 的最新裁决；同一 occurrence（或同一控制权作用范围）出现两个有效裁决时机械检查直接失败，不能自行选择。
- 未变化行在每个新 revision 下的映射以 `basis: exact-fingerprint` 成批机器落档，与人工确认在同一事务中一并提交；`confidence` 区分机器裁决与人工确认，批量机器裁决不得呈现为人工确认。

`_generated/requirements-ledger.jsonl` 只从「当前有效输入集合」生成，由 `sync-state.json` 的 applied 游标显式选取，不扫描整个 `revisions/` 目录：

- 每个 versioned 源 `appliedRevision` 对应的 `normalized.jsonl`。
- 状态为已生效（`applied` / `absorbed`）的 change manifest。
- 已提交且所属 operation 已越过提交点的裁决 segment。operation 未越过提交点的裁决不进入当前视图，由预提交验证视图或恢复程序处理。
- `source-registry.json`、`sync-state.json` 的 applied 游标投影（不含 observed/pending 游标）与追溯矩阵。

pending revision、pending change 和未确认 proposal 不进入当前视图，属于独立的 candidate overlay（确认报告的输入），不参与 Atlas 的新鲜度判定——未确认内容不得提前进入读模型，观测到新版本也不得让 PRD 未变的 Atlas 无故过期。

Ledger 可删除、可重建，不是权威主本。它必须能回答「这条需求目前由哪些来源、以什么角色支撑，生命周期状态是什么，controller 是谁」。

各文件的权威边界：

| 文件 | 权威内容 |
|---|---|
| `revisions/*/normalized.jsonl` | 某次 revision 实际出现的源记录 |
| `changes/*/manifest.json` | 带外变更的来源、状态和关联裁决 |
| `reconciliation/decisions/` | 身份映射、lifecycle controller 指定与生命周期迁移历史 |
| `requirement-traceability-matrix.md` | 当前需求覆盖、模块归属、期次；生命周期列是 journal 的投影 |
| `_generated/requirements-ledger.jsonl` | 汇总后的当前机器索引（生成物） |

完备性检查：当前生效 revision 的每条 occurrence 都必须有生效裁决，否则本次同步不算完成；追溯矩阵的生命周期列必须与 journal 生效迁移的投影一致。这些是机械检查项，不是约定。

### 5. Assertion role 与 lifecycle controller

文件里提到某件事，不等于它能独立维持一条需求。每个 occurrence 映射到需求时在裁决中记录 assertion role：

| Role | 含义 | 能否阻止撤回候选 |
|---|---|---|
| `normative` | 独立提出或确认产品要求 | 能 |
| `corroborating` | 复述或佐证其他权威要求 | 不能单独维持 |
| `contextual` | 背景、动机、访谈意见 | 不能 |
| `overriding` | 后续裁决，覆盖较早口径 | 能，并按显式声明的范围优先 |

- 生命周期控制权由独立的 `set-lifecycle-controller` 裁决承载（第 4 节），键是「requirementId × scopeId」、值是控制者 sourceId，跨 revision 保持，不混入 role 枚举、不挂在单条 occurrence 映射上——「谁控制范围」与「说了什么性质的话」是两个维度。scopeId 是稳定标识（整条需求用保留值 `requirement`），lifecycle controller 必须显式指定，不能根据文件类型猜测。
- `source-registry.json` 的 `defaultAssertionRole` 只是导入默认建议，可在具体映射上覆盖。
- 不采用全局「Excel 高于访谈、访谈高于邮件」的文件类型优先级。邮件可能是最新产品裁决，访谈也可能只是背景；优先级必须落在具体需求、具体来源关系上。
- `overriding` 裁决必须显式引用它覆盖的对象（`overridesDecisionIds`，或需求编号加稳定 scopeId），不使用自由文本范围；无法机械判断作用范围的 overriding 不成立。

### 6. 三方归并同步流程

同步命令作用于一个 sourceId（`prd-sync --source requirements-xlsx --input requirements.xlsx`）。工作树只有一个 versioned 源时可省略并自动推断；存在多个可更新源时必须显式指定。

固定流程：

1. 计算候选输入的规范化哈希；与该源 `appliedRevision` 一致则 no-op 终止。
2. 创建该源作用域内的不可变 revision，转换并规范化全部有效需求记录。
3. Raw diff：对比该源 `appliedRevision` 与候选 revision 的规范化记录。
4. 三方归并：raw diff 结果逐条与全局 Requirement Ledger（含全部来源的需求集合）匹配，按第 3 节优先级判定身份。带外合入的需求被新 revision 命中时归类为「来源回填」，保留原编号、追加 occurrence、原 change 标记 `absorbed`，不生成新编号、不重复修改主本。
5. 变更分类：来源回填、内容增强、口径变更、来源冲突、拆分候选、新增、仅格式变化、无变化。字节级等价才走自动回填；「疑似语义等价」降为确认报告中的推荐项，其余匹配情形一律等待确认。
6. 通过追溯矩阵与 Ledger 反查影响面，向用户展示变更集、歧义项、候选项和拟修改文件；确认前不修改 PRD 主本，不改变任何需求生命周期状态。
7. 确认后写入裁决（人工确认与批量机器裁决同一事务落 journal），变更集交 `prd-maintain` 合入并执行统一收尾。

同步一个源不能改变其他源的 occurrence 状态。文件监听器、Git hook 或 CI 可以检测「源需求领先于 PRD」，但只能报警或阻断，不能自动修改产品主本。

某源中 occurrence 消失时，只把该 occurrence 标为 `absent`，然后按剩余有效 assertion 聚合判定。判定有固定优先级：先检查是否存在更新的有效 overriding 裁决，再判断消失源是否为 lifecycle controller，最后按剩余 assertion 分类：

| 情形（按优先级） | Sync 结果 |
|---|---|
| 存在更新的有效 overriding 裁决要求继续有效 | 不生成撤回候选；报告「主表未包含已确认带外变更」并列出 controller 移除等冲突事实，推动源回填 |
| 消失源是该需求的 lifecycle controller | 即使有其他支撑也生成候选，并列出冲突证据 |
| 仍有 normative 支撑 | 不生成撤回候选；报告「单源移除/来源分歧」 |
| 只剩 corroborating 或 contextual | 生成撤回候选 |
| 已无任何有效来源 | 生成高置信撤回候选 |

无论哪种情况，都不能自动改变需求状态。`sourceOccurrence.status = absent` 不得自动推出 `requirement.status = withdrawn`。

### 7. 需求生命周期

来源记录状态与产品需求状态是两套状态，必须分开：

- 来源记录状态（occurrence 级）：`present`、`absent`、`superseded`。
- 产品需求状态（需求级）：`active`（当前有效）、`withdrawn`（未交付即撤回）、`deprecated`（已交付，停止扩展或准备下线，行为仍存在）、`superseded`（被其他需求替代）、`removed`（兼容期结束，产品行为已移除）。

生命周期本身有状态机，合法迁移集合：

- `active → withdrawn / deprecated / superseded`
- `deprecated → removed / superseded / active`（取消废弃：下线计划在行为移除前撤销时恢复原需求，必须人工裁决）
- `withdrawn → active`（复活，`reactivate` 动作，必须人工裁决）

其余迁移一律非法。每次迁移在 journal 落一条 `transition` 记录（第 4 节），机械检查依据迁移历史验证合法性，而不是只看当前状态——只保存当前状态无法判断它是否经过合法路径到达。`removed` 与 `superseded` 不可复活：行为已移除或已被替代的能力回来，本质是新需求，立新编号并回链旧编号。已 `withdrawn` 的需求在后续 revision 中重新出现时，sync 按指纹命中旧编号并生成「复活候选」，等待人工 `reactivate` 裁决，机械检查不允许「occurrence present 且 requirement withdrawn」的矛盾态长期存在而无未决候选。

生命周期迁移历史的权威在裁决 journal；追溯矩阵保存当前投影供人阅读与评审（投影必须与 journal 一致，机械对账），原行永不删除（墓碑记录），新增或启用字段：

| 字段 | 含义 |
|---|---|
| 状态 | active、withdrawn、deprecated、superseded、removed |
| 生效日期/版本 | 生命周期变化何时生效 |
| 原因 | 商务、法规、产品调整或被替代 |
| 替代需求 | 对应新需求编号 |
| 决策来源 | change、会议纪要或确认记录；含「是否已上线」的回答及依据 |
| 影响状态 | 待清理、兼容中、已完成 |

「是否已上线」这一关键输入依赖人回答，工作树没有发布状态权威，因此回答连同依据必须写入决策来源列，供未来纠错。覆盖率统计分开报告「有效需求」和「历史需求」，撤回需求不得制造覆盖率上涨假象。

### 8. `prd-maintain` 工况 5：需求撤回、废弃、替代与移除

检测到「源记录消失」和确认「产品需求停用」是两件事；后者是 `prd-maintain` 的独立工况，不塞进普通需求变更。不使用笼统的「删除需求」——需求历史和编号永不物理删除。

用户确认时的输入裁决至少包含：目标需求编号；生命周期动作（撤回/废弃/替代/最终移除）；是否已实现或上线；生效版本或日期；是否存在替代需求；已有数据、接口、页面入口和用户是否需要迁移；整条失效还是部分撤回。无法确认是否上线时，不得按 `withdrawn` 处理，默认进入影响分析并要求确认——把已上线能力当未实现需求删掉是风险最大的操作。

合入流程：

1. **反向影响分析先行**：从追溯矩阵和逻辑模型反查模块功能清单、页面入口、跨系统流程与依赖、领域对象与状态机、字段、权限、功能开通矩阵、通知、埋点、验收标准、OQ、深化任务和其他需求引用；输出拟修改、保留和新增迁移项，确认前不改主本。
2. **先在 journal 落 `transition` 裁决，再更新追溯矩阵投影**（第 7 节字段），最后按动作修改模块主本。
3. 按生命周期动作执行对应剧本：

- `withdrawn`（未交付）：从本期功能清单、用户路径、权限、通知和验收标准移除规范性要求；模块第 13 节追溯保留编号并标「已撤回」；取消相关深化任务并记录原因；OQ 改「不再适用」不物理删除；变更记录写明原因和影响范围。
- `deprecated`（已交付、兼容期）：保留当前行为描述并明确标记；写出禁止新增进入的具体 gating 规则；补迁移对象、兼容期限、替代入口和回退规则；建立下线任务或 OQ——没有迁移方案不能进入 `removed`；Atlas 同时展示当前行为和目标状态。
- `superseded`：旧编号保留并链接新编号；新需求承接的功能、状态、验收标准必须明确；未被新需求覆盖的部分不能静默消失；机械检查验证替代编号存在且无替代循环。
- `removed`（兼容期结束）：删除主路径中的旧入口和旧操作；更新状态机、字段、权限、通知和依赖；保留历史追溯、废弃说明和变更记录；仍有历史数据时必须说明只读、归档、迁移或清理规则。API、数据库或客户端兼容属于后续实施范围，PRD 给出要求，`prd-maintain` 不修改代码。

部分撤回不得让编号含义漂移：REQ 含 A、B、C 只撤回 B 时，小范围口径收缩可修改原需求（变更记录保留前后语义）；B 可独立验收、独立排期或已有实现时，应拆分——旧需求 `superseded`，新增明确的替代需求。

工况 5 收尾新增机械检查：

- `withdrawn`、`removed` 需求不得出现在有效功能清单、主流程和有效验收标准中。
- `deprecated` 必须有兼容规则，且有替代需求、迁移任务或 OQ 之一。
- `superseded` 必须引用存在的替代需求，且无替代循环。
- 历史需求编号仍存在于追溯矩阵；被移除的状态或字段不存在活动需求引用。
- 取消的 backlog 条目保留原因；OQ 标「不再适用」而非删除。
- 有效需求覆盖率与历史需求数量分别统计。
- 生命周期迁移历史合法（依据 journal `transition` 记录），矩阵投影与 journal 一致；复活候选未裁决前矛盾态报警。

与 sync 的边界：`prd-sync` 只提出候选（如「Excel 中 REQ-200 的来源记录消失，疑似撤回」）；用户确认后产生明确维护指令（如「REQ-200 标记 withdrawn，未上线，无替代需求，2026-07-20 生效」）；随后由工况 5 修改主本。

### 9. 用户可见语言层

确认报告和最终回复使用产品语言（「这条需求 Excel 里删了，但 7 月 18 日的邮件确认过它继续有效」），不暴露 ledger、journal、occurrence、assertion、cursor 等内部词汇。用户不需要理解这些概念，除非进入审计和排障。变更分类标签（来源回填、内容增强等）在确认报告中作为推荐标签展示，帮助用户快速裁决。

## 备选方案

### Excel 更新后全量重建 PRD

实现最简单，但无法安全保留产品裁决、开放问题、独立核验记录和人工深化内容。拒绝作为更新路径；只保留为用户明确要求、旧树归档后的重建操作。

### 只扩展 `prd-maintain`，由用户描述变化

改动较少，也适合一次性补充需求，但无法证明用户列出的变化完整，不能可靠识别删除、移动和批量行号偏移。保留为没有可比较源文件时的降级入口（change-stream 源），不作为持续同步主路径。

### 两方 revision 对比 + 候选指纹（本 ADR 初版方案）

只比「旧 revision vs 新 revision」无法处理带外变更：经 `_source/changes/` 合入的需求随后进入 Excel 会被误判为新增，产生重复编号。拒绝；改为三方归并，以 Requirement Ledger 为新增判定基线。

### 映射写入 revision 目录（per-revision mapping.json）

把身份裁决和不可变观测混在一起：裁决可能晚于导入发生、也可能被人工纠正，纠错将被迫修改不可变目录。拒绝；采用全局追加式 reconciliation journal + supersedes 链。

### 全局来源优先级（Excel > 访谈 > 邮件）

邮件可能是最新产品裁决，访谈也可能只是背景，按文件类型定优先级必然误判。拒绝；优先级落在具体映射的 assertion role 与 lifecycle controller 上。

### 单一「已停用」状态

把「未交付即撤回」和「已上线待下线」混为一谈，而两者风险等级完全不同。拒绝；采用五态生命周期与独立工况。

### 把 PRD 全量迁移为数据库或专用 DSL

长期可获得更强查询和约束能力，但当前迁移成本、维护门槛和格式锁定风险高。暂不采用；先在现有 Markdown 主本之上建立规范化导入、追加式裁决和可重建索引。

## 影响

- 新增 `prd-sync` 公共命令前，需要按 ADR-0002 更新命名登记、使用指南和可移植性检查。
- `prd-maintain`：工况 2 接受 `prd-sync` 生成的已确认变更集；新增工况 5（需求撤回、废弃、替代与移除）；收尾不变式扩展（详见 ADR-0005 的内容门定义）。
- `prd-from-requirements`：首建分配编号时同步写入 journal（`initial-import`）。
- 追溯矩阵模板增加生命周期字段（状态、生效、原因、替代、决策来源、影响状态），不再默认把行号等同于需求 ID。
- Excel 转换脚本增加 `normalized.jsonl` 输出、occurrence 指纹计算与版本化的 `normalization-manifest.json`，不破坏现有 CSV/Markdown 降级产物；规范化规则成为公共契约，升级走基线重建而不是业务 diff。
- `check-prd-tree.py` 新增：journal 完备性（当前 revision 每条 occurrence 有生效裁决）、双有效裁决与双生效 controller fail closed、未提交临时 segment 的清理与拦截、依据 `transition` 历史的生命周期迁移合法性、矩阵生命周期投影对账、withdrawn/removed 出现在有效清单的拦截、superseded 无环；支持 `--operation-id` 预提交视图检查，默认模式先验证读取栅栏。
- `generate-dashboard.py`：有效需求与历史需求分桶统计，撤回不虚增覆盖率。
- 旧工作树一次性迁移必须先产出迁移 proposal 再经用户确认提交，不能全自动——存量矩阵多为区间级追溯而非 occurrence 级映射，且存在待人工确认行。区间级追溯呈现为显式缺口，不伪造行级映射；无法可靠匹配的历史需求必须要求用户确认。缺口清零前 revision 0 不成为 applied，工作树按能力开关继续以 legacy 模式维护（见技术设计）。
- 确认报告 UX 需要一层产品语言翻译，内部词汇只在审计与排障暴露。

## 分阶段落地

### 第一阶段：数据源注册与只读同步

- 建立 `source-registry.json`、`sync-state.json`（三游标）和按源作用域的不可变 revision。
- 生成规范化记录、occurrence 指纹和 raw diff 报告；验证规范化哈希 no-op。
- 存量迁移按「只读分析 → 迁移 proposal（可映射项、歧义项、区间级缺口）→ 用户确认 → 单一 operation 提交」执行：`_source/original/` 规范化为 revision 0，journal 合成（`initial-import` / `migration-backfill`）。proposal 可以带缺口，但只要还有 occurrence 未映射，revision 0 只能保持 pending，不得推进为 applied——完备性不变式不为迁移豁免，不引入「部分 applied」状态；用户补齐并确认全部身份映射后，迁移 operation 才提交。覆盖计数不等于身份确认。
- 只报告影响面，不修改 PRD。

### 第二阶段：受控增量合入（最小闭环）

- 三方归并的新增判定（防重复编号）、来源回填与 `absorbed` 状态。
- 分类先收敛为三桶：字节等价自动回填 / 有匹配一律确认 / 无匹配新增；六路细分类标签只作确认报告的推荐展示。
- 确认后的变更集交 `prd-maintain` 合入；批量机器裁决与人工确认同事务落 journal。
- 生命周期机械检查落防错最小集（withdrawn/removed 拦截、superseded 无环、历史行永存、覆盖率分列）。
- CI 可检测源需求领先，但不自动合入。

### 第三阶段：生命周期与多源完整能力

- 工况 5 四套剧本、部分撤回拆分规则与全部机械检查。
- Assertion role 细分类、来源冲突与 overriding 裁决、复活候选流程。
- 多可更新源并存的作用域同步与来源分歧报告。

## 验收原则

- 规范化内容一致的 Excel 连续同步两次，第二次是 no-op，不产生 revision、变更集或 PRD 修改；仅另存不改内容同样不产生 revision。
- 在 Excel 中插入或移动行，不导致无关需求批量变更编号。
- 经 `_source/changes/` 合入的需求随后出现在新版 Excel 中，不产生新编号，报告为来源回填，原 change 标记 `absorbed`。
- 新增、内容修改、移动、拆分或合并嫌疑、身份歧义、撤回候选能被分别报告；未确认的同步不修改模块或全局主本，不改变任何需求生命周期状态。
- 单源移除但存在 normative 支撑时不产生撤回候选；lifecycle controller 移除时即使有其他支撑也产生候选并列出冲突；全部来源消失也只产生高置信候选，不自动撤回。
- `withdrawn`、`removed` 需求不出现在有效功能清单、主流程和有效验收标准中；`superseded` 引用存在且无替代循环；历史编号永存于追溯矩阵；有效与历史覆盖率分列。
- 已 `withdrawn` 的需求在新 revision 中重新出现时产生复活候选，未经人工 `reactivate` 裁决不改状态。
- journal 出现双有效裁决或双生效 lifecycle controller 时机械检查失败；未提交的临时 segment 不被 Ledger 消费；当前生效 revision 存在无生效裁决的 occurrence 时同步不能宣告完成。
- 生命周期迁移合法性依据 journal `transition` 历史机械验证，矩阵投影与 journal 不一致时检查失败；`deprecated` 需求在行为移除前取消下线时恢复原编号（`deprecated → active`），不创建新需求。
- pending revision 与 pending change 不进入 Ledger 当前视图，不改变 Atlas 新鲜度判定；未确认内容不出现在读模型中。
- 在 journal 提交、change manifest 更新、主本修改、`appliedRevision` 推进四个提交边界分别注入中断，恢复后的最终状态与一次成功执行一致。
- 内容门在预提交验证视图上执行且失败时，提交点不推进，当前有效视图与上一次成功提交的状态逐字节一致。
- 发布阶段任意点中断后，读取命令要么先完成幂等恢复、要么拒绝读取，不存在读到半发布状态的路径。
- normalizer 升级后，对内容未变的源重新同步不产生业务变更集，差异全部归入基线重建；`normalizedSchemaVersion` 不同的 revision 之间不产生直接 diff。
- 存量迁移在用户确认 proposal 前不写入 journal；区间级追溯呈现为缺口，不出现伪造的行级映射；缺口未清零时 revision 0 保持 pending，完备性不变式不被豁免。
- 取消废弃后，「曾经 deprecated」的历史仍可从 journal 重建（后来的决定不篡改历史）；被纠错记录 supersede 的裁决不再生效且状态链重算。
- 面向用户的确认报告和最终回复不出现 ledger、journal、occurrence 等内部词汇。

## 明确不做

- 不监听文件后自动修改 PRD；任何情况下（包括全部来源消失）不自动改变需求生命周期状态。
- 不覆盖初始原件或历史 revision；不编辑 journal 历史，纠错只追加。
- 不因 Excel 排序或插行重排既有需求编号；编号永不复用；不物理删除需求行或 OQ。
- 不用全局文件类型优先级替代逐需求的 assertion 裁决。
- 语义等价或语义相似不走自动通道，只产生候选。
- 不在首期迁移到数据库或专用 PRD DSL。

## 关联文档

- `docs/decisions/0005-logic-atlas-read-model.md`（本 ADR 初版第 5–13 节拆分至此）
- `docs/decisions/0002-rename-core-skills.md`（公共命令命名与登记）
- `docs/decisions/0003-agent-first-review-and-decision-authority.md`（追加式 journal 与 proposal/decision 分离的模式先例）
- `plugins/voidtech-core/skills/prd-from-requirements/SKILL.md`
- `plugins/voidtech-core/skills/prd-maintain/SKILL.md`
- `plugins/voidtech-core/skills/prd-from-requirements/templates/requirement-traceability-matrix.md`

## 变更记录

| 日期 | 变更摘要 | 原因 |
|---|---|---|
| 2026-07-17 | 初版：revision 对比 + 候选指纹 + Logic Atlas 读模型 | 立项 |
| 2026-07-20 | 按多维度审查定案重写：数据源注册与三游标、occurrence 身份、三方归并与 reconciliation journal、Requirement Ledger、assertion role 与 lifecycle controller、需求生命周期五态与工况 5、用户语言层；Logic Atlas 拆分至 ADR-0005 | 审查确认初版存在带外变更基线污染、裁决无权威落点、删除无合入语义、单源状态模型四个缺口 |
| 2026-07-20 | 阻断问题修正：recordKey 与 revision 作用域 occurrence ID 语义拆分；journal 改事务 segment（临时写入 + fsync + 原子 rename）并定提交顺序与幂等恢复；lifecycle controller 改独立 `set-lifecycle-controller` 裁决；新增 `transition` 迁移历史、矩阵降为投影；撤回触发表定优先级并修正 role 措辞；补 `deprecated → active` | 二轮评审发现 occurrence 稳定性自相矛盾、JSONL 尾行不可追加修复、控制权与迁移历史无可重建落点 |
| 2026-07-21 | 三轮评审修正：定义 Ledger 当前有效输入集合（applied 游标选取，pending 进 candidate overlay）；`supersedes` 限定为纠错、后来决定追加不篡改历史、定状态链起点（隐式 active + 显式 genesis）；新增 operation 阶段清单与四提交边界中断验收 | 评审发现 pending 会污染当前视图、纠错与反向决策混淆、幂等恢复缺可观察状态 |
| 2026-07-21 | 四轮评审修正：新增预提交验证视图（内容门在提交点前针对暂存状态验证，失败时有效视图不变）；明确唯一提交点（同步类为 `appliedRevision` 推进，非同步类为 operation 清单最终状态原子更新） | 评审发现内容门在 operation 进行中要么撞假不一致、要么先提交后验证破坏 fail closed |
| 2026-07-21 | 五轮评审修正：定义暂存与发布协议（staging 目录、逐文件原子替换、读取栅栏、提交点补写、`--operation-id` 预提交检查）；规范化算法版本化为公共契约（`normalization-manifest.json`、rebaseline 规则）；存量迁移改为 proposal 确认流程，区间追溯保留为显式缺口 | 评审确认暂存发布协议、规范化契约与迁移确认三个工程契约缺失，示例工作树证明迁移不能全自动 |
| 2026-07-21 | 定稿修正（随准入冻结）：迁移完备性收严——缺口未清零时 revision 0 保持 pending、无「部分 applied」；并发控制、operation/proposal/worktree schema、发布恢复矩阵、确定性规则等实施契约集中到技术设计 | 准入审查判定 ADR 冻结、实现暂缓至技术设计覆盖全部 P1 |
| 2026-07-22 | 机械修正：controller 键统一为「requirementId × scopeId」（sourceId 为值）；overriding 引用稳定 scopeId；读取栅栏扩展到 `publish-conflict`；operations 目录补 `backup/` 快照 | 技术设计冻结评审发现 controller 主键两处与技术设计 §3.7 矛盾、发布冲突路径缺回滚落点 |
