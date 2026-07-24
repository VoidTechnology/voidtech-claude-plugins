# PRD 源同步与 Logic Atlas 技术设计

- **日期**：2026-07-21（2026-07-22 修订）
- **状态**：Final（2026-07-22 终审批准：ADR ACCEPTED/FROZEN、技术设计 APPROVED、实现 AUTHORIZED、剩余架构阻塞 0）
- **实施状态**：§12 五个阶段门全部通过（2026-07-23）——事务地基、迁移、只读同步、受控合入、Logic Atlas 均已落盘，§13 完整交付机械验收全部满足。门 2–4 由 voidtech-loop 驱动实现并经建议模式审查后人工 accept；门 5 worker 中断后由主会话打捞收尾。skill 层接线已交付（2026-07-23，voidtech-core 0.12.0）：`prd-sync` 公共技能与 CLI（13 个子命令，退出码 0/1/2/3/4 契约）、`prd-maintain` 工况 5 与能力分层收尾、`check-prd-tree.py` §9 改造（只读栅栏退出码 3、reconciliation 排除、`--operation-id` overlay、`markdown_validator` 拆分）、渲染器浏览器 CI（ADR-0005 §8：零依赖 CDP harness、七键验证证明、renderer-validation workflow）。Behavioral Atlas 同日深化至 generator 1.2.0 + viewer 4.0.0：场景选择器默认只展开一条业务流程，步骤卡内嵌经权威状态机验证的状态变化、可折叠异常和跨模块/外部依赖泳道；完整状态机与边界审计视图保留。Example「入会审批与缴费」试点已发布 3 步、3 条状态影响、12 条步骤级页面异常并完成真实浏览器验收。ADR-0004 第三阶段（overriding 完整流程、复活候选、多可更新源）为后续工作
- **摘要**：ADR-0004/0005 已冻结为架构决策。本文档一次性锁死全部实施契约——全局单写者与乐观并发（完整 base CAS）、八套权威机器文件 schema、暂存发布与恢复矩阵（含发布冲突的回滚闭环）、确定性序列化规则、迁移 gating 与能力开关、CLI 边界与模块拆分、按阶段设门的 fixture 测试计划与性能门。§13 是完整交付的机械验收清单；代码完成度由「实施状态」跟踪，不复用 Draft/Final。

## 1. 范围与关联

- 架构决策以 `docs/decisions/0004-prd-source-sync-and-requirement-identity.md` 与 `docs/decisions/0005-logic-atlas-read-model.md` 为准，本文档不重述其理由，只定义实现层契约。
- 两处表述冲突时以 ADR 为准并回报差异；本文档的 schema 是公共契约，变更需按 ADR-0002 口径管理版本。
- 并发与原子存储协议复用 voidtech-loop 的既有先例：`plugins/voidtech-loop/scripts/lib/runreviewlock.mjs`（mkdir 原子创建、双因子判活、tombstone 陈旧接管、owner 绑定 operation ID）与 `plugins/voidtech-loop/scripts/lib/statestore.mjs`（canonical JSON checksum、锁内 compare-and-write、tmp + fsync + rename 原子写）。voidtech-core 是 Python 标准库实现，复用的是**协议语义**而非代码。

## 2. 并发模型：全局单写者与乐观并发

### 2.1 writer lock

- 一棵 PRD 工作树同一时刻最多一个写 operation。proposal 生成是只读的，可以并行。
- 锁位于 `_source/reconciliation/writer.lock/`（目录锁，mkdir 原子创建）。持锁区间：从创建裁决 segment 开始，到发布完成（最终状态写入）为止。
- `meta.json` 记录 owner：pid、pid 启动时间、进程名（双因子判活，排除 PID 复用）、operationId、获取时间。
- 陈旧锁接管：判活失败才允许接管；接管者从 meta 中带回原 operationId，**必须恢复原 operation**（按 §5 恢复矩阵），禁止在未恢复前新建另一个 operation。接管留 tombstone 记录。
- 锁元数据缺失或损坏时，扫描全部非终态 operation manifest：0 个 → 清锁；恰 1 个 → 恢复该 operation；≥2 个 → fail closed 并要求人工介入——单写者不变式已被破坏，程序不得自行挑选。

### 2.2 完整 base CAS

operation 创建时记录 `operationBaseDigest`，它必须覆盖**完整读取集**，不能只是 Ledger 输入摘要：

```text
operationBaseDigest = H(
  authoritativeSourceDigest,   // 权威主本（ADR-0005 §6）
  ledgerSourceDigest,          // Ledger 当前有效输入（ADR-0004 §4）
  worktreeCapabilityDigest,    // prd-worktree.json 的 canonical bytes 哈希
  effectiveSchemaDigest        // 全部权威 schema 版本集合的 canonical 哈希
)
```

