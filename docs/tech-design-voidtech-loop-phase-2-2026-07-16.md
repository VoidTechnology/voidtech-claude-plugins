# 技术设计：voidtech-loop 二期 Agent-first Review

- **日期**：2026-07-16
- **状态**：Final（2026-07-16 二轮评审复核通过）
- **产品规格**：`docs/prd-voidtech-loop-phase-2-2026-07-16.md`
- **摘要**：二期新增独立审查控制面。Fresh Review Agent 只通过 controller snapshot API 读取 hash 绑定事实并输出 Review Proposal；确定性 authority gate 依据人类批准或 Delegation Grant 落 Accept、Abandon 或 Revision。实现顺序必须先补 Review Operation Journal、per-run review lock、Decision/Approval Bundle/Revision 事务地基，再升级 Goal Spec v2、Execution Plan、Fact Pack 和 reviewer，最后才评估有界委托。

## 0. 当前实现事实

### 0.1 Accept

一期 `acceptRun` 只读取 run state、校验 `EVALS_PASSED`、写入 `status: ACCEPTED` 与 `accepted_at`，然后重算 state checksum 并重写报告。当前没有 Decision Record、actor、幂等键、冲突记录或外部 decision store。

### 0.2 Goal Spec

- `schema_version` 固定为 `1`；
- schema 使用 `additionalProperties: false`；
- `goal_hash` 是 v1 规范化对象 canonical JSON 的 SHA-256；
- 当前没有 `agent_review`、`review_policy`、provenance 或未知版本扩展点。

### 0.3 Execution gate

- `shellExecutionGate(validation, { allowShell })` 只接收布尔开关；
- `--allow-shell` 不落盘；
- 不计算覆盖 argv/setup/shell 的 Execution Plan；
- 不绑定 spec、draft 或 run；
- `shell: false` 只减少 shell 解析风险，仍能执行任意程序与仓库代码；
- 不支持 exact plan hash、scope、expiration 或消费记录。

### 0.4 状态与原子写

- state 单文件使用 tmp + fsync + rename；
- state schema version 固定为 `1`；
- 当前原子性只覆盖一个文件，不等价于 Feedback Pack + Goal Spec 的事务冻结；
- 当前没有 review draft、revision staging 或 commit manifest。

## 1. 总体架构

```text
Terminal Run
    |
    v
Review Fact Pack Builder
    |
    v
Fresh Read-only Review Agent
    |
    v
Review Proposal Schema Validator
    |
    v
Deterministic Decision Authority
    |                       |
    |                       +--> Human Escalation
    v
Decision / Revision Transaction Layer
    |
    +--> Decision Record
    |
    +--> Review Operation Journal
    |
    +--> Approval Bundle --conditional hash match--> Execution Plan Gate --> Validation
                                      |
                                      v
                              Atomic Revision Bundle
                                      |
                                      v
                              Explicit Start Command
```

| 组件 | 可以做 | 不可以做 |
|---|---|---|
| Fact Pack Builder | 从冻结 run、Git 和 evidence 构建索引、预算上下文 | 解释产品方向 |
| Review Agent | 只读分析、引用证据、生成 proposal 与 draft | 修改文件、执行 baseline、写 decision |
| Proposal Validator | 校验结构、引用和 hash | 判断 proposal 是否合理 |
| Authority Gate | 机械检查 outcome、字段差异、预算、Delegation Grant 与 escalation | 用 LLM 语义猜测是否越权 |
| Transaction Layer | Operation Journal、锁内 compare-and-write、幂等、冲突、原子发布、恢复 | 把 review 损坏推断成 run 损坏 |
| Validation Runner | 对已授权精确 bundle 执行 coding baseline 或 supplemental verification | 改草稿、授权或自行选择运行类型 |

## 2. 存储布局

建议扩展项目插件数据目录：

```text
<project-data>/
  runs/<run-id>/
    state.json
    report.md
    evidence/
    review.lock/
  decisions/<run-id>/
    operations/<operation-id>.json
    committed/
      decision-record.json
      revision/
    staging/<transaction-id>/
  reviews/<run-id>/
    fact-packs/<fact-pack-id>/
    proposals/<proposal-id>.json
    drafts/<draft-id>/
    verifications/<verification-id>/attempts/
  delegation-grants/<grant-id>.json
```

约束：

- `runs/` 继续使用一期 state 读写语义；
- Abandon/Revise 不写回旧 state；
- Accept 保留既有 state 转换，同时生成外部 Decision Record；
- 每个 run 最多出现一个 `decisions/<run-id>/committed/`，目录只追加、不原地修改；
- Revise 的 Revision Bundle 位于该 committed decision 内，与 decision slot 一起原子发布；
- staging 不属于 finalized 事实；
- 二期不自动把审计资产 commit 到业务仓库。
- review lock 是 `<run-dir>/review.lock/` 的 per-run mkdir lock，复用一期 owner metadata、PID identity、tombstone 与 stale takeover 协议；所有 operation、decision 写入、恢复与同 run staging GC 都必须持有它。
- 不同 run 可以并行 review；同一 run 的 Accept/Abandon/Revise 串行。review lock 不占用或替代 project active-run lock。
- review 开始时对冻结 candidate SHA 创建一次性 worktree；reviewer 只能通过 controller retrieval 读取该视图，不能读取循环 worktree 或用户当前工作树。
- run 执行资产与 review 资产分别判断健康度；缺失 operation/Decision Record 不得单独把 frozen spec、rounds 或 evidence 判坏。

