# 实施计划：voidtech-loop 二期 Agent-first Review

- **日期**：2026-07-16
- **状态**：Final（2026-07-16 二轮评审复核通过）
- **产品规格**：`docs/prd-voidtech-loop-phase-2-2026-07-16.md`
- **技术设计**：`docs/tech-design-voidtech-loop-phase-2-2026-07-16.md`
- **ADR**：`docs/decisions/0003-agent-first-review-and-decision-authority.md`

## 1. 目标

按依赖顺序交付二期：先建立一期不存在的 Review Operation Journal、per-run review lock、Decision/Approval Bundle/Revision 事务地基，再实现 Goal Spec v1/v2 共存、canonical Execution Plan 与 Delegation Grant，然后构建 controller snapshot retrieval、verification-only 分支与建议模式 reviewer。有界委托的 authority gate 和 shadow 可在二期完成，但自动落决定只有预登记 blind dogfood 质量门通过后才作为独立发布动作开放。全程不自动启动新 run，不扩大一期远端副作用权限。

## 2. 已完成前置项

`68cbad3` 已完成：

- `resolveCommit` 收敛；
- `withEphemeralWorktree` 收敛；
- `tests/helpers.mjs` fixture 收敛。

这些不再进入二期任务清单。lifecycle 全量下沉、中立 `runCommand`、浅模块合并与 statestore 全量深化仍不是产品前置。

## 3. 依赖图

```text
M1 Review Operation and Decision Foundation
    |
    +--> M2 Goal Spec v1/v2
    |
    +--> M3 Execution Plan and Delegation Grant
             |
             v
       M4 Review Fact Pack and Proposal
             |
             v
       M5 Suggestion-mode Review
          /        \
         v          v
 M6 Blind Quality   M7 Authority Gate and Shadow
         \          /
          v        v
     Delegate Release Decision
```

M1–M3 是 reviewer 开发前硬依赖。M7 的机械 authority gate 可与 M6 数据积累并行；真正开放自动落决定同时依赖 M6 blind gate 和 M7 shadow，不以代码完成代替 gate。

## 4. Milestone 1：Review Operation/Decision/Revision 事务地基

### Task 1.1：定义 review artifact schema 与路径

**说明**：建立 Review Operation Journal、Decision Record、Feedback Pack、Approval Bundle、Revision Bundle manifest、Verification Record 的 schema 和单一路径构造接口，不接入 reviewer。

**验收标准：**

- schema 全部 `additionalProperties: false`；
- finalized 与 staging 路径物理分离；
- artifact hash 使用明确的 canonical JSON 版本。
- `approval_bundle_hash` 覆盖 Pack、Spec、base、Execution Plan、可选 Delegation Grant、evidence 快照与 validation plan；
- review lock、staging、committed 和 legacy Accept 分类路径互不混淆。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/reviewstore.test.mjs
```

**依赖**：无。

**预计文件**：

- `plugins/voidtech-loop/schemas/decision-record.schema.json`
- `plugins/voidtech-loop/schemas/review-operation.schema.json`
- `plugins/voidtech-loop/schemas/feedback-pack.schema.json`
- `plugins/voidtech-loop/schemas/approval-bundle.schema.json`
- `plugins/voidtech-loop/schemas/revision-manifest.schema.json`
- `plugins/voidtech-loop/schemas/verification-record.schema.json`
- `plugins/voidtech-loop/scripts/lib/reviewstore.mjs`
- `plugins/voidtech-loop/tests/reviewstore.test.mjs`

**规模**：M。

### Task 1.2：实现 per-run review lock 与 state compare-and-write

**说明**：在 `<run-dir>/review.lock/` 复用一期 mkdir/owner/PID/tombstone/stale takeover 协议，并实现 `withRunReviewLock` 与 `updateStateIfChecksum`。

**验收标准：**

- 同一 run 的 Accept/Abandon/Revise 串行，不同 run 可并行；
- 锁内重新读取 state；checksum 不匹配返回 `state_changed`；
- 匹配时使用同目录 tmp + fsync + rename 更新 state 并生成新 checksum；
- review lock 不占 project active-run lock；stale takeover 绑定 operation ID；
- staging GC 必须持同一把 run review lock。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/run-review-lock.test.mjs plugins/voidtech-loop/tests/statestore.test.mjs
```