- proposal 与引用它的 operation 绑定**同一个** `operationBaseDigest`。
- 进入 `publishing` 前重算：不一致 → phase 置 `conflict`，禁止覆盖发布；唯一出路是基于新基线重新提案。带外修改任何模块主本都会改变 `authoritativeSourceDigest`，从而被拦截——CAS 不通过时绝不发布由旧主本生成的 Atlas。
- `files[].oldDigest` 继续承担逐目标 CAS（§4）；两层缺一不可。
- `sync-state.json` 等权威状态文件的更新走「读取 checksum → 锁内 compare-and-write」，语义同 `statestore.mjs` 的 `updateStateIfChecksum`。

## 3. Schema 契约

### 3.0 冻结范围与统一约束

冻结的权威机器文件共八套，实现第一步落盘为 `plugins/voidtech-core/skills/prd-from-requirements/schemas/*.schema.json`，每套配可通过的正例与必须拒绝的反例：

`prd-worktree`、`source-registry`、`sync-state`、`revision-manifest`、`normalization-manifest`、`proposal`、`operation`、`journal-record`。

统一约束：

- 全部 schema `additionalProperties: false`；discriminated union 按 kind 列逐项必填字段，未知 kind 拒绝。
- 所有路径字段以 PRD 工作树根为基准、`/` 分隔（如 `_source/reconciliation/...`、`00-global/...`）；拒绝 `..`、绝对路径。
- `stagedPath` 与 `backupPath` 不是自由值：必须逐字节等于由 `operationId` 与 `path` 推导出的唯一位置（`_source/reconciliation/operations/<operationId>/staging/<path>` 与 `.../backup/<path>`），校验器重算比对。
- `files[]` 的 digest 语义按动作定死：改写（`action: write`，目标已存在）`oldDigest` = 现有内容哈希、`backupPath` 必填；新建（`action: write`，目标不存在）`oldDigest` = null、`backupPath` = null；删除（`action: delete`）`newDigest` = null、`stagedPath` = null、`backupPath` 必填。发布或恢复时目标缺失：`oldDigest` = null 视为未发布正常路径；`oldDigest` 非 null 视为第三方删除 → `publish-conflict`。
- `proposalDigest` 的覆盖集 = canonical(确认载荷 [`candidateRevision`、`mappings`、`ambiguities`、`lifecycleActions`、`affectedFiles`] + `operationBaseDigest` + `schemaVersion` + `generatorVersion`)；**排除 `proposalDigest` 自身与可变的 `status`**——包含自身会自引用，包含 status 会在确认时改变摘要。

### 3.1 `prd-worktree.json`（根级机器清单）

```json
{
  "worktreeSchemaVersion": 1,
  "capabilities": { "sourceSync": false, "logicAtlas": false },
  "logicAtlasStage": null,
  "schemaVersions": {
    "operation": 1, "proposal": 1, "journal": 1,
    "normalization": 1, "logicModel": null
  }
}
```

- 能力开关是唯一权威，**不得用目录是否存在推断迁移完成**。canonical bytes 哈希即 `worktreeCapabilityDigest`，参与 §2.2 base CAS。
- 无此文件的工作树是 legacy：执行 legacy 内容门（现有 `check-prd-tree.py` + 汇总重生成 + 看板），不触发任何新检查。
- 迁移 operation 提交后一次性置位 `capabilities.sourceSync`；`logicAtlas` 与 `logicAtlasStage`（`markdown` / `html` / `polish`）随 ADR-0005 各阶段交付置位，内容门按 stage 裁剪。

### 3.2 operation manifest（持久化权威记录）

`_source/reconciliation/operations/<operation-id>.json`。它不是恢复辅助文件：非同步事务是否提交完全由它的最终状态决定，因此是权威记录，**永久保留，终态后只归档 staging/backup**。

```json
{
  "operationId": "op-20260721-001",
  "operationKind": "sync",
  "phase": "prepared",
  "commitPoint": "appliedRevision",
  "operationBaseDigest": "sha256:...",
  "proposalId": "prop-20260721-001",
  "proposalDigest": "sha256:...",
  "segmentPath": "_source/reconciliation/decisions/000123-op-20260721-001.jsonl",
  "targetSource": "requirements-xlsx",
  "targetRevision": "rev-20260721-a81f",
  "files": [
    {
      "path": "00-global/requirement-traceability-matrix.md",
      "action": "write",
      "oldDigest": "sha256:...",
      "newDigest": "sha256:...",
      "stagedPath": "_source/reconciliation/operations/op-20260721-001/staging/00-global/requirement-traceability-matrix.md",
      "backupPath": "_source/reconciliation/operations/op-20260721-001/backup/00-global/requirement-traceability-matrix.md"
    }
  ],
  "toolVersions": { "normalizer": "1.0.0", "generator": "1.0.0" },
  "schemaVersion": 1
}
```