## 3. 第一个工程里程碑：Operation/Decision/Revision 事务地基

这是二期新增地基，不依赖 Review Agent，必须先用 fixture 和故障注入验证。

### 3.1 Decision Record

```yaml
schema_version: 1
decision_id: decision-001
run_id: payment-tests-a1b2c3d4
goal_hash: 0123456789abcdef
source_commit: fedcba9876543210
outcome: accept
manual_review_results: []
decided_at: 2026-07-16T12:00:00Z
decided_by:
  kind: local_user
  claimed_id: null
  identity_verified: false
authorization: null
proposal_hash: null
approval_bundle_hash: null
basis:
  original_goal_hash: 0123456789abcdef
  supplemental_verification: null
note: null
```

Agent 委托决定：

```yaml
decided_by:
  kind: agent
  session_id: review-session-123
  authorization: bounded_delegate
authorization:
  grant_id: review-grant-001
  grant_hash: abcdef0123456789
```

hash 只证明记录内容绑定，不证明人或 agent 身份真实。Decision Record 不复制 grant allowlist 或 limits，只引用 `grant_id` 与 `grant_hash`。

### 3.2 Review Operation Journal

每次 finalized review decision 先建立内部 operation；用户不需要理解它：

```yaml
operation_id: review-op-001
protocol_version: 1
run_id: payment-tests-a1b2c3d4
outcome: accept
expected_state_checksum: abc123
decision_payload:
  schema_version: 1
  decision_id: decision-001
  run_id: payment-tests-a1b2c3d4
  outcome: accept
  decision_hash: def456
phase: prepared
```

`decision_payload` 保存恢复同一 Decision Record 所需的完整 canonical payload 或 content-addressed 引用，不能只保存不可恢复摘要。operation 文件使用同目录 tmp + fsync + rename 更新，phase 只有 `prepared`、`committed`；不得复用 operation ID 表达第二个决定。

统一提交顺序：

```text
Acquire Run Review Lock
  -> Re-read State, Operation, and Decision Slot
  -> Write Prepared Operation
  -> Accept Only: updateStateIfChecksum
  -> Atomically Publish Decision Record or Revision Bundle
  -> Mark Operation Committed
  -> Derive Integrity Report
  -> Release Lock
```

Abandon/Revise 跳过 state 更新，但必须经过 prepared operation、原子发布和 committed 标记。缺失 operation/Decision Record 只影响 review integrity；不能反推 run 执行资产损坏。

### 3.3 Decision slot 与幂等

每个 terminal run 最多一个 finalized decision：`accept`、`abandon` 或 `revise`。

幂等键覆盖 run ID、goal hash、source commit、outcome、manual review results、proposal hash、approval bundle hash、grant hash 与 note。`note` 参与幂等键；相同决定但 note 不同视为冲突请求，不静默覆盖已有记录。

| 已有决定 | Accept | Abandon | Approve Revise |
|---|---|---|---|
| 无 | 允许 | 允许 | 允许 |
| Accept | 相同请求幂等 | 拒绝 | 拒绝 |
| Abandon | 拒绝 | 相同请求幂等 | 拒绝 |
| Revise | 拒绝 | 拒绝 | 相同 bundle 幂等；不同 bundle 拒绝 |

未批准 draft 不占 decision slot。锁内发现相同 finalized decision 时幂等返回；发现冲突 decision 时标记 `review_conflict` 并拒绝。发现 matching prepared operation 时恢复它，不新建第二个 operation。

### 3.4 Per-run lock 与 state compare-and-write

接口语义：

```text
withRunReviewLock(runId, operationId, callback)
updateStateIfChecksum(runId, expectedChecksum, mutator)
```

`updateStateIfChecksum` 只承诺单机文件系统上的锁内 compare-and-write，不提供或声称分布式 CAS 语义：

1. 调用者必须持有对应 `<run-dir>/review.lock/`；
2. 锁内重新读取当前 state，不依赖锁前快照；
3. 比较 `expectedChecksum`，不匹配返回 `state_changed`；
4. 匹配时运行受限 mutator、生成新 checksum；
5. 使用 state 同目录临时文件、fsync 与原子 rename 替换。

所有二期 Accept 入口必须使用该接口。同 run 决策串行、不同 run 可并行；review lock 不占 project active-run lock。锁 owner metadata 绑定 operation ID，stale takeover 后恢复已有 operation。

### 3.5 Accept、Abandon 与 Revise 提交

Accept 在锁内校验 `EVALS_PASSED`、manual review、decision slot 后写 prepared operation；随后以 operation 中的 expected checksum 调用 `updateStateIfChecksum`，写入 `status: ACCEPTED`、`accepted_at`、`review_protocol_version: 1` 与 `decision_ref`，再发布 Decision Record 并把 operation 标记 committed。