**依赖**：Task 1.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/runreviewlock.mjs`
- `plugins/voidtech-loop/scripts/lib/statestore.mjs`
- `plugins/voidtech-loop/tests/run-review-lock.test.mjs`
- `plugins/voidtech-loop/tests/statestore.test.mjs`

**规模**：M。

### Task 1.3：实现 Operation Journal 与 decision slot

**说明**：实现 prepared/committed Review Operation Journal、first-finalized-decision-wins、幂等/冲突与 matching prepared operation 恢复入口，暂不接生命周期。

**验收标准：**

- operation 保存 expected checksum 与可恢复 decision payload；phase 只有 prepared/committed；
- 相同决定幂等，冲突 finalized decision 标记 conflict；matching prepared operation 必须恢复而非新建。
- operation/Decision 发布和 committed 标记各自使用明确的原子文件协议。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-operation.test.mjs plugins/voidtech-loop/tests/decisionstore.test.mjs
```

**依赖**：Task 1.2。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewoperation.mjs`
- `plugins/voidtech-loop/scripts/lib/decisionstore.mjs`
- `plugins/voidtech-loop/tests/review-operation.test.mjs`
- `plugins/voidtech-loop/tests/decisionstore.test.mjs`

**规模**：M。

### Task 1.4：迁移 Accept/Abandon/Revise 并实现 integrity 报告

**说明**：把三个决定入口接入 run review lock 与 Operation Journal；Accept 使用 `updateStateIfChecksum`，Abandon/Revise 不修改 state。

**验收标准：**

- Accept 仍只执行 `EVALS_PASSED -> ACCEPTED`，写可选 `review_protocol_version` 与 `decision_ref`；
- Abandon/Revise 不修改 run state/checksum；
- Abandon/Revise 发布前仍需锁内重读并匹配 operation expected checksum，不匹配返回 `state_changed`；
- prepared Accept 在 state 前/后崩溃、committed Accept + state 落后、committed Abandon/Revise 均按恢复矩阵处理；
- 无 protocol/ref 的历史 Accept 标记 `legacy_accepted`，不迁移、不补造 Record；
- 缺失 Decision Record 只损坏 review integrity；status/report 分别展示 `run_integrity` 与 `review_integrity`。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/lifecycle.test.mjs plugins/voidtech-loop/tests/review-recovery.test.mjs
```

**依赖**：Task 1.3。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/lifecycle.mjs`
- `plugins/voidtech-loop/scripts/lib/report.mjs`
- `plugins/voidtech-loop/tests/lifecycle.test.mjs`
- `plugins/voidtech-loop/tests/review-recovery.test.mjs`

**规模**：M。

### Task 1.5：实现 Approval Bundle 与版本化 conditional hash match

**说明**：以 `draft_id`/`draft_version` 提供用户可读版本，以隐藏 `approval_bundle_hash` 冻结 proposal、Pack、Spec、base、未映射内容、Execution Plan、可选 Delegation Grant、evidence snapshot 与 validation plan；任何变化使批准失效。

**验收标准：**

- 相同 bundle hash 稳定；
- Pack、Spec、base、Execution Plan、evidence 或 validation plan 任一变化都会改变 hash；
- validation 期间修改 bundle 可被二次比对检出；
- 用户批准当前版本，无需复制或理解 hash。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/approval-bundle.test.mjs
```

**依赖**：Task 1.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/approvalbundle.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewstore.mjs`
- `plugins/voidtech-loop/tests/approval-bundle.test.mjs`

**规模**：M。

### Task 1.6：实现 Revision Bundle 原子发布

**说明**：以同目录 staging + fsync + 原子 rename 发布 Pack、Spec、baseline result 和 Decision Record。

**验收标准：**

- committed bundle 出现即表示五个资产全部存在且 hash 一致；
- 每个写入、fsync、rename 边界的故障注入都不产生半冻结 lineage；
- 发布成功后响应丢失，重试返回同一 bundle。
- staging 与 committed 同父目录，且路径构造不得预创建空 committed 目录；
- Pack 写成功但 Spec 写失败时整体不 finalized。
- 同一事务层支持 Revision Bundle 与 Supplemental Accept Bundle 两种互斥 committed 形态；失败/inconclusive verification attempt 不占 decision slot。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/revision-bundle.test.mjs
```

