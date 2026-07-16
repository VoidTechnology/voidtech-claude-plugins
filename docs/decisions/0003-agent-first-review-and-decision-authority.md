# ADR-0003：Agent-first Review 与确定性 Decision Authority

## 状态

已接受（产品与架构方向，尚未实现）

## 日期

2026-07-16

## 背景

voidtech-loop 一期可靠完成了分钟级 Agentic coding loop，但终态后的 developer feedback 只包含报告、manual review 清单和人工 `accept`。最初的二期方案把反馈结构化为 Feedback Pack，再要求人逐项分类、冻结和批准。这虽然审计模型完整，却把 developer feedback loop 做成审批工作流，也浪费了独立模型在技术完整性检查上的能力。

源理论强调的是人当前通常具有 context advantage，而不是所有 developer feedback 必须由人亲自完成。对冻结规格、candidate diff、rounds、eval 和 evidence 的技术审查，可以交给一个不参与编码的 fresh Review Agent。人应保留方向权和否决权，并只在缺少专有上下文或决定越过授权边界时介入。

一期没有 Review Operation Journal、Decision Record、per-run review lock、Approval Bundle conditional hash match、Revision Bundle、Goal Spec v2、Execution Plan、Delegation Grant 或 review quality gate。这些都是二期新地基，不能假设现有控制器已经提供。

## 决策

### 1. Agent-first

每次 review 使用独立新 session。Review Agent 不获得原生文件系统读取工具，只通过 controller 的预算化只读 retrieval 接口读取 hash 绑定的 Review Fact Pack 和 candidate SHA 一次性 worktree；不 `--resume` worker，不修改 repo/run/evidence，不继续编码，只输出结构化 Review Proposal。

### 2. Proposal 与 Decision 分离

Review Agent 没有 accept、freeze 或启动权限。确定性 Decision Authority 校验 proposal、Delegation Grant、字段差异、Execution Plan、预算和 decision slot 后，才允许控制器落 Decision 或 Revision。

### 3. 两阶段授权

- 建议模式为默认：agent 完成评审，人批准或纠正最终建议。
- 有界委托只有在量化质量门和 shadow case 全部通过后开放。
- 连续自治不进入二期。

### 4. 最严可机械约束

有界委托中，既有 Goal Spec 字段和条目必须保持规范化字节完全一致，只允许在授权上限内追加新 eval 或 agent review。timeout、repeat、cwd、command、role 等任何改变都属于修改并升级给人。Authority Gate 不使用 LLM 判断“语义上是否削弱”。

### 5. 三种 review 角色

- `eval`：确定性、可重复、命令化，参与 `EVALS_PASSED`；
- `agent_review`：需要语义判断，但 fresh reviewer 能取得所需上下文；
- `manual_review`：依赖人专有上下文、taste、身份或现实世界观察。

Agent verdict 不得伪装成人工检查结果。

### 6. 新事务地基先于 reviewer

二期第一个工程里程碑是 Review Operation Journal、per-run review lock、Decision Record、decision slot、Approval Bundle conditional hash match、Revision Bundle 原子发布和故障恢复。Goal Spec v1/v2 共存与 Execution Plan/Delegation Grant 紧随其后。没有这些地基，不实现自动落决定。

### 7. Review Fact Pack 分层

完整 manifest 只保存索引与 hash；模型初始上下文和按需读取有硬预算、稳定裁剪顺序和 coverage 状态。上下文或 diff 超限时，建议模式诚实报告限制，有界委托 fail closed。

### 8. 质量门使用预登记 blind dogfood

只有预登记、reference 在 agent 结果揭示前冻结且未污染的 blind dogfood 可以决定是否开放委托。calibration seeded 与 boundary synthetic 分开报告，不进入真实覆盖率或纠正率。至少积累 30 个合格 blind case，并同时满足 coverage、material override、must-escalate recall、零 critical miss 与零 in-envelope budget limit，才可把自动落决定作为独立发布动作开启；80% coverage 只是效率门，不是安全门。

### 9. 新 run 始终显式启动

建议模式与有界委托最多产出 Decision 或可启动 Goal Spec，不自动启动下一 run，不 push、merge、建 PR 或发布。

### 10. Verification-only Revise 不创建空转 run

只补强 eval、未改变任何既有产品或规格语义的 revise，进入 supplemental verification，而不是 coding run。验证通过时接受原 run，并在 Decision Record 中并列引用原 goal hash 与补充验证 hash；验证失败才生成以原 candidate 为 base、失败检查为 target 的修复型规格；基础设施不确定时既不接受也不启动。coding baseline 的 `all_targets_met` 拒绝语义保持不变。