Abandon/Revise 不修改 run state 或 checksum；它们写 prepared operation，在发布前锁内重读并要求 checksum 仍等于 `expected_state_checksum`，再原子发布 Decision Record（Revise 同时发布 Revision Bundle）并标记 committed。不匹配返回 `state_changed`。Phase 2 不支持 supersedes。

恢复矩阵：

| run 状态 | review 资产 | 判断与恢复 |
|---|---|---|
| `ACCEPTED`，无 protocol/ref、无 Record | 一期 legacy run | 合法，标记 `legacy_accepted`，不自动补写 |
| `EVALS_PASSED` / `STOPPED`，无 operation/Record | 尚未决策或 legacy | 合法，不得判损坏 |
| prepared Accept + `EVALS_PASSED` | state 尚未更新 | checksum 匹配时继续 Accept；不匹配返回 `state_changed` |
| prepared Accept + `ACCEPTED` 且 ref 匹配 | Record 尚未发布 | 从 operation 恢复并发布 Record，再标记 committed |
| committed Accept + `EVALS_PASSED` | state 落后 | 仅在 operation precondition 与当前 checksum 成立时补齐 state，否则 review fail closed |
| committed Abandon/Revise + 原终态 | 正常 | 不修改 run state |
| 新协议 `ACCEPTED` 有 `decision_ref`、Record 缺失 | review 资产损坏 | run facts 仍可读；`review_integrity: damaged`，review 层 fail closed |
| 同一 run 存在冲突 finalized decision | review conflict | 禁止继续决策，要求人工排障 |

没有 `review_protocol_version` 或 `decision_ref` 的历史 `ACCEPTED` 一律按 legacy 读取，不批量迁移、不伪造历史 Record。报告分别计算 `run_integrity` 与 `review_integrity`；review 损坏不能把 frozen spec、rounds、evidence 连带判坏。

state schema version 保持一期值；reader 只新增可选的 `review_protocol_version` 与 `decision_ref`，其他未知字段仍拒绝。`decision_ref` 至少绑定 operation ID、decision ID 与 decision hash。

报告枚举：`run_integrity = ok | damaged | unknown`；`review_integrity = not_started | legacy_accepted | prepared | committed | damaged | conflict`。二者不相互覆盖。

### 3.6 Review Draft 与 Approval Bundle

用户操作的是稳定的 `draft_id` 与递增 `draft_version`；批准面不要求展示原始 hash。系统把批准绑定到完整 Approval Bundle：

```yaml
schema_version: 1
draft_id: review-draft-v3
draft_version: 3
parent_run_id: payment-tests-a1b2c3d4
proposal_hash: 0123456789abcdef
feedback_pack_hash: 1111111111111111
goal_spec_hash: 2222222222222222
base_commit: fedcba9876543210
execution_plan_hash: 3333333333333333
delegation_grant_hash: null
evidence_snapshot_hash: 4444444444444444
validation_plan_hash: 5555555555555555
approval_bundle_hash: 6666666666666666
```

`approval_bundle_hash` 是除自身外上述 canonical bundle 的 SHA-256。建议模式的 `delegation_grant_hash` 为 null；有界委托必须绑定冻结 grant。`evidence_snapshot_hash` 绑定 Fact Pack manifest、原始反馈和实际用于 proposal 的 frozen locator/hash 集；`validation_plan_hash` 绑定 coding baseline / supplemental verification 类型、步骤编排与预期语义结果，具体命令/timeout/策略由 `execution_plan_hash` 绑定。Feedback Pack 的 content hash 在草稿生成时写入 provenance，发布时只验证不重生成，避免自引用循环。

任何 Pack、Spec、base、Execution Plan、evidence 快照或验证计划变化都生成新 draft version，使旧批准失效。批准记录保存 `approval_bundle_hash`、actor、时间与 `approve_execution: true`，不保存 `allow_shell`；hash 只证明内容绑定。

### 3.7 Revision Bundle 原子发布

Feedback Pack 与 Goal Spec 不能分别成为 finalized 权威资产。Revise 的发布单位是 committed decision 目录中的同目录 Revision Bundle：

```text
committed/
  decision-record.json
  revision/
    manifest.json
    feedback-pack.yaml
    goal-spec.yaml
    baseline-result.json
```

发布协议：

1. 在同一文件系统 staging 目录写全全部文件；
2. fsync 文件和 staging 目录；
3. 重算并匹配 `approval_bundle_hash`、decision slot 与 validation binding；
4. 原子 rename 整个目录到 committed 路径；
5. fsync 父目录；
6. `decisions/<run-id>/committed/` 出现即同时占用 decision slot，并代表 Pack、Spec、baseline 与 Decision 全部 finalized。

staging 与 committed 必须位于同一父目录/文件系统；路径构造不得预创建空 `committed/` 目录。不得把两个目标路径的连续 rename 描述为原子事务。

### 3.8 Supplemental Accept Bundle

