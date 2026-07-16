# 评审记录：voidtech-loop 二期方案定稿前多维度审查

- **日期**：2026-07-16
- **状态**：Final（评审结论；被评审文档仍为 Draft）
- **评审对象**：`docs/prd-voidtech-loop-phase-2-2026-07-16.md`、`docs/tech-design-voidtech-loop-phase-2-2026-07-16.md`、`docs/implementation-plan-voidtech-loop-phase-2-2026-07-16.md`、`docs/decisions/0003-agent-first-review-and-decision-authority.md`、`README.md:168` 改动
- **评审方式**：三路并行独立评审（架构、产品、跨文档一致性与代码事实核查），全部对照一期真实代码（HEAD `68cbad3`）验证，再由主评审交叉复核与裁定
- **摘要**：方案方向与骨架成立（proposal/decision 分离、byte-identical gate、Fact Pack 分层、事务分层均无需重做），四份文档对一期代码的全部事实性陈述经逐条比对无一失实。但存在 7 项阻断定稿问题——其中 1 项产品语义结构性冲突（验证型 Revise 与一期 baseline 规则互斥）、4 项会导致工程师无法开工或写出矛盾实现的设计缺口、2 项质量门与交互契约缺陷——外加 12 项应修改与若干建议。结论：**不可定稿，需一轮修订**；修订均不改变方向，预计一轮可收敛。

## 一、阻断定稿（7 项）

### R1. 验证型 Revise 是断头路：与一期 baseline 启动规则结构性冲突

- **位置**：二期 PRD §4.2 场景 2、§10.3；技术设计 §1（Baseline Runner「一期 baseline 语义」）；冲突依据为一期 PRD §4.1 启动体检第 4 条。
- **问题**：二期最高频 Revise 场景（`EVALS_PASSED` 后补强 eval 覆盖）以 candidate 为 base，原 target 在 candidate 上全部已通过。补强 eval 若通过（无论 target/invariant 角色），新 run 会被一期「所有 target 基线已满足时拒绝」规则直接拒绝。「补上验证、验证通过、安心接受」这个大概率结局在产品上被表达为 baseline 失败，且没有转回 Accept 原 run 的引导路径。reviewer 无执行权限，无法预判补强 eval 是否通过，人每次批准 Revise 都在赌唯一能启动的分支。
- **修改**：PRD §10.3 定义「验证型 Revise」产品语义——baseline 发现全部 target（含补强项）在 base 上已满足时不作失败处理，产出 verification-passed 结果，呈现补强验证证据并引导 Accept 原 run（此时 draft 未占 decision slot，Accept 仍可用）；§14 补对应验收项；技术设计同步定义 baseline 差异化规则并交 architect 评估机制方案。

### R2. Accept 崩溃恢复矩阵不完备，会误杀合法终态与全部存量 run

- **位置**：技术设计 §3.3「崩溃恢复」；实施计划 Task 1.3。
- **问题**（三个洞）：
  1. 「committed record 已存在但 state 仍 `EVALS_PASSED` → 视为损坏」会误杀 Abandon/Revise 的**正常终态**（两者按 §3.4/§2 均不写回 state）。恢复矩阵必须以 `(state.status, record.outcome)` 为键，而非 record 存在性。
  2. 缺失行：state 已 `ACCEPTED` 但 staging 与 committed record 均不存在——**一期所有已 accept 的存量 run 天然处于该态**（`lifecycle.mjs` acceptRun 只写 state）。按损坏 fail closed 会判死全部 legacy run；按放行则崩溃丢 record 的事务静默降级。两者磁盘上不可区分。
  3. staging「可重试或清理」未定义清理者与互斥，与恢复进程「完成同一目录发布」存在竞态。
- **修改**：恢复矩阵改为 `(state.status, staging 存在性, committed 存在性, record.outcome)` 完整键枚举表；为 legacy run 显式定义 `pre_phase2_accept` 分类（判据：`accepted_at` 存在且 `accepted_decision_id` 缺失）并定义放行/补记策略；staging 清理必须持 review lock；Task 1.3 补对应故障注入验收。关联：`accepted_decision_id` 是 state 新字段，但 state schema 声明固定 version 1，兼容策略需一并写明并列入 Task 1.3「允许字段」。

### R3. review lock 与 state「CAS」引用了不存在且未设计的原语