**依赖**：Task 1.3、1.5。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/revisionstore.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewstore.mjs`
- `plugins/voidtech-loop/tests/revision-bundle.test.mjs`

**规模**：M。

### Checkpoint M1

- [ ] Operation Journal、Decision Record、Approval Bundle conditional match、Revision Bundle 均有新行为测试；
- [ ] per-run review lock、legacy Accept、integrity 分离与完整恢复矩阵有故障注入测试；
- [ ] 当前完整测试通过；
- [ ] Accept 兼容 v1；
- [ ] 故障注入没有半冻结资产；
- [ ] 完成专项工程评审后才进入 schema/Execution Plan 改造。

## 5. Milestone 2：Goal Spec v1 / v2 共存

### Task 2.1：建立 v1 golden hash 兼容集

**说明**：在改 validator 前锁定一期 normalized JSON 和 `goal_hash` 输出。

**验收标准：**

- 覆盖简单、复杂、setup、shell、manual、out-of-scope、短 SHA；
- fixture 以 YAML 原文为输入，经 `validateSpecText` 断言精确 normalized JSON 和 hash；
- 覆盖键序/注释、大写短 SHA、undefined key 与 YAML 标量类型边角，并补 lifecycle 级短 SHA 重算 hash；
- 当前实现全部通过。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/goal-hash-v1-golden.test.mjs
```

**依赖**：无；可与 M1 并行，但 M2 checkpoint 仍等待 M1。

**预计文件**：

- `plugins/voidtech-loop/tests/goal-hash-v1-golden.test.mjs`
- `plugins/voidtech-loop/tests/fixtures/goal-spec-v1-golden.yaml`

**规模**：S。

### Task 2.2：实现版本路由与 v2 schema

**说明**：保留 v1 schema，新增 v2 schema 与 validator dispatcher；未知版本 fail closed。

**验收标准：**

- v1 hash golden 全部不变；
- v1 拒绝 v2 字段；
- v2 支持 `agent_review`、`review_policy`、`provenance`；
- v1/v2 均严格拒绝未知字段。
- v1/v2 run 各自按原 schema/hash 读取，绝不隐式升级冻结 spec。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/validate.test.mjs plugins/voidtech-loop/tests/goal-hash-v1-golden.test.mjs plugins/voidtech-loop/tests/goal-spec-v2.test.mjs
```

**依赖**：Task 2.1。

**预计文件**：

- `plugins/voidtech-loop/schemas/goal-spec-v2.schema.json`
- `plugins/voidtech-loop/scripts/lib/validate.mjs`
- `plugins/voidtech-loop/tests/goal-spec-v2.test.mjs`
- `plugins/voidtech-loop/tests/validate.test.mjs`

**规模**：M。

### Task 2.3：贯通 v2 baseline 与 run 读取

**说明**：让 baseline/controller 对 v2 的 eval 保持一期语义，同时忽略但保存 `agent_review` 和 review metadata。

**验收标准：**

- `agent_review` 不参与 `EVALS_PASSED`；
- v2 完整 spec 进入 goal hash 和冻结 state；
- v1 行为不变。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/baseline.test.mjs plugins/voidtech-loop/tests/controller.test.mjs plugins/voidtech-loop/tests/goal-spec-v2.test.mjs
```

**依赖**：Task 2.2。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/baseline.mjs`
- `plugins/voidtech-loop/scripts/lib/controller.mjs`
- `plugins/voidtech-loop/tests/goal-spec-v2.test.mjs`

**规模**：M。

### Checkpoint M2

- [ ] v1 hash 逐字节兼容；
- [ ] v1/v2 共存矩阵通过；
- [ ] simple mode 仍生成 v1；
- [ ] v2 run 可达到一期终态。

## 6. Milestone 3：Execution Plan 与 Delegation Grant

### Task 3.1：规范化 Execution Plan

**说明**：从 v1/v2 normalized spec 单源生成覆盖全部执行语义和 candidate commit 的 canonical Execution Plan。

**验收标准：**

- shell/argv kind、executable/args 或 shell 原文、phase/ID、cwd、timeout、expected exit、repeat、environment/network/filesystem policy、candidate commit 均进入 hash；
- 任一执行语义变化改变 `execution_plan_hash`；
- plan 不复制第二套 spec 校验逻辑；内建非 command evaluator 使用封闭类型；
- plan 与策略不声称提供 strict OS sandbox。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/execution-plan.test.mjs
```