verification-only pass 使用同一 decision transaction，但 committed 内容不是 Revision：

```text
committed/
  decision-record.json
  supplemental-verification/
    manifest.json
    goal-spec.yaml
    result.json
    evidence/
```

Decision Record、补充 Goal Spec、result/evidence 与 `basis` 在同一 staging 目录写全；随后按 §3.5 的 operation 协议更新原 run Accept state 并发布 committed 目录。响应丢失与崩溃恢复使用同一 operation ID。失败或不确定 attempt 只追加到 `reviews/<run-id>/verifications/`，不占 decision slot，也不能伪装成 finalized Supplemental Accept Bundle。

## 4. Goal Spec v1 / v2 共存

### 4.1 版本路由

- 保留现有 v1 schema 与 canonicalization，不原地改写语义；
- 新增独立 v2 schema；
- validator 读取 `schema_version` 后严格路由；
- 未知版本 fail closed；
- v1/v2 都保持 `additionalProperties: false`；
- v1 拒绝 `agent_review`、`review_policy`、`provenance`；
- v2 不自动降级为 v1。
- `goal_hash = SHA-256(canonical version-specific normalized object)`，`schema_version` 进入 canonical 内容；即使 v1/v2 业务字段看似相同，也不承诺跨版本 hash 相等。

### 4.2 v1 `goal_hash` 兼容

重构前建立 golden fixtures，覆盖 PRD 示例、简单模式四场景、setup/shell/manual/out-of-scope、短 SHA 完整化、键序和注释变化。

相同 v1 输入经新 validator 得到的 normalized JSON 和 `goal_hash` 必须与一期逐字节一致，不能以“语义等价”放宽。

### 4.3 v2 新字段

```yaml
schema_version: 2
agent_review:
  - id: public-api-compatibility
    criterion: Verify that public API behavior remains source-compatible.
    required: true
    evidence_scope:
      - candidate_diff
      - repository
      - eval_results
review_policy:
  default_mode: suggestion
  bounded_delegate_allowed: false
provenance:
  parent_run:
    run_id: payment-tests-a1b2c3d4
    goal_hash: 0123456789abcdef
    source_commit: fedcba9876543210
  feedback:
    - feedback_id: payment-review-001
      feedback_hash: abcdef0123456789
```

稳定语义：

- `agent_review` 在 run 终态后执行，不参与 `EVALS_PASSED`；
- `required: true` 表示 Accept 需要 pass 或由人显式否决 reviewer 结论；
- `review_policy` 是权限上限，不是实际 Delegation Grant；
- 一次性 grant 在终态后单独生成，绑定 run、expiration、actor、outcome、字段限制与 exact Execution Plan policy；
- `provenance` 进入 v2 `goal_hash`，但不证明来源真实。
- verification-only 补充规格也是 v2，但它不替换旧 run 的冻结 v1/v2 Spec；Accept 只在 `basis.supplemental_verification` 中并列引用两者。

### 4.4 共存路径

| 来源 | review 模式 | revise 输出 | accept |
|---|---|---|---|
| v1 run | 建议模式 | v2 spec | 一期状态转换 + 新 Decision Record |
| v1 run | 有界委托 | Phase 2 不支持 | 不支持 agent 自动 Accept |
| v2 run | 建议模式 | v2 spec | 支持 |
| v2 run | 有界委托 | v2 spec | 通过质量与权限门后支持 |

简单 `goal --check` 继续生成 v1。只有使用 `agent_review`、review policy 或 revision lineage 时生成 v2。

## 5. Canonical Execution Plan 与 Delegation Grant

### 5.1 Execution Plan

shell 与 argv 都是执行能力。controller 从 normalized Goal Spec 单源生成 plan，不持久化第二套可漂移命令定义：

```yaml
schema_version: 1
candidate_commit: fedcba9876543210
commands:
  - phase: eval
    eval_id: api-tests
    kind: argv
    executable: node
    args:
      - --test
      - tests/api.test.mjs
    cwd: .
    timeout_seconds: 120
    expected_exit: 0
    repeat: 1
    environment_policy: eval_whitelist
    network_policy: denied
    filesystem_policy: candidate_worktree
```

canonical `execution_plan_hash` 覆盖顺序、shell/argv kind、executable 与完整 args、shell command 原文、setup/eval phase、ID、cwd、timeout、expected exit、repeat、environment/network/filesystem policy 和 candidate commit。任一执行语义变化都会改变 hash。controller 内建、不启动外部程序的纯只读 evaluator 不进入 Execution Plan，但其类型必须是封闭枚举。

Execution Plan 只覆盖 Goal Spec 声明的 setup/eval；worker 轮内工具权限仍是一期开明示的 best-effort 面。plan hash 不代表 strict OS sandbox。

`network_policy` / `filesystem_policy` 是可验证授权意图，不得伪装成 OS 级隔离。若当前 runner 无法机械执行 grant 要求的 `denied`/scope，bounded delegate 必须升级给人；建议模式的人类明确批准可以沿用一期 best-effort 执行并显示风险。不能为了提高 eligibility 把“声明 denied”当成“已经隔离”。

