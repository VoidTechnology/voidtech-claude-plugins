# 任务:盲评 case registry 接线到 loop CLI

- **日期**:2026-07-17
- **状态**:Draft(待工程认领)
- **归属**:voidtech-loop 二期,M7 有界委托的前置解锁
- **一句话摘要**:M6 已交付的 case registry 库函数尚未接到任何 loop 命令,导致「≥30 合格盲评 case」的数据无法被采集。本任务把 enroll → 锁参考 → 揭示 → 裁定全链路接到 CLI,并补齐 enroll 所需的机械包络分类器,使一次完整盲评能被命令走通、乱序被机械拒绝。

## 背景与问题

M7(agent 自动落决定)的开放门是纯数据驱动:≥30 个合格未污染 blind case 且质量门全 PASS(见 `guide-voidtech-loop-blind-review-2026-07-17.md`)。但现状是:

- `scripts/lib/reviewcaseregistry.mjs` 的 `enrollCase / lockReference / recordAgentResult / revealAgentResult / recordAdjudication` **有实现、有单测(`tests/review-case-registry.test.mjs`),但没有任何 `loop.mjs` 命令调用它们**。命令层仅 goal/status/cancel/accept/abandon/review/approve。
- `enrollCase` 要求传入 `support_envelope`,而该包络的注释口径是「由独立机械分类器输入(diff 体积、二进制、可用来源、delegate eligibility),不读 agent 自报结果(P2-29)」——**这个分类器目前不存在**,单测里的 envelope 是手工构造的。

**后果**:那份 Final 团队指引描述的日常流程,现有工具无法持久化任何一步。没有这道管道,「等数据」是空谈——corpus 目录永远是空的。

## 目标

让一名发起人 + 一名交叉 reviewer 能**只用 loop 命令**完成一次合格盲评的采集与裁定,且盲评时序(reference 必须先于 agent 结果揭示)由工具机械保证,人记错顺序时被拒绝而非污染数据无声通过。

## 范围

### 做

1. **机械包络分类器**:从终态 run 的已持久化事实包(Fact Pack / manifest,`reviewfactpack.mjs`、`reviewcontext.mjs` 已算出 diff 文件、增删行、binary 标记)计算 `support_envelope`,**不读 agent 自报**。输出字段对齐现有 schema:`{ in_envelope, delegate_eligible, diff_bytes, binary_changes, sources_complete, computed_from }`。
2. **四个命令接线**(命令名可议,行为不可议):
   - `loop enroll <runId> --kind <blind_dogfood|calibration_seeded|boundary_synthetic> [--seeded <file>]`
   - `loop lock-reference <runId>`(采集交叉 reviewer 的结论三件套)
   - `loop review <runId>`(**改造既有命令**:产出 proposal 后把 agent 结果记入并揭示对应 case)
   - `loop adjudicate <runId>`(采集逐条 finding 裁定 + 两个全局判断)
3. **端到端测试**:证明正序可走通、各类乱序被拒,且既有库层不变量经 CLI 仍生效。

### 不做

- 不重新实现 registry 库层不变量(库已强制,本任务只暴露/接线,不复制逻辑)。
- 不改盲评协议本身(时序、gate 资格口径、质量门指标沿用 P2-23 / review-quality.mjs)。
- 不做 reviewer 身份的密码学校验(见开放问题 2)。
- 不自动触发任何决定或新 run(建议模式约束不变)。

## 行为规格(输入 → 行为 → 错误)

> 通用:所有命令走 `node ${CLAUDE_PLUGIN_ROOT}/scripts/loop.mjs <cmd>`;case 以 `runId` 为锚定键查找;corpus 未登记的 run,review 行为与今天完全一致(采集是 opt-in)。

### 1. `loop enroll <runId> --kind <k> [--seeded <file>]`

- **前置**:run 必须为终态(`EVALS_PASSED` / `STOPPED`);该 runId 尚未登记过 case。
- **行为**:调机械分类器算出 envelope → `enrollCase(...)` 冻结 kind + envelope(+ seeded 预期);打印 case_id、kind、in_envelope、delegate_eligible。
- **错误**:非终态 run → 拒绝并提示;kind 非法 → 拒绝;runId 已有 case → 拒绝(`case_exists`);kind=calibration_seeded 但缺 labels/expected → 拒绝;命中 secret 字面量 → 拒绝(库已做,需把 reason 如实透传)。

### 2. `loop lock-reference <runId>`