- **位置**：技术设计 §3.3（review lock 全文仅此一现；step 5「CAS 更新 state」）；实施计划 Task 1.2。
- **问题**：一期 `statestore.writeState` 是无条件覆盖写，无 CAS 原语；`acceptRun` 读-改-写且不占锁，两个并发 Accept/Abandon 今天就能交错。review lock 的物理位置、每 run 还是每 project、崩溃解锁/接管语义、与一期项目锁的关系（decision 事务是否检查项目锁、revision baseline 与活动 run 是否允许并发）全部未定义。
- **修改**：技术设计增设一节：(1) review lock = `decisions/<run-id>/lock`，per-run，复用一期 mkdir + PID 判活 + tombstone 接管实现；(2)「state CAS」定义为持 review lock 下 read → 校验 status 与 checksum → write，全文停用 CAS 一词的裸引用；(3) 写死 decision 事务与项目锁、revision baseline 与活动 run 的并发关系；(4) staging GC 持同一把锁。

### R4. 委托模式命令授权存在空洞：argv eval 绕过规则 7，allowlist 字段缺失，授权记录表述分裂

- **位置**：技术设计 §10 规则 7、§5.2；PRD §7.2（称 Authorization Record 含预算与 shell allowlist，但技术设计拆为两个 record 且均无 allowlist/budget 字段）。
- **问题**：规则 7 只点名 shell/setup，但 `shell: false` 的 argv eval 同样执行任意程序（`["node","-e",…]` 是合法 argv eval）。被注入的 reviewer 在委托模式下追加 argv eval，按规则 5/6 只查数量与 ID，字面上无需命令授权——与 PRD「未授权 shell 执行次数 0」的门直接冲突。反之若按最严解释「任何新命令都升级」，委托 revise 永远不可能自动通过，delegate-eligible ≥30% 的门在设计上不可达。两头都不成立。且 §5.2 提到的 allowlist 在两个 record schema 中都没有字段，确定性 gate 无判定依据。
- **修改**：统一为命令层面单一判据——任何导致 `command_manifest_hash` 变化的追加/修改（不分 shell/argv/setup）必须落在 Authorization Record 显式 `allowed_appended_commands`（精确 argv/字符串，非模式）内，否则升级给人；重写规则 7，补 schema 字段，统一 PRD §7.2 与技术设计的「一个 record 还是两个 record」表述；Task 7.1 补「追加 argv eval 越 allowlist 拒绝」用例。

### R5. reviewer 工具面自相矛盾，且未定义读哪个文件系统视图

- **位置**：技术设计 §8.1（允许「代码 Read/Grep/Glob」）；ADR-0003 决策 1（「只读取 hash 绑定的 Review Fact Pack」）；实施计划 Task 4.2（「reviewer 无法读取任意路径」）。
- **问题**：`claude -p --allowedTools Read,Grep,Glob` 可读用户能读的任何磁盘路径，与另两处直接矛盾。这决定：64 KiB/1 MiB 预算是否可执行（直连 Read 不经 controller 记账）、prompt injection 面（注入文本可指挥 reviewer 读任意路径）、coverage 统计真实性。且即便允许读代码，「读哪里」未定义：终态后循环 worktree 可被用户随意修改，读活 worktree 破坏冻结事实前提；v2 `evidence_scope: repository` 落点悬空。
- **修改**（推荐项）：reviewer 不给原生 Read/Grep/Glob，全部读取经 controller 只读 retrieval 接口，预算、审计、注入隔离一处闭合；review 开始时由 controller 在 candidate SHA 上建一次性只读 worktree（复用一期 `withEphemeralWorktree`）作为 repository scope 唯一数据源。若坚持原生工具，必须显式修订 ADR-0003 决策 1 并承认预算仅对 fact-pack 读取生效。定稿前二选一写死，此决定塑造 M4/M5 架构。

### R6. 质量门口径可被样本构成操纵，部分指标与 corpus 设计自相矛盾

- **位置**：PRD §13.1、§13.2、§15.1、§15.2。
- **问题**：
  1. 「用户实质纠正率 ≤20%」混入 seeded case 会被系统性污染（seeded 无真实用户）；仅真实 case 时 n=12，≤20% 即 ≤2 例，无统计意义地作为硬 gate。
  2. 「默认预算完整覆盖率 ≥80%」与 §15.1 要求的 oversized seeded case（设计上必触发 `budget_limited`）矛盾；seeded 12 例在 8 类间配比未定，指标结果可被配比任意操纵。
  3. 「未触发 budget_limited」≠「完整覆盖」——agent 少读文件即可不触发预算；口径应为 `coverage = complete` 比例。
  4. 真实 dogfood 中 run 发起者执行 `/review` 即看到 agent outcome，不能再当 reference reviewer；reference 时序规则与 outcome 级分歧裁定未定义。