- `operationKind`：`sync` | `maintain` | `migration` | `rebaseline`。逐 kind 必填：`sync`/`migration`/`rebaseline` 必填 `targetSource` 与 `targetRevision`；`maintain` 两者必须为 null。
- `phase`：`prepared` → `validated` → `publishing` → `committed`；失败分支 `aborted`（校验失败，其 segment 永不进入有效视图）、`publish-conflict`（发布途中目标 digest 未知，见 §4，**仍构成读取栅栏**）、`conflict`（基线失效或用户选择保留第三方修改）。
- `commitPoint`：`appliedRevision`（同步类）或 `operationState`（非同步类，phase 原子翻转为 `committed` 即提交）。同步类的 `phase: committed` 是提交点之后的观察补写。
- journal projector 按 operation phase 过滤 segment：只有所属 operation 已越过提交点的 segment 参与有效视图投影。

### 3.3 proposal（`_source/reconciliation/proposals/<proposal-id>.json`）

candidate overlay 的机器落点。用户确认的必须可证明就是提交的：

```json
{
  "proposalId": "prop-20260721-001",
  "proposalKind": "sync",
  "status": "open",
  "operationBaseDigest": "sha256:...",
  "candidateRevision": "rev-20260721-a81f",
  "mappings": [],
  "ambiguities": [],
  "lifecycleActions": [],
  "affectedFiles": [],
  "proposalDigest": "sha256:...",
  "generatorVersion": "1.0.0",
  "schemaVersion": 1
}
```

- `status`：`open` | `confirmed` | `expired` | `superseded`（可变字段，不参与 `proposalDigest`，见 §3.0）。
- operation 必须引用 `proposalId` + `proposalDigest`。进入 publishing 前若 `operationBaseDigest` 与实时重算不符，或 proposal 载荷摘要不匹配 → proposal 置 `expired`、operation 置 `conflict`，重新提案，不复用旧确认。
- 未来生效的生命周期决定保存为 `open` proposal，到期由人显式确认提交，不自动触发（§7.3）。

### 3.4 `revision-manifest.json`（每 revision）

```json
{
  "revisionId": "rev-20260721-a81f",
  "sourceId": "requirements-xlsx",
  "originalFileName": "requirements.xlsx",
  "originalContentDigest": "sha256:...",
  "normalizedDigest": "sha256:...",
  "recordCount": 563,
  "importedAt": "2026-07-21T10:00:00+08:00",
  "schemaVersion": 1
}
```

### 3.5 `normalization-manifest.json`（每 revision）

```json
{
  "normalizedSchemaVersion": 1,
  "normalizerVersion": "1.0.0",
  "adapterConfigDigest": "sha256:...",
  "fingerprintColumns": ["module", "requirement-text"],
  "strategy": { "unicode": "NFC", "whitespace": "collapse", "dates": "iso-from-serial", "formulas": "computed-value", "mergedCells": "backfill", "trailingEmpty": "strip" },
  "effectiveNormalizationDigest": "sha256:...",
  "schemaVersion": 1
}
```

- `effectiveNormalizationDigest` = canonical hash（normalizedSchemaVersion + adapterConfigDigest + fingerprintColumns + strategy）。
- **rebaseline 触发条件是 `effectiveNormalizationDigest` 变化**，不只是 schema version：adapter 配置、fingerprint 列或规范化策略任一变化都必须 rebaseline。
- `normalizerVersion` 允许单独升级，仅当输出逐字节兼容且有 fixture 证明；输出不兼容必须升级 `normalizedSchemaVersion`。

### 3.6 `source-registry.json` 与 `sync-state.json`

```json
{
  "sources": [
    { "sourceId": "requirements-xlsx", "kind": "workbook", "mode": "versioned",
      "defaultAssertionRole": "normative", "status": "active" }
  ],
  "schemaVersion": 1
}
```

```json
{
  "sources": {
    "requirements-xlsx": { "observedRevision": "rev-...", "appliedRevision": "rev-...", "pendingRevision": null },
    "email-changes": { "lastAppliedChangeId": "CHG-20260718-003" }
  },
  "schemaVersion": 1
}
```