- **前置**:case 已 enroll;**agent 结果尚未揭示**;本 case 尚无 reference。
- **行为**:采集交叉 reviewer 的**结论三件套**——`outcome`(accept/abandon/revise)、`blocking_findings[]`、`must_escalate`(及 `escalations[]`)——写入 `by` 来源标记后调 `lockReference(...)`。
- **错误(关键)**:若 agent 结果已揭示 → **拒绝并把 case 永久标记污染**(库已做 `reference_after_reveal`,CLI 必须把这个结果显著告知,不能吞掉);已锁过 reference → 拒绝;secret → 拒绝。

### 3. `loop review <runId>`(改造)

- **保留**:现有 fresh-session 独立审查、proposal 持久化、建议模式一切行为不变。
- **新增**:`runSuggestionReview` 产出 proposal 后,若该 runId 有已登记 case,则以 proposal 的 `proposalHash / inputManifestHash / recommended_outcome / coverage_status / escalated` 调 `recordAgentResult(...)`(揭示时刻 = 展示时刻)。
- **保护(见开放问题 1)**:若 case 已 enroll 但**未锁 reference**,默认**拒绝 review 并提示「先锁参考,否则该 case 将无法进入 gate」**,除非显式 `--force`(强制则该 case 事后不可再锁 reference)。

### 4. `loop adjudicate <runId>`

- **前置**:agent 结果已揭示。
- **行为**:采集每条 agent finding 的 `exact/partial/missed/unsupported`,以及两个全局判断 `material_override`(人是否实质推翻 agent 结论)、`critical_miss`(是否漏掉必须升级项),调 `recordAdjudication(...)`。
- **错误**:未揭示 → 拒绝(`not_revealed`,库已做)。

## 验收标准(可逐条判真伪)

1. **正序全链路走通**:在一个有真 eval 的样例 run 上,依次执行 `enroll → lock-reference → review → adjudicate` 四条命令后,该 case 的 `isGateEligible(record)` 返回 `true`,且 `review-quality.mjs` 报告把它计入 blind 分母。
2. **乱序被机械拒绝**(每条独立可测):
   - 先 `review`(揭示)后 `lock-reference` → 命令非零退出,case `contaminated=true`、`contamination_reason='reference_after_reveal'`,且**终端明确显示该 case 已污染作废**。
   - 未 enroll 直接 `lock-reference` / `adjudicate` → 拒绝。
   - 未揭示就 `adjudicate` → 拒绝。
   - 对已揭示的 case `enroll` 改 envelope / 重复 enroll → 拒绝(`case_exists` / `frozen_after_reveal`)。
3. **包络不读 agent 自报**:分类器的输入仅来自 Fact Pack / manifest / git diff;新增测试断言其输出不随 agent proposal 内容变化(P2-29)。
4. **既有不变量经 CLI 仍生效**:enroll 的 secret 拒绝、seeded 预期必填、kind/envelope 揭示后冻结,均有一条经命令层(而非直接调库)触发的测试覆盖。
5. **opt-in 不回归**:未登记 case 的 run 跑 `loop review`,行为与本任务前逐字节一致(现有 review 测试全绿)。
6. **一条端到端测试**能自动跑完验收 1 + 验收 2 的全部乱序分支(挂在 `tests/` 下,`node --test` 通过)。

## 开放问题(附推荐默认)

1. **enroll 后未锁 reference 就 `loop review`,该拦还是该放?**
   推荐默认:**拦(refuse + `--force` 逃生阀)**。理由:review 一揭示,未锁的 reference 就永远无法合格,拦下来是保护发起人不无声烧掉一个 case;`--force` 留给「我就是不想登记这条了」的情况,强制后该 case 失去锁参考资格。
2. **交叉 reviewer 身份怎么保证「没看过 agent 结果」?**
   推荐默认:**本地 CLI 只做时序机械保证 + 如实记录 `by` 来源(honor-system,`identity_verified:false`)**。理由:单机 CLI 无法密码学验证「是不是同一个人」,真正的硬保证是「reference_locked_at < revealed_at」这条时间序,身份靠团队流程约束(指引已写明「发起人看过结论后不能当 reviewer」)。不要把工具做不到的说成做到了。
3. **`delegate_eligible` / `in_envelope` 的判定口径是否已在二期 tech-design(P2-29)落到可实现粒度?**
   推荐默认:**直接复用既定口径**;若该口径只到概念级(未给出 diff 体积阈值、sources_complete 的具体判据),则**本任务第一步先把口径补到可实现**,并回写 tech-design,再动分类器代码——不由实现者临场拍阈值。

## 完成的意义

这道管道一通,「等数据」才第一次变成真的可以等——发起人 + 搭子每跑一个终态 run,多花约 10 分钟就能沉淀一条合格 case。在此之前,M7 的门等的不是数据,是这段没接的线。