- **修改**：§13.1 增加「计算子集」列（纠正率仅真实 case、改原始计数表述或降为观察指标；覆盖率排除 oversized seeded、口径改 coverage=complete；unsafe Accept 与 recall 按真实/seeded 分开报告）；§15.1 给 seeded 8 类最低配额；§15.2 补真实 case reference 时序与 outcome 级裁定规则。

### R7. 建议模式交互契约缺失，「一次批准」不可设计不可验收

- **位置**：PRD §7.1、§10.1、§10.3、§6 mermaid；实施计划 Task 5.3。
- **问题**：
  1. 全文只有 `/voidtech-loop:review <runId>` 一条命令。批准 Accept 用什么动作（复用一期 `accept` 还是新命令）、批准 Revise draft 的动作、「并列展示 + 可展开 diff」在 CLI 里的形态全部缺失（对照一期 PRD §4.1 全命令示例的基线是明显完成度差距）。
  2. PRD「人批准精确 `draft_hash`」与实施计划 Task 5.3「normal path 不暴露内部 hash」字面矛盾；机制可兼容（批准绑定 hash、界面批准「当前展示草稿」），但需定义展示与批准间 draft 被并发替换时用户看到什么。
  3. 人批准后 baseline 失败的用户路径空白（技术设计 §12 只有机制结果）。
  4. PRD §6 mermaid 中「Human Approves」画在「Static Validation」之前，与技术设计 §6 安全顺序（先静态校验后批准）矛盾，且图中两个批准节点语义未区分。
- **修改**：PRD §10 补「CLI 交互契约」一节：三条路径各自的批准/纠正/放弃命令形态、信息分层（摘要默认、diff 按需展开、hash 只进审计视图）、baseline 失败与批准时 CAS 失败两个分支的用户可见行为与下一步；修正 mermaid 顺序与节点语义。

## 二、应修改（定稿前完成，不改变方向）

| # | 问题 | 位置 | 修改要点 |
|---|---|---|---|
| S1 | 「人不同意 agent 建议」的纠正路径无落点，而纠正率是核心指标 | PRD §7.1/§10.1 | 明确两条路径：人直接落由人负责的相反 Decision；或带方向意见要求重提案（建议限 1 次），均进验收矩阵 |
| S2 | `/review` 的可用状态集合与并发/重入语义未定义 | PRD §6/§10 | 补状态×操作矩阵：非终态拒绝、已决 run 行为、同 run 单活动 review session、重试时 Fact Pack 复用与成本提示 |
| S3 | escalation 无反指标，保守化 escalate 可刷绿全部质量门 | PRD §13/§16 | 补误升级率（建议 ≤20%，至少观察指标）；unsupported 裁定含「blocking 定级不被证据支持」；风险表补 reviewer 保守化 |
| S4 | delegate eligibility 从未定义，含 manual_review 的 spec 在委托下处理空白 | PRD §7.2/§10.1/§13.2 | 给出封闭定义：v2 run + EVALS_PASSED + coverage complete + 无 manual_review 项（或人已录入结果）+ required agent_review 全 pass + 授权包络内 |
| S5 | 自动 Accept 实质修订一期「接受永远由人执行」承诺，未显式声明 | PRD §7.2；一期 PRD §3.2/§1.3 | 写明委托默认关闭、spec opt-in + 一次性 Authorization 双显式；变更记录声明有意修订，提示团队重新确认 defaultEnabled 前提 |
| S6 | recall 的 partial 归属未定义，结论可翻转 | PRD §13.1；技术设计 §11 | recall 分子 = exact + partial（第二人确认核心风险已指出）；unsupported 仅计 exact 否决 |
| S7 | 「terminal state」未定义投影，长 run（50 轮 rounds 即 50–75 KiB）会被 128 KiB 拒绝门系统性拒绝——恰是最需 review 的 STOPPED(exhausted) 场景 | 技术设计 §7.2/§7.3 | 定义 terminal state projection（status/stop_reason/candidate/计数/cost/hash）；rounds 明细归优先级 2 摘要 + manifest 索引；拒绝门只对 projection + spec + authorization 生效 |
| S8 | 1 MiB 累计预算超出 `claude -p` 实际上下文（≈270k–350k tokens > 200k），budget_limited 永远打不到，失败退化为 spawn/parse 错误 | 技术设计 §7.2 | 默认下调至 ~384–512 KiB；「上下文耗尽」定义为 budget_limited 的机械路径；Task 5.1 spike 实测 token 占用曲线后可修订数值 |
| S9 | provenance 生成与 draft_hash 冻结循环引用：按「finalized feedback」字面执行会在发布时改 hash、批准自我失效 | 技术设计 §3.5/§4.3/§10 规则 3 | provenance.feedback_hash = Feedback Pack 草稿内容 hash（content-addressed），draft 创建时一次生成进 draft_hash；gate 与发布只验证不重生成 |
| S10 | `--allow-shell` 迁移未定义 detach 运行期授权消费语义，可能破坏无人值守 | 技术设计 §5.2/§5.3；Task 3.3 | 写死：expiration 只在 claim 时刻检查，claim 后对整个 run 生命周期有效；claim 与项目锁同临界区、握手失败原子退还；revision baseline 按 draft_hash 绑定可重试不重新授权 |
| S11 | v1 golden fixture 存预解析 JSON，绕过 YAML 解析层，锁不住 parse 层漂移 | 实施计划 Task 2.1 | fixture 以 YAML 原文为输入经 `validateSpecText` 断言；补大写短 SHA、undefined 键、YAML 标量类型边角；加 lifecycle 级短 SHA 重算 hash 测试；覆盖清单与技术设计 §4.2 对齐（补 out_of_scope、键序/注释） |
| S12 | 实施计划缺失任务：Feedback Pack schema（M1 就要用）、manual_review 结果录入路径、status/report 对 decision 资产的展示、staging/fact-pack/授权的 GC 与卸载语义、legacy ACCEPTED run 分类、最小 `loop abandon` 人工直达入口、P2-11 manual honesty 的明确任务与验收、30% delegate-eligible 门槛承接、Task 6.2 指标枚举补 prompt injection | 实施计划 M1–M7 | 逐项补任务或并入既有 Task 验收标准 |