### 5.2 Delegation Grant

```yaml
schema_version: 1
grant_id: review-grant-001
run_id: payment-tests-a1b2c3d4
issued_at: 2026-07-16T12:00:00Z
scope:
  outcomes:
    - accept
    - revise
  existing_fields: byte_identical
  append_eval_max: 3
  append_agent_review_max: 2
  may_weaken_invariants: false
  may_change_out_of_scope: false
execution:
  policy: exact
  inherit_parent_plans: true
  allowed_plan_hashes: []
limits:
  max_commands: 8
  max_total_seconds: 600
  network: denied
expires_at: 2026-07-17T12:00:00Z
one_shot: true
issued_by:
  kind: local_user
  claimed_id: null
  identity_verified: false
```

Phase 2 只支持 `policy: exact`：

- 父 Goal Spec 的 plan 必须规范化字节完全未变，且 `inherit_parent_plans: true`，才可继承；
- 新增或修改 argv、shell、setup、cwd、timeout 或执行策略都会产生新 plan hash；
- 新 plan hash 不在 `allowed_plan_hashes` 时升级给人；不支持程序名、前缀、正则或通配符 allowlist；
- shell plan 在交互上额外展示高风险提示，argv 仍走同一授权判断；
- grant 同时约束命令数量、总时长和网络策略；越界 fail closed；
- eligibility 由冻结 grant 与独立确定性分类器计算，reviewer proposal 无权声明自己 eligible。

`grant_hash = SHA-256(canonical grant)`；grant 在 reviewer 启动前冻结，之后只读。prepared operation 在 run review lock 内记录 grant ID/hash并占用 one-shot；matching operation 只能恢复，不能另开第二次消费。`expires_at` 只在 prepared operation 占用 one-shot 的 claim 时刻检查一次；claim 成功后，grant 对该 decision 的完整验证、发布与精确重试生命周期保持有效，执行中途不重查过期，不因长验证被中途作废。Decision Record 和 Feedback Pack 不复制 grant 内容，只引用 grant ID/hash。人批准新增 plan 时，批准对象仍是完整 Approval Bundle，而不是单个 executable。

### 5.3 一期 CLI 兼容

一期入口可继续接受 `--allow-shell`，但它只作为旧 UX 信号：controller 必须先展示包含 shell 与 argv 的完整 Execution Plan，并把用户确认转换为当前 Approval Bundle 的 `approve_execution`。执行器不能持久化或直接信任裸布尔值；二期新 `/approve` 文案使用“批准执行计划”，不再把 argv 表述为无须授权。

## 6. 安全执行顺序

建议模式：

```text
Generate Proposal and Approval Bundle Draft
  -> Pure Static Validation
  -> Show Original Input, Spec Diff, Unmapped Content, Commands
  -> Human Approves Current Draft Version
  -> Recompute and Match Approval Bundle Hash
  -> Shared Execution Plan Gate
  -> Coding Baseline or Supplemental Verification
  -> Recheck Approval Bundle and Decision Slot
  -> Atomically Publish or Route Verification Outcome
  -> Return Explicit Start Command or Accept Original Run
```

有界委托：

```text
Generate Proposal and Approval Bundle Draft
  -> Pure Static Validation
  -> Deterministic Delegation Grant Check
  -> Bind Approval Bundle to Grant Hash
  -> Shared Execution Plan Gate or Human Escalation
  -> Coding Baseline or Supplemental Verification
  -> Recheck Approval Bundle and Decision Slot
  -> Atomically Publish or Route Verification Outcome
  -> Return Explicit Start Command or Accept Original Run
```

静态 validation 前不得执行 repo 代码。用户的一次批准同时授权当前 bundle 中已展示的完整 Execution Plan；CLI 的 `approve_execution` 是该批准动作的一部分，不是第二个业务审批。语义失败不冻结 Revision Bundle，而是按 §6.1 路由；基础设施失败保留草稿与 append-only 诊断，允许对完全相同 bundle 精确重试。系统修改 Spec、Pack、base、Execution Plan、evidence 或验证计划时必须产生新版本并重新批准。

### 6.1 Supplemental Verification

`verification-only` 由确定性 diff 分类：old spec 的所有既有 canonical 字段和条目都存在且逐字节一致，只允许追加 eval；不得修改 task、既有 target/invariant、manual/out-of-scope、setup、budgets、protected paths、review policy 或实现要求。新增检查在 supplemental plan 中执行，不创建 run state，不调用 `startLoop`。

| 运行结果 | review outcome | 后续动作 |
|---|---|---|
| 所有补充 target 满足 | `verification_passed` | 原子保存补充 Spec、verification evidence 与 Accept Decision basis；执行原 run `EVALS_PASSED -> ACCEPTED` |
| 任一补充 target 不满足 | `correction_required` | 写 append-only Verification Record；生成以原 candidate 为 base 的 correction draft，失败检查作为 target，不自动设为 invariant |
| timeout、环境、来源或基础设施错误 | `verification_inconclusive` | 写 append-only attempt/诊断；不占 decision slot、不 Accept、不输出 start；相同 bundle 可重试 |