- `status`：`active` | `retired`。sourceId 永不删除、永不复用；退休走 proposal 确认流程，退休源的历史 occurrence 与裁决全部保留。
- **retired 的语义只有一条：不再接受新 revision。**该源最后一次 applied 的 assertion 默认继续有效、继续参与聚合。若业务含义是「该来源不再支撑需求」，必须通过独立 proposal 批量失效其 assertion 并重新聚合撤回候选——不允许借 registry 状态静默改变需求生命周期。
- change 来源的支撑语义拆成两个字段：`retainedForAudit`（恒真，历史来源永远保留）与 `sustainsRequirement`（当前是否构成维持需求的有效 assertion）。change 被 revision 吸收（`absorbed`）时 `sustainsRequirement` 置 false，支撑转移到吸收它的 occurrence——避免 Excel 后续删除该需求时被一封旧邮件永久阻止撤回候选。

### 3.7 lifecycle controller 与 scopeId

- controller 的键是 `requirementId × scopeId`，**sourceId 是控制者的值**，不进键（ADR-0004 已统一为此口径）。
- `scopeId` 是稳定标识：整条需求用保留值 `requirement`；部分作用范围必须先在需求内定义稳定 scopeId（如验收条目编号），`overriding` 裁决与部分撤回一律引用 scopeId，不用自由文本。
- 机械检查：同一 `requirementId × scopeId` 最多一个生效 controller 裁决。

### 3.8 journal-record（discriminated union）与总序

按 `action` 分三类，逐类必填（通用必填：`decisionId`、`decidedAt`、`decidedBy`、`schemaVersion`；`supersedes` 各类可选，仅用于纠错）：

- `map` / `remap`：`sourceOccurrenceId`、`requirementId`、`assertionRole`、`basis`、`confidence`。
- `set-lifecycle-controller`：`requirementId`、`scopeId`、`controllerSourceId`。
- `transition`：`transitionId`、`requirementId`、`from`、`to`、`lifecycleAction`、`effectiveAt`、`decisionSource`。

总序规则：segment 文件名 `<segmentSeq>-<operation-id>.jsonl`，`segmentSeq` 为零填充数值，由持锁者递增分配；**总序 = 按数值 `segmentSeq` 升序，段内按记录出现顺序**。「最新裁决」「supersedes 链」全部依据总序判定，不依赖文件名字典序、不依赖 `decidedAt`。

## 4. 暂存发布协议

- staging 与 backup payload 一经写入不可变，operation 终态前不清理（`publish-conflict` 时同样保留）。
- 单文件发布固定五步：既有目标先复制为不可变快照到 `backupPath`（delete 动作同样先备份）→ 从 staging **复制**到目标同目录临时文件 → fsync → rename 替换 → 记录进度。**绝不把 staging 文件直接 rename 走**——否则「暂存保留、恢复可重放」不成立。
- 发布前与恢复时，对 `files[]` 每个条目按**固定顺序**判定目标当前状态：
  - 等于 `newDigest` → 已发布，跳过（幂等）；
  - 等于 `oldDigest`（含 §3.0 的新建/缺失语义）→ 尚未发布，执行发布；
  - 两者都不是 → 目标被第三方修改，operation 置 **`publish-conflict`**：读取栅栏保持、staging 与 backup 不清理，等待用户在两种恢复中二选一——
    - **确认覆盖第三方修改**：继续发布剩余文件；
    - **保留第三方修改**：逆序回滚本 operation 已发布的文件——新建动作删除目标，改写与删除动作从 backup 恢复——然后 operation 置 `conflict`，转重新提案。
  - 任何情况下不盲目覆盖，也不在栅栏解除前把「A 新、B 旧」的半发布状态暴露给读取方。
- 路径安全：`sourceId`、`operationId` 限字符集 `[a-z0-9-]`；`files[].path` 必须是工作树相对路径，拒绝 `..`、绝对路径；发布前对目标做 realpath 校验，symlink 解析越出工作树即拒绝。

## 5. 恢复矩阵

崩溃或陈旧锁接管后，按 operation `phase` 执行：

| phase | 恢复动作 |
|---|---|
| `prepared`（segment 未提交） | 清理临时 segment 与 staging，置 `aborted` |
| `prepared`（proposal 已确认且 segment 已提交） | 重算 `operationBaseDigest`：一致 → 续跑验证；不一致 → 置 `conflict`（segment 未越过提交点，天然不生效） |
| `validated` | 重算 `operationBaseDigest`：一致 → 进入 `publishing` 续发；不一致 → 置 `conflict` |
| `publishing`（无目标冲突） | 逐文件按 §4 digest 三态续发；全部完成后推进提交点 |
| `publishing`（发现未知 digest） | 置 `publish-conflict`，栅栏保持，等待用户二选一 |
| `publish-conflict` | 覆盖 → 继续发布；保留 → 逆序回滚已发布文件（新建删除目标、改写与删除从 backup 恢复）后置 `conflict` |
| 提交点已过、`committed` 未写 | 据提交点（`appliedRevision` 已推进 / operationState 待翻转）确定性补写最终状态，无人工判断 |
| `aborted` / `conflict` | staging/backup 归档，manifest 永久保留；`conflict` 转重新提案 |