以及一致性核查确认的文档级修正：

- PRD §17「预授权终态自动 review」开放问题在技术设计与实施计划均无承接（悬空）；技术设计 §15.4（预算默认值验证）未进实施计划 §14——两边补齐归属。
- `input_manifest_hash` 被 proposal 与 agent_review 引用但全文未定义计算对象与 `fact_pack_id` 的关系——补定义（建议 = Fact Pack manifest canonical JSON 的 SHA-256）。
- Decision Record 的 `authorization_hash` 顶层与 `decided_by` 内两处位置不一致；幂等键含 `revision draft hash` 但 §3.1 schema 无该字段——统一落点。
- 幂等键含 `note` 的语义写明：note 不同即视为不同决定（或改为 note 不参与），避免各自理解。
- P2-02「既有 golden fixture」改为「Task 2.1 建立的 golden fixture」。
- Authority gate 规则 4 补「旧 spec 每个 id 必须在新 spec 中存在」（排除删除）；Authorization Record subject 补 `last_checkpoint` 字段（STOPPED run 的 candidate 为 null，规则 2 无判定依据）。
- `modify_manual_review` 等 constraints 布尔是否允许为 true 未定义——建议二期恒为 false 并注明。

## 三、范围与开放问题裁定建议

1. **M8 external feedback 移出二期**（产品与架构两路独立得出相同结论）：对 §13 任何指标零贡献、§10.4 路径未闭环（Feedback Pack 生成后如何被消费未定义）、一期已有人工转 spec 的路径。Feedback Pack schema 因 Revise 反正要建，三期再接 seam 成本很低。实施计划 M8 移除或标注三期占位。
2. **有界委托改承诺表述**：§11.1 改为「有界委托 shadow 与 authority gate；自动落决定的开放是 gate 数据触发的发布动作，不是二期承诺交付物」。理论验证（权限层判定是否正确）靠 shadow 即可完成。
3. **开放问题拍板建议**：二期首发仅显式 `/review`，不做终态自动 review（无人值守场景下自动生成不改善等待体验、STOPPED(canceled) 纯烧钱），待成本画像数据再评估；review 成本/时长的用户侧上限由产品现在定（建议：单次 ≤5 分钟、可取消、成本不高于一轮 worker invocation），模型选择留给 Task 5.1 spike。

## 四、建议（不阻断，可定稿后跟进）