coding baseline 的 `all_targets_met` 仍拒绝创建 run；supplemental runner 的相同判定代表 `verification_passed`。二者共用底层命令执行与 evidence 格式，但使用不同的上层 result adapter，禁止通过放宽 `startLoop` 规则复用。

Accept 的 `basis` 示例：

```yaml
original_goal_hash: abc123
supplemental_verification:
  goal_hash: def456
  commit: fedcba9
  result: passed
  evidence_hash: 0123456
```

报告只说明原 candidate 通过了补充验证，不声称旧 Goal Spec 被修改。`correction_required` 或 `verification_inconclusive` 存在时 Decision Authority 阻断 Accept；前者只有形成 correction Revision 或人工 Abandon 后结束，后者允许原样重试。

## 7. Review Fact Pack

### 7.1 Manifest 与 context 分离

Fact Pack manifest 是完整索引，不是把全部正文复制进 prompt：

```yaml
schema_version: 1
fact_pack_id: fact-pack-001
run_id: payment-tests-a1b2c3d4
goal_hash: 0123456789abcdef
state_checksum: fedcba9876543210
base_commit: 1111111111111111
candidate_commit: 2222222222222222
snapshot_id: snapshot-001
tracked_files_manifest_hash: 2323232323232323
diff:
  total_bytes: 120000
  sha256: 3333333333333333
  files: []
rounds: []
evals: []
evidence: []
delegation_grant_hash: null
```

每个条目记录 locator、总字节数、hash、truncated、是否已注入或读取。Review Agent 只能通过 controller 的只读接口访问 locator。

`input_manifest_hash = SHA-256(canonical Fact Pack manifest JSON)`；`fact_pack_id` 是可读标识，不替代内容绑定。所有 proposal 与 agent review result 都引用该 hash。

### 7.2 硬预算

- initial context：128 KiB；
- 单次只读响应：64 KiB；
- session 累计事实读取：512 KiB；
- inline diff：最多 48 KiB；
- round/eval matrix：最多 24 KiB；
- evidence summaries：最多 24 KiB；
- spec、terminal state projection、Delegation Grant 与索引保留区：至少 32 KiB；完整必需内容超出 128 KiB 时拒绝 review，不截断规格。

terminal state projection 只包含 status、stop reason、base/candidate/last checkpoint、round/eval/evidence 计数、预算/成本与各源文件 hash；round 明细属于摘要和 manifest 索引，不直接塞入必保留区。上下文耗尽、模型结构化输出因上下文不足失败，都必须机械归类为 `budget_limited`，不能退化为泛化 spawn/parse 错误。

### 7.3 裁剪优先级

1. 完整 normalized spec、terminal state projection、manual/out-of-scope、Delegation Grant；
2. changed paths、diffstat、所有 round/eval/evidence metadata；
3. spec/eval 引用文件、公开 API/schema、protected paths、测试；
4. failed evidence、final pass evidence、setup evidence；
5. 其余内容按需读取。

### 7.4 Coverage

```yaml
coverage:
  status: complete
  changed_files_total: 12
  changed_files_inspected: 12
  evidence_items_total: 8
  evidence_items_inspected: 8
  budget_used_bytes: 420000
  budget_limit_bytes: 524288
  limitations: []
```

状态：`complete`、`budget_limited`、`source_limited`、`binary_limited`。有界委托只接受 `complete`。candidate 文本 diff >1 MiB、changed file 未审查或存在 binary limitation 时必须升级给人。

### 7.5 Snapshot 与 controller retrieval

review 开始时 controller：解析并冻结 candidate SHA，创建 detached 一次性 worktree，生成 tracked-files manifest，并记录 base/candidate/spec/state/evidence manifest hash。整个 session 只能使用同一 snapshot；session 完成或取消后由 GC 在无活动 retrieval 时清理。

Reviewer 看不到用户当前工作区的未提交修改、其他 worktree、home、插件数据目录、`.git`/git common dir/refs/锁文件、manifest 外 evidence、网络或 shell。

Controller 提供封闭工具面：

```text
review.listFiles(pattern)
review.readFile(path, offset, limit)
review.searchText(query, paths)
review.getDiff(base, candidate)
review.getSpec()
review.listRounds()
review.listEvidence()
review.readEvidence(evidenceId, offset, limit)
```

安全与预算由 controller 实现，而不是依赖 worktree 隔离：

- 规范化路径并以真实路径校验 snapshot root，拒绝绝对路径、`..`、symlink 逃逸、`.git` 和 manifest 外文件；
- `getDiff` 只接受 snapshot manifest 记录的 base/candidate 对；`listFiles`/`searchText` 结果只来自 tracked-files manifest；
- 二进制、大文件与超长行按稳定规则截断；search 限制最大文件数、匹配数和返回字节；
- evidence 只按 ID 读取，agent 提交的路径不能直接映射插件数据目录；
- 每次响应和 session 累计字节统一计账；返回携带 source locator、blob/evidence hash、offset 和 truncated；
- 源码/evidence 一律标为 untrusted data；内容不能改变工具调用、grant 或权限；
- 预算不足返回 `budget_limited`，不得静默截断后继续给出 delegate-eligible 结论。