### 11. 一次批准绑定完整 Approval Bundle

用户批准当前展示的草稿版本，系统内部绑定 `approval_bundle_hash`。bundle 覆盖 Feedback Pack、Goal Spec、base commit、canonical Execution Plan、来源 evidence 快照和验证计划。批准后才经过 shared execution gate 和 validation；任一内容变化使批准失效。验证通过后才原子冻结，不自动启动新 run。

### 12. Execution Plan 与 Delegation Grant

shell、argv 和 setup 统一编译为绑定 candidate 与执行策略的 canonical Execution Plan。Phase 2 Delegation Grant 只支持 exact plan hash：未变 parent plan 可在明确授权时继承，新/改 plan 必须精确列出；不支持程序名、前缀、正则或通配符 allowlist。Decision Record/Feedback Pack 只引用 grant ID/hash。无法机械执行 network/filesystem policy 时升级给人，不能把声明当沙箱。

### 13. Run integrity 与 review integrity 分离

Decision Record 缺失永远不能单独证明 run 损坏。所有 finalized decision 经过 prepared/committed Review Operation Journal；Accept 在 per-run review lock 内以 expected checksum + atomic replace 更新 state，Abandon/Revise 不改 state。历史 `ACCEPTED` 无 protocol/ref 合法读取且不补造 Record；新协议 review 损坏只让 review 层 fail closed，冻结 spec、rounds、evidence 仍独立判断。

### 14. Controller snapshot 是 reviewer 唯一读取边界

Reviewer 不获得 Claude Code 原生、不受限的 Read/Grep/Glob/Bash，只使用 controller-backed list/read/search/diff/spec/round/evidence 工具读取 candidate SHA 一次性 snapshot。controller 负责 realpath/symlink/`.git`/manifest/evidence ID 校验、字节预算和截断审计；临时 worktree 只负责冻结内容，不是权限系统。

## 备选方案

### Human-first 表单式 review

优点是所有判断显式，缺点是简单 Accept 与复杂 Revise 承担相同流程成本，用户很可能绕开工具。拒绝作为默认交互；Feedback Pack 保留为系统生成的审计资产。

### 让 worker 自我审查

成本低、上下文连续，但执行者有确认偏差，也可能依赖自己对完成情况的总结。拒绝；reviewer 必须 fresh 且只读冻结事实。

### Review Agent 直接拥有 accept/freeze 工具

交互最短，但 prompt injection、越权和语义自裁无法由机制兜底。拒绝；agent 只提案，控制器执行确定性 authority gate。

### 二期直接支持连续自治

可以最大化无人值守时间，但会同时引入多代目标漂移、总预算、eval gaming 累积和 supersedes。拒绝进入二期，待建议模式和有界委托有真实数据后再评估。

### 一次把全部 diff、rounds 与 evidence 塞入 prompt

实现简单，但长循环必然撞上下文上限且裁剪不可审计。拒绝；采用完整 manifest、预算上下文和按需读取。

## 影响

- 二期范围从“review UX”扩大为新的审查控制面和事务地基；
- Goal Spec 需要 v2，但 v1 canonicalization 与 hash 必须逐字节兼容；
- shell gate 从瞬时 `--allow-shell` 重构为 Execution Plan gate；argv/setup 使用同一权限等级，委托授权由独立 Delegation Grant 承载；
- run 与 review 恢复状态分离；operation journal 和锁内 compare-and-write 是二期首个工程地基；
- controller snapshot retrieval 成为唯一 reviewer 文件/证据读取边界；
- Review Agent 带来新的 prompt injection 与质量评估面，不能只靠单元测试验收；
- manual review 应逐步收紧，但 v1 字段不被自动重解释；
- 有界委托上线速度取决于 corpus 指标，不取决于功能代码是否完成；
- 二期首发只承诺建议模式；自动落决定需后续 blind gate 数据触发，external feedback 独立导入留到后续阶段；
- 用户不需要理解 Decision Record、Feedback Pack、hash 或 lineage，除非进入审计和排障。

## 关联文档

- `docs/prd-voidtech-loop-phase-2-2026-07-16.md`
- `docs/tech-design-voidtech-loop-phase-2-2026-07-16.md`
- `docs/implementation-plan-voidtech-loop-phase-2-2026-07-16.md`