- 读取栅栏（ADR-0004）：存在 `publishing` 或 `publish-conflict` 状态的 manifest 时，一切读取有效视图的命令先恢复或拒绝读取。
- 验收要求：四个提交边界、`publishing` 中每个文件边界、以及 `publish-conflict` 的两种恢复选择，注入中断后最终状态与对应的一次成功执行逐字节一致。

## 6. 内容门 overlay 执行模型

对齐 ADR-0005 §10 定稿：

- 步骤 1 是「暂存主本修改」；步骤 2–9 全部经 **overlay resolver** 读取「当前有效视图 + 本 operation staging」的合成视图。
- 机械自检用 `check-prd-tree.py --operation-id <id>` 检查暂存内容（步骤 3）。
- 两级汇总、`requirements-ledger.jsonl`、`logic-model.json`、`logic-atlas.md`/`.html`、`manifest.json`、`validation-report.md`、状态看板全部生成到 staging，并列入 operation `files[]`，与主本一起发布；全部文件发布完成后才推进唯一提交点。
- 由此排除两个错误形态：「新主本通过旧树检查」（部分步骤读原路径）与「主本已提交、Atlas 仍是旧版本」（生成物不在发布清单）。

## 7. 确定性规则

### 7.1 canonical 序列化与摘要

- 相对路径统一 `/` 分隔。
- JSON 一律 canonical serialization：键排序、UTF-8、无多余空白、LF；checksum/digest 的输入是 canonical bytes（同 `statestore.mjs` 的 `canonicalJson` 语义）。
- JSONL：固定字段序（按 schema 声明序）、UTF-8、LF、记录顺序即语义顺序。
- `sync-state.json` 的 applied 游标投影参与摘要时按同一规则序列化（只含 sourceId → appliedRevision 的排序映射）。

### 7.2 journal 投影

- 有效记录 = 总序（§3.8）下未被 supersede 的最新记录，且所属 operation 已越过提交点。
- 生命周期当前状态 = 从隐式 `active`（或显式 genesis）沿有效 `transition` 链重放；重放结果与追溯矩阵投影逐项对账。

### 7.3 `effectiveAt`

- 首期 `effectiveAt` 只是审计字段：**状态在 operation 提交时生效**，不随时钟变化。
- 未来日期的决定保存为 proposal（§3.3），届时人工确认提交 transition。理由：若状态随时钟翻转而输入摘要不变，Atlas 会在日期边界后错误地保持「新鲜」。

## 8. 迁移与 rebaseline

### 8.1 存量迁移

- 流程：只读分析 → 迁移 proposal（自动候选映射、歧义项、区间级缺口）→ 用户确认 → 单一 migration operation 提交。
- gating（ADR-0004 定稿）：缺口未清零 → revision 0 保持 pending，不推进 applied；无「部分 applied」。覆盖计数不等于身份确认——Example 工作树矩阵同时写「563 已映射」与「4 条待确认」，迁移器必须把后者呈现为待确认项。
- 迁移完成前工作树按 legacy 内容门维护；migration operation 提交后一次性置位 `capabilities.sourceSync`。
- 验收样例：对 `Example-prd-from-requirements` 跑 migration dry-run，应产出 559 条自动序号映射候选与 4 条人工确认项（输入合计 563），缺口清单可复现。

### 8.2 rebaseline

1. 检测到 `effectiveNormalizationDigest` 变化时，拒绝直接 diff，进入 rebaseline operation。
2. 从旧 `appliedRevision` 的**同一原始文件**生成新的不可变 baseline revision（revision 永不覆盖），写入新 `normalization-manifest.json`。
3. 生成新旧 recordKey crosswalk：同一原始文件内优先用稳定外部 ID 与原始 locator 对齐；一对多、多对一或记录边界变化必须人工确认。
4. 为全部新 occurrence 写映射 segment，新增 `basis: normalization-rebaseline`。
5. rebaseline operation 提交后把 `appliedRevision` 推进到新 baseline，然后才允许导入真正的新版 Excel。
6. 验收：内容未变的源在 rebaseline 后重新同步，业务变更集为零。

## 9. CLI 与模块边界