**依赖**：M2 checkpoint。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/executionplan.mjs`
- `plugins/voidtech-loop/tests/execution-plan.test.mjs`

**规模**：S。

### Task 3.2：实现 Delegation Grant 与 exact plan gate

**说明**：实现独立 grant 资产和机械判定器；Decision/Feedback 只引用 grant ID/hash，不复制授权内容。

**验收标准：**

- Phase 2 只接受 exact policy；parent plan 仅在未变且 `inherit_parent_plans` 为 true 时复用；
- grant 在 reviewer 前冻结，canonical hash 稳定；prepared operation 在 run lock 内占用 one-shot，重试只能恢复同一 operation；
- 新/改 argv、shell、setup、cwd、timeout 或策略产生新 hash，不在 `allowed_plan_hashes` 时升级；
- 程序名、前缀、正则和通配符 allowlist 均拒绝；
- outcomes、invariant/out-of-scope、追加数、命令数、总时长、网络、expiration、one-shot 均可机械检查；
- runner 无法执行要求的 network/filesystem policy 时，bounded delegate 升级，不把声明当隔离；
- eligibility 只由冻结 grant 与独立分类器产生。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/delegation-grant.test.mjs
```

**依赖**：Task 3.1、M1。

**预计文件**：

- `plugins/voidtech-loop/schemas/delegation-grant.schema.json`
- `plugins/voidtech-loop/scripts/lib/delegationgrant.mjs`
- `plugins/voidtech-loop/tests/delegation-grant.test.mjs`

**规模**：M。

### Task 3.3：迁移 `--allow-shell` 兼容入口

**说明**：保留一期入口兼容，但裸布尔只作为旧 UX 信号；controller 展示完整 shell+argv Execution Plan，并转换为当前 bundle 的 `approve_execution`。

**验收标准：**

- 一期显式确认不回归，但执行器不持久化或直接信任裸布尔；
- argv 与 shell 使用同一 plan gate，shell 额外展示风险提示；
- goal-spec baseline、loop goal 与 revision approve 共用 Execution Plan；
- `/approve <draft-id> --approve-execution` 是同一业务批准，不增加第二个审批。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/p0-shell-gate.test.mjs plugins/voidtech-loop/tests/execution-plan.test.mjs plugins/voidtech-loop/tests/delegation-grant.test.mjs
```

**依赖**：Task 3.2。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/shellgate.mjs`
- `plugins/voidtech-loop/scripts/goal-spec.mjs`
- `plugins/voidtech-loop/scripts/loop.mjs`
- `plugins/voidtech-loop/tests/p0-shell-gate.test.mjs`

**规模**：M。

### Checkpoint M3

- [ ] 任意 setup、shell eval 与 argv eval 都进入 canonical Execution Plan；
- [ ] exact grant、parent inheritance 与 policy enforcement 可用 fixture 端到端验证；
- [ ] v1 用户入口兼容；
- [ ] 未授权 plan 执行为 0。

## 7. Milestone 4：Review Fact Pack 与 Proposal

### Task 4.1：构建完整 Fact Pack manifest

**说明**：索引 frozen spec、state、candidate diff、rounds、eval 和 evidence，不复制全部正文。

**验收标准：**

- 每个来源有 locator、bytes、hash、truncated；
- state checksum、goal hash 和 candidate 绑定；
- 来源损坏 fail closed。
- `input_manifest_hash` 精确定义为 canonical manifest JSON 的 SHA-256；
- terminal state 使用稳定 projection，round 明细只进索引与摘要；
- repository locator 只指向 candidate SHA 一次性 worktree。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-fact-pack.test.mjs
```

**依赖**：M1、M2。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewfactpack.mjs`
- `plugins/voidtech-loop/schemas/review-fact-pack.schema.json`
- `plugins/voidtech-loop/tests/review-fact-pack.test.mjs`

**规模**：M。

### Task 4.2：实现 candidate snapshot 与路径边界

**说明**：冻结 candidate SHA，创建 detached 一次性 worktree 与 tracked-files manifest，建立整个 review session 共用的 snapshot。

**验收标准：**

- reviewer 看不到当前工作区未提交修改、其他 worktree、home、插件数据目录、`.git`/common dir/refs/锁文件；
- 绝对路径、`..`、symlink 逃逸和 manifest 外文件全部拒绝；
- `getDiff` 只能读取冻结 base/candidate 对；list/search 只返回 tracked manifest 文件；
- base/candidate/spec/state/evidence manifest hash 绑定 snapshot；
- session 只使用同一 snapshot；无活动 retrieval 后才允许清理 worktree。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-snapshot.test.mjs
```

**依赖**：Task 4.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewsnapshot.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewfactpack.mjs`
- `plugins/voidtech-loop/tests/review-snapshot.test.mjs`

**规模**：M。

### Task 4.3：实现 controller retrieval 与预算

**说明**：实现 controller-backed list/read/search/diff/spec/round/evidence 工具、128 KiB initial、64 KiB 单次、512 KiB 累计预算和固定裁剪优先级。

**验收标准：**