- Command Manifest 不落第二份持久化 YAML，只持久化 hash，视图从 spec 按需派生（消除漂移面）。
- Fact Pack 128 KiB 内的 48/24/24/32 四段静态配额降级为实现常量，设计只承诺总额 + 裁剪优先级。
- `max_run_claims` 与 `one_shot` 双字段表达同一约束，留一个；`authorizations/` 与 `shell-authorizations/` 目录可合并为带 kind 的单 store。
- 原子 rename 实现守则：staging 与 committed 同父目录（同卷 APFS rename 原子成立）；**任何路径构造代码不得预创建空 `committed/` 目录**（空目录会被 rename 成功替换，破坏 first-wins），加故障注入 case；持久性口径沿用一期 fsync(2) 声明，不隐式抬高。
- §5 开头加威胁边界声明：shell authorization 只覆盖 spec 声明的 setup/eval 命令，worker 轮内 Bash 仍是一期已声明的 best-effort 面，避免 manifest hash 的严密感高估整体保证。
- Task 1.3/1.5/5.3 实际规模为 L，各拆一次；Task 2.1 与 M1 无技术依赖可并行；M4 对 M1 的依赖标注为策略性。
- P2-05「不读取 worker 私有对话」落为可机械检查的陈述（工具白名单不含 --resume/session 读取途径）。
- ADR/实施计划中的文档引用改为可点击 Markdown 链接（与 README 风格一致）。
- 二期 PRD 补变更记录一节，并显式引用「解除一期 §6.3 的 LLM reviewer 与 revise 边界」。

## 五、事实核查结论

以下声明经代码逐条验证**全部属实**：`resolveCommit`/`withEphemeralWorktree`/`tests/helpers.mjs` 已在 `68cbad3` 完成；一期基线 0.2.0 / HEAD 68cbad3；「一期不存在能力」清单（decision record、command manifest、fact pack 等抽查零命中）；acceptRun/shell gate/schema/statestore 的行为描述；回归命令路径；实施计划预计文件与现状零冲突；README 改动如实标注 Draft、未夸大能力。

## 六、总裁定

**不可定稿。** 修订路线：

1. 先决产品语义：R1（验证型 Revise）、R6（质量门口径）、R7（交互契约）、范围裁定三项——由产品定案后回填 PRD 与验收矩阵。
2. 同轮技术修订：R2–R5 及 S7–S11——不改变事务分层/byte-identical gate/Fact Pack 分层骨架，交 architect 回填技术设计。
3. 文档级修正（S12 与一致性清单）随同轮完成。

全部修订不需要重做方向，预计一轮修订可收敛，之后可转 Final 并进入 M1。

## 七、修订复核（第二轮）

对修订版四份文档的逐项复核结论：

- **R1–R7 七项阻断问题全部解决**，多项采用了强于评审建议的方案：R2 以 Review Operation Journal（prepared/committed）+ 完整键恢复矩阵 + `legacy_accepted` 分类 + `run_integrity`/`review_integrity` 分离解决；R3 定义 `withRunReviewLock` 与 `updateStateIfChecksum`（明示锁内 compare-and-write、非分布式 CAS）；R4 以 canonical Execution Plan（shell/argv/setup 同权）+ exact plan hash + Delegation Grant 解决，禁止前缀/正则/通配 allowlist；R5 定案 controller snapshot retrieval，reviewer 不给原生 Read/Grep/Glob；R1 验证型 Revise 三分支（P2-18~22）；R6 三类 case 隔离 + 盲评预登记时序 + 污染标记；R7 Approval Bundle 一次批准契约 + 状态×操作矩阵。
- **应修改与范围裁定 23 项：已落实 19、部分落实 4、未落实 0。** 剩余四个小缺口（均为一两句话补丁量级）：
  1. S1：人纠正 agent 建议的路径未进 PRD §14 验收矩阵（已落在 Task 5.3 验收）；
  2. S3：unsupported 裁定口径未纳入「blocking 定级不被证据支持」；
  3. S5：PRD §18 变更记录未声明对一期「接受由人执行」承诺的有意修订，未提示重新确认 defaultEnabled 前提；
  4. S10：「expiration 只在 claim 时刻检查、claim 后对该 run 生命周期有效」未显式写死。
- **复核裁定**：四个缺口不阻断 M1 开发（涉及 M5/M7 与文档层面），建议补齐后将三份 Draft 转 Final。

## 变更记录

- 2026-07-16：初版评审结论（三路并行评审 + 主评审交叉裁定）。
- 2026-07-16：第二轮修订复核——R1–R7 全部解决，23 项应修改/裁定项 19 落实 4 部分落实，结论改为「补齐四处小缺口后可转 Final 并进入 M1」。