- `check-prd-tree.py` 默认**严格只读**：发现 `publishing` / `publish-conflict` 返回专用退出码（约定 `3`），报告 stale 或栅栏状态，**不自行恢复、不写任何文件**。恢复由显式 `prd-sync --recover`（或控制器内部 recovery 入口）执行。
- 默认扫描排除 `_source/reconciliation/`（含 operations staging/backup）；`--operation-id` 模式经 overlay resolver 读取合成视图，同一逻辑文件只出现一次——现有 `root.rglob("*.md")` 式全树扫描会把原文件和 staging 镜像重复计入，必须改造。
- 模块拆分（不再往单文件正则脚本堆结构化检查）：
  - `canonical_store`：canonical 序列化、digest、原子写、checksum 读。
  - `effective_view`：registry/sync-state/journal → 当前有效输入集合与 overlay resolver。
  - `journal_projector`：总序、supersedes、生命周期重放、双有效裁决/双 controller 检测。
  - `markdown_validator`：现有正则类检查的归置地，消费 resolver 提供的文件集。
- 全部实现使用 Python 标准库，满足插件自包含与可移植性约束。

## 10. Atlas 实施项

- **过期与写入者语义**（对齐 ADR-0005 定稿）：operation 校验失败时旧 Atlas 仍对应上一次有效视图，不算过期、不写任何文件；HTML 顶部永远自述生成快照（`authoritativeSourceDigest` 短哈希与生成时间），不静态宣称「当前最新」；带外修改导致摘要过期时，只读检查器返回失败并报告 stale；替换入口的失败/过期页由显式写入 operation 产生（maintain 或 recovery 的发布清单一部分），`check-prd-tree.py` 永不写文件。
- 渲染器验证证明的继承键：`rendererVersion`、`generatorVersion`、`schemaVersion`、`assetDigest`、`fixtureDigest`、`validationHarnessVersion`、`browserMatrixVersion` 全部未变才继承；fixture 或验证 harness 更新使旧证明失效。

## 11. 测试计划

harness 契约：Python 标准库 `unittest`；测试目录 `plugins/voidtech-core/skills/prd-from-requirements/tests/`；统一命令 `python3 -m unittest discover plugins/voidtech-core/skills/prd-from-requirements/tests`；该命令接入 `scripts/check-portability.sh`，随仓库校验执行。

fixture 按实施阶段设门：每个阶段只需通过**本门** fixture 即可进入下一阶段（消除「先全绿再实现」的循环依赖）；完整交付要求全部门绿。

| 门 | fixture | 断言 |
|---|---|---|
| 门 1 事务地基 | schema 反例 | 八套 schema 各自的非法输入（多余字段、缺 kind 必填、非法路径、非法 kind 组合）全部拒绝 |
| 门 1 事务地基 | 双写竞争 | 第二个会话获取锁失败或 base CAS 失败进入 `conflict`，先发布者不被覆盖 |
| 门 1 事务地基 | 提交边界崩溃 ×4 + publishing 逐文件崩溃 | 恢复后与一次成功执行逐字节一致 |
| 门 1 事务地基 | 部分发布后 digest 冲突 | `publish-conflict` 栅栏保持；覆盖与回滚两种恢复各自终态正确，读取方全程看不到半发布 |
| 门 1 事务地基 | 带外修改模块主本 | `operationBaseDigest` CAS 拦截，不发布由旧主本生成的 Atlas |
| 门 1 事务地基 | 双提交点 | 同步类以 `appliedRevision`、非同步类以 operationState 提交，各自崩溃恢复正确 |
| 门 1 事务地基 | 文件动作全集 | 新建/改写/删除/目标缺失四种情形的 digest、null 与回滚语义正确 |
| 门 1 事务地基 | 路径穿越（`..`、绝对路径、symlink 越界） | 创建 operation 或发布时拒绝 |
| 门 1 事务地基 | proposal 过期与载荷篡改 | 基线变化 → `expired` + 重新提案；`proposalDigest` 不匹配拒绝提交 |
| 门 1 事务地基 | 锁异常 | meta 缺失、损坏、PID 复用：非终态 operation 0/1/≥2 个分别清锁/恢复/fail closed |
| 门 1 事务地基 | journal 总序 | 乱序文件名/时间戳下投影结果稳定 |
| 门 2 迁移 | 迁移缺口 | 4 条未确认 → revision 0 不 applied，能力开关不置位 |
| 门 2 迁移 | Example dry-run | 稳定得到 559 条自动候选 + 4 条人工项（输入合计 563），缺口清单可复现 |
| 门 3 只读同步 | rebaseline | 契约摘要变化触发；内容未变的源零业务变更集 |
| 门 4 受控合入 | absorbed change | Excel 再删除该需求时产生撤回候选，不被旧邮件阻止 |
| 门 4 受控合入 | retired source | 最后 applied assertion 默认仍有效；批量失效 proposal 提交后才产生撤回候选 |
| 门 4 受控合入 | 未来 `effectiveAt` | 当前状态不变，proposal 待确认；日期跨界不改变摘要与新鲜度 |
| 门 5 Atlas | 能力阶段 | legacy / markdown / html / polish 四种阶段的内容门各自裁剪正确 |
| 门 5 Atlas | Atlas stale 与证明继承 | 带外修改报 stale 且检查器零写入；继承键任一变化不继承 |
| 门 5 Atlas | 性能基准 | 固定 Example fixture：冷启动 + 固定重复次数下 Atlas 编译渲染 < 5s，记录峰值内存并设阈值 |