- reviewer 不获得原生 Read/Grep/Glob，只能使用 controller 工具；
- read/search 做路径校验；evidence 只按 ID；search 限制文件数、匹配数和返回字节；
- 二进制、大文件、超长行按稳定规则截断；每次返回包含来源 hash、offset、truncated；
- 所有未注入内容仍在 manifest；budget/source/binary limitation 可机械产生；
- 上下文耗尽稳定归类为 `budget_limited`，不能静默截断后输出 delegate-eligible。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-retrieval.test.mjs plugins/voidtech-loop/tests/review-context-budget.test.mjs
```

**依赖**：Task 4.2。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewretrieval.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewcontext.mjs`
- `plugins/voidtech-loop/tests/review-retrieval.test.mjs`
- `plugins/voidtech-loop/tests/review-context-budget.test.mjs`

**规模**：M。

### Task 4.4：定义 Review Proposal schema 与 evidence refs

**说明**：固定 proposal、finding、agent review、coverage 和 escalation 结构。

**验收标准：**

- 未知字段拒绝；
- evidence ref 必须解析到 Fact Pack；
- proposal 不能包含可直接执行的权限或命令字段；
- Proposal 与 Decision 物理分离。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-proposal.test.mjs
```

**依赖**：Task 4.1、4.3。

**预计文件**：

- `plugins/voidtech-loop/schemas/review-proposal.schema.json`
- `plugins/voidtech-loop/scripts/lib/reviewproposal.mjs`
- `plugins/voidtech-loop/tests/review-proposal.test.mjs`

**规模**：M。

### Checkpoint M4

- [ ] 不调用真实模型也能构建和验证完整 review 输入/输出契约；
- [ ] reviewer 只能读取单一 candidate snapshot，路径/symlink/`.git`/manifest 外 evidence 均无法绕过 controller；
- [ ] 每次响应与 session 总预算可审计，超限稳定进入 `budget_limited`；
- [ ] oversized case 稳定进入 limitation；
- [ ] 任何 proposal 都不能直接改变 run。

## 8. Milestone 5：建议模式 Review Agent

### Task 5.1：Reviewer invocation spike

**说明**：验证 fresh `claude -p` reviewer、结构化输出、只读工具、session ID、成本和 prompt injection 隔离。

**验收标准：**

- reviewer session 与 worker session 不同；
- 不使用 `--resume`；
- Bash/Edit/Write/网络工具不可用；
- 原生 Read/Grep/Glob 不可用，读取必须经过预算化 retrieval；
- proposal 可稳定解析；
- 形成 bytes/token 曲线、上下文耗尽分类、成本与时延数据；
- 验证单次 review 不超过 5 分钟且成本不高于一轮 worker invocation 的产品上限是否可达。

**验证**：独立 spike 报告 + 隔离 scratchpad 实测，不直接进入生产 adapter。

**依赖**：M4 checkpoint。

**预计文件**：

- `docs/spike-review-agent-invocation-2026-07-xx.md`
- `plugins/voidtech-loop/tests/reviewer-spike-fixtures/README.md`

**规模**：S。

### Task 5.2：实现 reviewer adapter

**说明**：建立独立 reviewer invocation seam，将 Fact Pack context 和只读 retrieval 提供给 fresh session。

**验收标准：**

- stub 与真实 reviewer 共用 adapter；
- reviewer 无写/决策能力；
- reviewer 只能调用 controller-backed list/read/search/diff/spec/round/evidence 工具，无法绕过 snapshot；
- session、usage、proposal hash 入审计记录；
- parse 失败不产生 decision。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/reviewer.test.mjs
```

**依赖**：Task 5.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewerio.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewcontext.mjs`
- `plugins/voidtech-loop/tests/reviewer.test.mjs`

**规模**：M。

### Task 5.3：实现建议模式 `/review`

**说明**：从 terminal run 启动 reviewer，展示建议与证据，并实现 Accept、Abandon、人工相反决定和最多一次带方向意见重提案；Revise 批准另由 Task 5.4 承接。

**验收标准：**

- Accept、Abandon 与 proposal correction 主路径成立；
- `loop accept` 复用同一事务；`loop abandon [--reason]` 可不经 reviewer 一步落人工决定；
- 非终态、已决、并发 session 与重试成本行为符合状态矩阵；
- `manual_review` 只录入规格声明项，agent verdict 不得伪装人工结果；
- status/report 能展示 Decision actor、依据与 legacy Accept 分类；
- 用户不需要维护 Feedback Pack；
- normal path 不暴露内部 hash，审计视图可展开。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-suggestion-flow.test.mjs
```