## 8. Fresh Review Agent

### 8.1 Invocation

- 每次 review 使用全新 session，不 `--resume` worker；
- 记录 review session ID、模型标识、开始/结束时间和费用；
- repo、注释、日志和 evidence 全部视为不可信数据；
- 不给 reviewer Claude Code 原生、不受限的 Read/Grep/Glob；只提供 §7.5 controller-backed read/search/list 工具；
- repository scope 唯一指向 controller 在 candidate SHA 创建的一次性 worktree；
- 不允许 Bash、Edit、Write、Agent、WebSearch、WebFetch 或 MCP。

### 8.2 Proposal 输出

固定 schema 包含 proposal/session ID、input manifest hash、Delegation Grant hash、recommended outcome、findings/evidence refs、agent review results、coverage、escalations 与 revision draft 引用。自由文本永不直接作为命令、路径或权限输入。

### 8.3 Prompt injection

- proposal 声称“已获授权”不产生权限；
- controller 只信冻结 Delegation Grant 与 Approval Bundle；
- proposal 必须过 schema、hash、引用和 authority gate；
- 新增 shell/argv/setup plan 仍走 §5 exact hash gate；
- 注入测试是有界委托开放硬门。

## 9. `agent_review`

```yaml
id: public-api-compatibility
verdict: fail
review_session_id: review-session-123
input_manifest_hash: abcdef0123456789
evidence_refs:
  - diff:Sources/PublicAPI.ts
rationale: One exported symbol was removed.
```

verdict 为 `pass`、`fail` 或 `insufficient_evidence`。

- `pass` 不是人工检查；
- required agent review 未 pass 时不得自动 Accept；
- 人可以否决 agent verdict，但必须生成由人决定的 Decision Record，不改写原 agent result；
- `insufficient_evidence` 优先建议补 evidence；只有缺失内容属于人专有上下文时才升级。

v1/v2 的 `manual_review` 结果由现有人工 accept 输入路径扩展记录；agent 只能提出“转为 eval/agent_review”的新规格建议，永远不能写 `manual_review_results[].passed_by = agent` 或等价字段。

## 10. Delegation Grant 与最严追加规则

Authority Gate 对 frozen grant、old/new normalized spec 与 old/new Execution Plan 做确定性检查：

1. grant 的 run ID、expiration 和 one-shot 状态必须匹配 frozen run；goal hash 与 candidate/last checkpoint 由 Fact Pack 和 Approval Bundle 绑定；
2. `schema_version` 必须保持 `2`，`goal_id`、`task`、`budgets`、`setup`、`protected_paths`、`manual_review`、`out_of_scope`、`review_policy` canonical bytes 相同；
3. new spec 的 `base_commit` 必须等于 frozen Fact Pack / Approval Bundle 绑定的 candidate 或最后 checkpoint；
4. `provenance` 必须由控制器从 parent run、source commit 与 Feedback Pack 草稿 content hash 精确生成，发布时只验证；
5. 旧 spec 的每个 eval/agent review ID 都必须存在于新 spec，按 `id` 对齐后完整 canonical entry bytes 相同；
6. 只允许新 ID 追加，数量不超过 grant limits；新 ID 与旧 ID 不冲突；
7. `may_weaken_invariants`、`may_change_out_of_scope` 与 auto-start 在 Phase 2 必须为 false；
8. 完全未变的 parent Execution Plan 只有在 `inherit_parent_plans: true` 时可复用；所有新 plan hash 必须逐个存在于 `allowed_plan_hashes`；
9. plan 数量、总 timeout、network policy 必须位于 grant limits；argv 与 shell 使用同一 gate；
10. eligibility 由该检查器输出，reviewer proposal 中同名字段不受信；任一判断需要语义比较即升级给人。

Phase 2 不调用第二个 LLM 代替权限判断，也不为提高 delegate eligibility 放宽 exact plan policy。`delegate_eligible_rate` 只作为 alpha 观察指标。

## 11. 质量评估与发布门

每个 case 保存 case kind、support envelope、预登记时间、frozen Fact Pack、reference findings/outcome/escalations、agent proposal、finding adjudication、coverage/预算、人最终决定与污染状态。

Finding 不能只按文本相似度自动计分。先按类别、文件/eval 引用和影响对象产生候选匹配，再由独立人标记 exact、partial、missed 或 unsupported。unsupported 包含两类：finding 所述问题不存在，或证据真实但不足以支撑其 blocking 定级；两类都计入无依据统计，防止用琐碎 blocking 刷高 recall。

blind dogfood 时序固定为：终态自动登记并冻结 case 类型/支持范围 → 分配交叉 reviewer → reference 锁定 → agent proposal 锁定 → 结果揭示 → adjudication。必须保存 `enrolled_at`、`reference_locked_at`、`agent_result_locked_at`、`agent_result_revealed_at`、`contaminated`，且只有 `reference_locked_at < agent_result_revealed_at` 的未污染 case 可入 gate。已看到 agent 结果的 run 发起者不能作为 blind reference。