## 12. 实施顺序（每阶段过本门后进入下一阶段）

1. **事务地基**：落盘 §3 全部八套 `schemas/*.schema.json`（含正例与反例），实现 `canonical_store`、原子状态存储、writer lock、完整 base CAS、overlay resolver 与恢复矩阵；harness 接入 `scripts/check-portability.sh` → **过门 1（11 组）**。
2. **迁移**：实现迁移分析器与 proposal 流程，用 Example 工作树跑 migration dry-run → **过门 2（2 组）**。
3. **只读同步**：registry、revision、normalized、raw diff、no-op 与 rebaseline → **过门 3（1 组）**。
4. **受控合入**：三方归并、proposal 确认、工况对接、生命周期 → **过门 4（3 组）**。
5. **Logic Atlas**：Markdown 内容门 → HTML 与渲染器 CI → 受限自然化 → **过门 5（3 组）**。
6. **完整交付宣告**：以 §13 全部条目通过为前提。

## 13. 完整交付的机械验收

> 「转 Final」验收中的第 1、7 条（口径全文唯一、`git diff --check` 与可移植性检查）已于 2026-07-22 验证通过，Final 状态由同日终审授予。以下条目是**完整交付宣告**的前提，随 §12 各阶段门逐步满足：

1. 八套权威 JSON Schema 能实际校验各自的正例并拒绝反例。
2. publishing 冲突 fixture 证明读取方在任何时序下看不到半发布工作树。
3. 完整 base CAS fixture 证明带外 PRD 修改被拦截。
4. §11 全部 19 组 fixture 绿（五个门全部通过）。
5. Example migration dry-run 稳定得到 559 + 4。
6. 性能门（Atlas 编译渲染 < 5s、峰值内存阈值）通过。
7. `git diff --check` 与 `bash scripts/check-portability.sh` 通过。

## 关联文档

- `docs/decisions/0004-prd-source-sync-and-requirement-identity.md`
- `docs/decisions/0005-logic-atlas-read-model.md`
- `plugins/voidtech-loop/scripts/lib/runreviewlock.mjs`（锁协议先例）
- `plugins/voidtech-loop/scripts/lib/statestore.mjs`（原子存储与 CAS 先例）
- `plugins/voidtech-core/skills/prd-from-requirements/scripts/check-prd-tree.py`（已按 §9 拆分改造：正则类检查迁入 `prdsync/markdown_validator.py`）

## 变更记录