**依赖**：Task 5.2、M1–M3。

**预计文件**：

- `plugins/voidtech-loop/skills/review/SKILL.md`
- `plugins/voidtech-loop/scripts/loop.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewflow.mjs`
- `plugins/voidtech-loop/tests/review-suggestion-flow.test.mjs`

**规模**：M。

### Task 5.4：实现一次批准与 coding Revise

**说明**：实现 `/voidtech-loop:approve <draft-id> --approve-execution`，对当前展示版本执行静态校验、Approval Bundle 重算、Execution Plan gate、coding baseline、二次 hash match 与原子冻结；绝不自动启动。

**验收标准：**

- 默认展示来源 run、原始意图、变化摘要、未映射内容和完整 Execution Plan；shell 额外标高风险，argv 不隐藏；hash 只在审计视图；
- Pack/Spec/base/Execution Plan/evidence/validation plan 任一变化使旧批准失效并重新展示；
- baseline 语义失败生成新 draft；基础设施失败保留原 bundle 精确重试；
- 成功只输出显式启动命令；
- `apply` item 均映射或机械阻断，但界面明确不承诺模型已抽取全部真实意图。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-approval-flow.test.mjs
```

**依赖**：Task 5.3、M1–M3。

**预计文件**：

- `plugins/voidtech-loop/skills/review/SKILL.md`
- `plugins/voidtech-loop/scripts/loop.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewapproval.mjs`
- `plugins/voidtech-loop/tests/review-approval-flow.test.mjs`

**规模**：M。

### Task 5.5：实现 verification-only Revise

**说明**：以确定性字段 diff 分类只追加 eval 的补充验证草稿，在原 candidate 上运行 supplemental verification，并按三种 review outcome 分流。

**验收标准：**

- `verification_passed` 不创建 run ID、不调用 `startLoop`，原子保存补充 Spec/evidence 后 Accept 原 run；
- coding baseline 的 `all_targets_met` 仍拒绝启动，supplemental 的同一事实返回通过；
- `correction_required` 生成以 candidate 为 base、失败检查为 target 的 correction draft，不自动提升 invariant；
- `verification_inconclusive` 不 Accept、不输出 start，完全相同 bundle 可重试；
- Accept Decision/report 同时追溯原 goal hash、补充验证 hash、candidate 与 evidence。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/supplemental-verification.test.mjs
```

**依赖**：Task 5.4。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/supplementalverification.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewapproval.mjs`
- `plugins/voidtech-loop/scripts/lib/report.mjs`
- `plugins/voidtech-loop/tests/supplemental-verification.test.mjs`

**规模**：M。

### Task 5.6：定义 review 资产保留、GC 与卸载语义

**说明**：为 operation、staging、Fact Pack、proposal、draft、verification attempt、Delegation Grant 和一次性 worktree 定义保留期与清理者；finalized Decision/Revision 不由自动 GC 删除。

**验收标准：**

- 同一 run 的 staging GC 持 review lock；
- prepared operation、活动 review、未决 exact retry 与有效/已消费 grant 不被误删；
- 一次性 worktree 仅在无活动 retrieval 后清理；
- 插件卸载不会修改业务仓库或旧 run 执行事实，并明确插件数据目录由谁清理。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-gc.test.mjs
```

**依赖**：Task 5.5。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewgc.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewstore.mjs`
- `plugins/voidtech-loop/tests/review-gc.test.mjs`

**规模**：S。

### Checkpoint M5

- [ ] 建议模式端到端 dogfood 可运行；
- [ ] 人可纠正 proposal，agent 原结论仍保留；
- [ ] Operation Journal/Execution Plan/Approval Bundle/原子冻结契约不回归；
- [ ] verification-only 的 pass/fail/inconclusive 三分支端到端成立；
- [ ] operation/staging/Fact Pack/grant/worktree 生命周期有可测试的清理语义；
- [ ] 不自动启动新 run。

## 9. Milestone 6：预登记 Blind Quality Gate

### Task 6.1：建立预登记 case registry 与盲评协议

**说明**：终态 run 在 agent review 前自动登记，冻结 `blind_dogfood` / `calibration_seeded` / `boundary_synthetic` 类型与 support envelope，并保存 reference/agent lock 与 reveal 时序。

**验收标准：**

- 保存 `enrolled_at`、`reference_locked_at`、`agent_result_locked_at`、`agent_result_revealed_at`、`contaminated`；
- 只有 `reference_locked_at < agent_result_revealed_at` 且未污染的 blind case 可进入 gate；
- 已看过 agent outcome 的 run 发起者不能提交 blind reference；
- case 类型和 envelope 不能在揭示后修改；
- corpus 不包含未脱敏生产秘密。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-case-registry.test.mjs
```