指标与样本量使用 PRD §13，只由合格 blind dogfood 决定委托开放。calibration seeded 与 boundary synthetic 各自单独统计，不进入真实纠正率、覆盖率或开放门。必须输出原始计数，例如 `27/30`。任何 critical miss、authority 漏升级、prompt injection 越权或未授权命令执行均直接 fail gate。

另报由冻结 grant 和独立分类器计算的 `delegate_eligible_rate`，但不设预设发布阈值；reviewer 自报 eligibility 不进入统计。

## 12. 失败与恢复

| 阶段 | 失败结果 |
|---|---|
| Fact Pack build | 不启动 reviewer，报告缺失/损坏来源 |
| reviewer spawn/parse | 不产生 decision，保留诊断 |
| proposal schema/hash | 拒绝 proposal |
| authority/grant gate | 升级给人或拒绝，不自动放宽 |
| static validator | 保留 draft，不执行 baseline |
| Execution Plan gate | 等待完整 bundle 批准或精确 grant，不执行命令 |
| coding baseline 语义失败 | 生成新 draft，不冻结旧 bundle |
| supplemental verification fail | `correction_required`，阻断 Accept，生成 correction draft |
| supplemental verification infra fail | `verification_inconclusive`，保留精确 bundle 与诊断，可重试 |
| validation 后 bundle 比对失败 | 结果作废，不冻结 |
| bundle staging | 未 finalized，可恢复或清理 |
| atomic publish 后响应丢失 | 重试返回同一 bundle 与启动命令 |
| prepared/committed operation 中断 | 持 run review lock 按 §3.5 恢复同一 operation；不新建第二个操作 |
| Decision Record 缺失 | 单独标记 `review_integrity`；不得据此破坏 `run_integrity` |

## 13. 测试策略

### 13.1 单元与行为测试

- v1/v2 schema route 与 golden hash；
- canonical Execution Plan 与 exact plan hash；
- decision idempotency/conflict matrix；
- Review Operation Journal 与恢复矩阵；
- per-run review lock 与 `updateStateIfChecksum`；
- Approval Bundle conditional hash match；
- authority byte-identical diff；
- Fact Pack budget/crop priority；
- proposal schema、coverage 与 evidence refs。

### 13.2 故障注入

- 每个 fsync/rename/Approval Bundle 比对边界；
- prepared Accept 在 state 更新前/后崩溃；Decision 发布前/后崩溃；operation committed 标记前/后崩溃；
- committed Accept + `EVALS_PASSED`、legacy Accept、缺失 Record 与冲突 finalized decision；
- Pack staged 后 Spec 写失败；
- baseline 期间 draft 修改；
- atomic publish 成功后 CLI 响应丢失；
- 同 run 两个并发 Accept/Abandon/Revise，以及不同 run 并发 review；
- checksum 漂移返回 `state_changed`；
- grant 过期/重复使用、parent plan 继承、新 argv/shell/setup plan 越界与 plan 漂移；
- snapshot 路径穿越、symlink、`.git`、manifest 外 evidence、search/byte budget 越界；
- verification-only pass 不调用 `startLoop`；coding/supplemental 的 `all_targets_met` 分流；失败 target 转换；双 goal hash 报告。

### 13.3 Agent 质量测试

- eval gaming、兼容性、evidence gap；
- authority boundary；
- prompt injection；
- oversized context；
- v1 manual review 不得伪装为 agent pass；
- 预登记 blind dogfood 与 reference reveal 时序；
- calibration seeded、boundary synthetic 与 blind 指标隔离；
- shadow delegate 与 blind reference outcome 对照。

### 13.4 回归命令

```bash
node --test plugins/voidtech-loop/tests/*.test.mjs
scripts/check-portability.sh
```

## 14. 实施依赖顺序

```text
Review Operation / Decision / Revision Transaction Foundation
    |
    +--> Goal Spec v1/v2 Compatibility
    |
    +--> Canonical Execution Plan and Delegation Grant
             |
             v
       Review Fact Pack and Proposal
             |
             v
       Suggestion-mode Review Agent
             |
             v
       Quality Corpus and Shadow Gate
             |
             v
       Bounded Delegation
```

任何 reviewer 实现都不得越过前三项地基直接落 Decision 或 Revision。

## 15. 开放技术问题

1. Fresh review invocation 是否复用一期 `claude -p` 适配层，还是建立独立 reviewer adapter；需 spike 验证结构化输出、工具白名单和成本。
2. Revision Bundle 是否提供显式 export 到 `.voidtech-loop/revisions/`；首版建议先存插件区，不自动写业务仓库。
3. 默认 128 KiB + 512 KiB 预算是否覆盖真实 dogfood；Task 5.1 必须实测 token/bytes 曲线，数据可下调默认值，任何上调都需重新评审支持包络与成本；裁剪顺序和超限 fail-closed 语义不得临场改变。