| 日期 | 变更摘要 | 原因 |
|---|---|---|
| 2026-07-21 | 初版：按准入审查清单集中锁死并发、schema、发布恢复、确定性、迁移、CLI 与测试契约 | ADR-0004/0005 冻结后的实施前置条件 |
| 2026-07-22 | 冻结前修正：base CAS 定义为四分量 `operationBaseDigest`；schema 冻结范围扩为八套并加统一约束（additionalProperties、digest/null 语义、stagedPath 推导、proposalDigest 覆盖集）；发布协议补 backup 快照与 `publish-conflict` 回滚闭环；恢复矩阵补 prepared 双分支与锁元数据异常规则；retired source 语义定死；Atlas 过期写入者与证明继承键收口；fixture 扩至 19 组并锁定 unittest harness 与性能门；新增 §13 机械验收清单 | 冻结评审发现 6 个 P1 契约冲突与 3 个 P2 完备性缺口 |
| 2026-07-22 | 终审修正并转 Final：fixture 按五个阶段门分组、§12 每阶段过本门（消除全绿循环依赖）；digest 判定统一为「先 new 后 old、否则冲突」，回滚按动作区分（新建删目标、其余从 backup 恢复）；新增「实施状态」字段跟踪代码完成度；§13 改为完整交付验收 | 终审批准实施，要求三项确定性修正 |
| 2026-07-23 | 合入前独立评审修正批次（四路 /review 评审，5 个复现级缺陷 + 加固）：三方归并自动通道改为「唯一 recordKey 字节等价」，空正文/重复行一律降级歧义（防身份静默归并）；根目录 logic-atlas.html 排除出权威主本摘要（防发布自我失效）；页面契约多行动作按页面合并、「读写」行双边、边去重；segment 判空改字节级（防损坏 segment 崩溃摘要计算）；atlas.publish 锁内单次编译（消 TOCTOU），operation ID 随 base digest（manifest 永久保留）；manifest 尾发布并携带生成物摘要，新鲜度检查接读取栅栏与生成物对账；证明继承要求七键齐备非空；路径契约补 Windows 盘符拒绝、DEL/bidi 控制符排除、NFC 归一、合并区域防爆界、恢复路径复验 manifest；表头识别要求 ≥2 逻辑列 | /review 四路评审（testing/maintainability/security/对抗）发现 5 个复现级缺陷与 10+ 加固点，全部修复并以 15 组回归钉锁定 |
| 2026-07-23 | 实施期契约修正（真实 Example 验收数据暴露，随门 5 交付）：operation/proposal 的路径 pattern 放开为 Unicode 安全集（仍拦穿越/绝对路径/反斜杠/控制字符——原 ASCII 集拒绝 `需求.xlsx`）；规范化表头识别只强制需求正文列（「模块」列缺失取空串）；实现 §3.5 承诺的 mergedCells backfill；数据行判定改为「有序号或有正文」（正文缺失如实记空观测）。另：空 segment（无裁决记录的生成物维护 operation）不进入 Ledger 有效输入集合；新增第 9 套公共契约 logic-model.schema.json 与模块模板三张机器可解析表 | 门 5 在真实 Example 上跑迁移提交与 Atlas 编译，暴露冻结契约无法表示设计自身验收样本的四处缺陷 |
| 2026-07-23 | skill 层接线交付（voidtech-core 0.12.0）：新增 `prd-sync` 公共技能与 CLI（status/migrate/sync/rebaseline/propose/confirm/lifecycle/retire-source/invalidate-assertions/register-change/recover/atlas 十三个子命令，退出码 0 成功 / 1 错误 / 2 用法 / 3 读取栅栏 / 4 需人工裁决）；`check-prd-tree.py` 按 §9 改造（默认只读栅栏退出码 3、排除 reconciliation、`--operation-id` overlay、正则检查迁入 `markdown_validator`，legacy 树输出逐字节兼容）；`prd-maintain` 新增工况 5 并按能力分层重写收尾不变式；渲染器浏览器 CI 落地（零 npm 依赖 CDP harness `scripts/validate-renderer.mjs`、`assets/renderer-validation-proof.json` 七键证明、`renderer-validation.yml` workflow、`atlas.renderer_env()`）；新增 test_cli/test_check_prd_tree/test_renderer_env 共 20 组用例并接入可移植性检查 | 五门全通后引擎无使用者入口；按「实施状态」声明的 skill 层接线范围交付 |
| 2026-07-23 | Behavioral Atlas 深化：generator 1.1.0 在既有 schema v1 的预留 node/edge 类型上接通核心流程、页面边缘状态、业务状态机与模块边界；viewer 3.0 新增用户流程/状态机/边界与异常三视图，页面步骤展示条件、成功结果、失败分支与来源追溯；状态机支持模块本地完整表及领域规格引用表；缺表、坏页面引用、断头步骤、坏领域引用全部进入 gaps。Example「用户与会员」试点落地 7 条流程、18 步、18 失败分支、25 业务状态、39 条可定位页面的边缘状态，并经浏览器验证证明重签 | 原 viewer 只能回答「有什么、依赖什么」，无法回答页面如何跳转、业务状态如何变化、异常如何恢复；本批次在不建立第二权威源的前提下补齐行为可复核层 |
| 2026-07-23 | Behavioral Atlas 统一场景流程：generator 1.2.0 新增「流程状态影响」固定表、带步骤 ID 的边缘状态表、步骤到状态/异常/依赖的显式追溯与 fail-closed gaps；viewer 4.0.0 将主流程、状态变化、折叠异常、跨模块/外部依赖泳道合入单场景视图，新增场景选择器并改为默认入口，保留完整状态机与边界审计视图；renderer harness 4.0.0 增加默认入口及四层信息浏览器断言。Example「入会审批与缴费」试点发布 3 步、3 条状态影响、12 条步骤级页面异常 | 三张独立表适合完整审计，但不适合人按业务故事快速理解；显式关联避免 UI 通过文案相似度猜测状态和异常归属 |