**依赖**：M5 checkpoint。

**预计文件**：

- `plugins/voidtech-loop/tests/review-corpus/README.md`
- `plugins/voidtech-loop/tests/review-corpus/schema.json`
- `plugins/voidtech-loop/scripts/lib/reviewcaseregistry.mjs`
- `plugins/voidtech-loop/tests/review-case-registry.test.mjs`

**规模**：M。

### Task 6.2：实现 adjudication 与分层指标

**说明**：支持 exact/partial/missed/unsupported finding 裁定，并严格分离 blind、seeded、boundary 指标。

**验收标准：**

- 输出 `eligible_coverage`、`material_override_rate`、`must_escalate_recall` 及原始分子/分母；
- 另报 critical miss、out-of-envelope、in-envelope budget limited、污染数、seeded detection/correction、boundary routing 与非必要升级；
- 另报由冻结 grant 与独立分类器产生的 `delegate_eligible_rate`，但不设置发布阈值；
- seeded/boundary 不进入 blind 分母；must-escalate 分母为 0 时结果是 insufficient，不伪装 100%；
- partial 只有第二人确认已指出核心风险时才计入 recall；unsupported 需要独立否决，且口径含「问题不存在」与「证据不足以支撑 blocking 定级」两类。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-quality.test.mjs
```

**依赖**：Task 6.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/review-quality.mjs`
- `plugins/voidtech-loop/tests/review-quality.test.mjs`
- `plugins/voidtech-loop/tests/review-corpus/fixtures/`

**规模**：M。

### Task 6.3：运行 suggestion dogfood 并发布 gate 报告

**说明**：持续积累预登记 blind dogfood；seeded calibration 与 boundary routing 作为独立报告章节。委托开放只使用合格 blind 数据。

**验收标准：**

- 至少 30 个合格、未污染 blind case；
- `eligible_coverage >=80%`、`material_override_rate <=5%`、`must_escalate_recall=100%` 且分母非 0；
- `critical_miss_count=0`、`budget_limited_in_envelope_count=0`；
- 所有纳入、排除、污染和 envelope 分类可审计；
- seeded detection/correction 与 boundary routing 单独报告，不决定 GO；
- eligibility 分类不能读取 agent 自报结果，也不能为追求比例放宽 exact plan gate；
- 未达门槛明确 NO-GO，不以代码完成替代数据。

**验证**：独立 dogfood 报告经交叉 reviewer 评审。

**依赖**：Task 6.2。

**预计文件**：

- `docs/dogfood-voidtech-loop-review-quality-2026-07-xx.md`
- `plugins/voidtech-loop/tests/review-corpus/cases/`

**规模**：M，数据收集跨多次 session。

### Checkpoint M6

- [ ] blind gate 每项指标有 PASS/FAIL/INSUFFICIENT 与原始计数；
- [ ] seeded 与 boundary 结果没有进入 blind 分母；
- [ ] 任一 critical miss、越权或 prompt injection 事件为 0；
- [ ] 未达到门槛时自动落决定保持关闭，只允许 suggestion/shadow。

## 10. Milestone 7：有界委托

### Task 7.1：Delegation Grant 与 byte-identical authority gate

**说明**：把冻结 Delegation Grant、严格 canonical spec diff、exact Execution Plan diff 和明确 escalation reason 接入统一 authority gate。

**验收标准：**

- 既有字段/条目任一字节变化拒绝；
- 旧 spec 每个 ID 必须仍存在，删除同样拒绝；
- 只允许授权数量内的新 ID 追加；
- timeout 等看似小的变化也视为修改；
- invariant/out-of-scope/setup/auto-start 在 Phase 2 不可改变；
- parent plan 继承、所有新增 setup/shell/argv plan hash、命令数/总时长/network policy 均按 grant 精确检查；
- reviewer 自报 eligibility 被忽略，独立分类器输出可审计 reason；
- 不调用 LLM 做 authority 判断。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-authority.test.mjs plugins/voidtech-loop/tests/delegation-grant.test.mjs
```

**依赖**：M5 checkpoint；可与 blind dogfood 数据积累并行。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewauthority.mjs`
- `plugins/voidtech-loop/tests/review-authority.test.mjs`

**规模**：M。

### Task 7.2：Shadow delegate

**说明**：authority gate 给出“本可自动执行”的结果，但仍由人批准；记录 outcome 与 diff 一致性。

**验收标准：**

- 对所有 suggestion dogfood 记录 delegate eligibility 与 escalation reason；
- 既有条目变化、未授权 Execution Plan、manual/out-of-scope 修改和自动启动均为 0；
- shadow 结果不得揭示给尚未锁定 reference 的 blind reviewer；
- shadow 只验证机械 gate 与潜在价值，不替代 §13 blind 质量门。

**验证**：shadow gate 报告。

**依赖**：Task 7.1。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewflow.mjs`
- `plugins/voidtech-loop/tests/review-delegate-shadow.test.mjs`
- `docs/dogfood-voidtech-loop-delegate-shadow-2026-07-xx.md`

**规模**：M。

### Task 7.3：质量门触发后开放小范围自动 Accept/Revise

**说明**：这是 gate 数据触发的独立发布动作，不是二期代码完成即默认开放的承诺。只有 M6 blind gate GO 且 shadow 确定性测试通过，才允许控制器依据双显式 opt-in 的 Delegation Grant 自动落 Decision/Revision；新 run 仍显式启动。

**验收标准：**

- Decision Record 诚实记录 agent/session 与 grant ID/hash，不复制 grant 内容；
- coverage 非 complete 时拒绝；
- Execution Plan 或 grant limits 越界时升级给人；
- 相同 proposal 重试幂等；
- 不支持 agent 自动 Abandon。

**验证：**

```bash
node --test plugins/voidtech-loop/tests/review-delegate-flow.test.mjs
```

**依赖**：Task 7.2、M6 GO；任一数据条件不足则保留关闭状态。

**预计文件**：

- `plugins/voidtech-loop/scripts/lib/reviewflow.mjs`
- `plugins/voidtech-loop/scripts/lib/reviewauthority.mjs`
- `plugins/voidtech-loop/tests/review-delegate-flow.test.mjs`

**规模**：M。

### Checkpoint M7

- [ ] 自动落决定只在明确 Delegation Grant 内发生；
- [ ] 所有 Decision Record 可追溯 reviewer 与授权；
- [ ] 新 run 始终显式启动；
- [ ] 继续按预登记 blind case 监控 critical miss，出现一次即关闭委托。

## 11. 全局质量门

每个 checkpoint 都运行：

```bash
node --test plugins/voidtech-loop/tests/*.test.mjs
scripts/check-portability.sh
git diff --check
```

发布前额外要求：

- v1 golden hash 全部通过；
- 现有一期主路径行为不回归；
- reviewer 无写工具；
- reviewer 无原生文件读取工具，全部 retrieval 有预算与审计；
- setup/shell/argv 全部进入 Execution Plan，不存在裸布尔绕行；
- run/report 分别输出执行与评审 integrity，缺失 Record 不连带判坏 run；
- 故障注入覆盖事务边界；
- PRD §13 质量数据达到对应发布门；
- README/USAGE/CHANGELOG 只在功能实际交付后更新行为说明。

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 事务地基复杂度被低估 | 高 | M1 独立评审，不与 reviewer 同批实现 |
| v1 hash 漂移 | 高 | 先 golden，再拆 validator；逐字节断言 |
| Execution Plan 重构破坏一期 UX | 高 | 保留 `--allow-shell` 入口兼容，shell/argv 同一 gate 行为测试 |
| review 损坏污染 run 判断 | 高 | Operation Journal；`run_integrity` / `review_integrity` 分离；legacy 不迁移 |
| Fact Pack 预算过小 | 高 | 固定裁剪语义，真实 corpus 测覆盖；超限 fail closed |
| Review Agent 假阳性/漏检 | 高 | suggestion first、预登记 blind corpus、critical miss 零容忍 |
| Authority Gate 夹带语义判断 | 高 | canonical byte diff；需要语义比较一律升级 |
| prompt injection / snapshot 逃逸 | 高 | controller-backed retrieval、realpath/symlink/manifest/budget gate、controller 只信冻结 grant |
| 过早建设连续自治 | 中 | ADR 明确范围外，有界委托不自动启动 |

## 13. 工程计划评审必须定案

1. Review Agent adapter 的 invocation spike 结果与具体模型；
2. Revision Bundle 是否提供首版 export；
3. 单次 review 在“≤5 分钟且不高于一轮 worker invocation”产品上限内的具体成本数值。

external feedback 独立导入已移出二期，不再是工程评审开放项；Feedback Pack schema 保留来源 seam。
