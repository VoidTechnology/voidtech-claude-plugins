# PRD：voidtech-loop 插件（Loop Engineering 工程内循环一期）

- **日期**：2026-07-15
- **状态**：Final
- **摘要**：新增独立插件 `voidtech-loop`，落地 Loop Engineering 的工程内循环：用户通过一行 `--check` 或 `goal-spec` skill 提交不可变 Goal Spec，确定性控制器在隔离 worktree 的专属分支上驱动 worker 逐轮工作，由控制器统一生成 checkpoint commit，并在一次性验收 worktree 中对指定 commit 执行机器可判定的 eval。eval 全部通过只产生 `EVALS_PASSED`，开发者复核后可 `accept`；不接受、预算耗尽或中断时，以任意已有 commit（通常是最后 checkpoint）作为 base 发起全新的循环。循环不自动修改用户分支，不自动 push、merge 或建 PR，合入永远由人执行。一期只提供固定 best-effort 隔离，但必须在报告中如实记录隔离等级、工具与网络能力，不承诺 OS 级文件系统或网络隔离。

## 1. 背景与问题

### 1.1 Loop Engineering 的三层循环

Addy Osmani 描述的 Loop Engineering 不是单一 agent 重试机制，而是三个时间尺度不同、相互嵌套的反馈循环：

| 循环 | 典型周期 | 参与者 | 一期覆盖 |
|------|----------|--------|----------|
| Agentic coding loop | 数分钟 | worker、构建/测试/eval | 完整覆盖，是一期核心 |
| Developer feedback loop | 数十分钟到数小时 | 开发者、规格与 eval | 覆盖最小闭环：复核、接受，或基于已有 commit 发起新循环 |
| External feedback loop | 数小时到数周 | 用户、生产数据、实验 | 不自动化，仅允许人工把证据转成新 Goal Spec |

一期不能宣称完整自动化 Loop Engineering。它要可靠解决的是最内层工程循环，并确保人的上下文优势不会被机器验收结论替代。

Claude Code 当前已内置 `/goal`、`/loop`、worktree、后台 agent、subagent 与 hooks。官方 `ralph-loop` 插件则展示了以 Stop hook 重喂 prompt 的早期循环方式。`voidtech-loop` 不重复发明“让 agent 再跑一轮”的能力，差异化价值集中在：不可变验收契约、独立控制平面、指定 commit 的确定性验收、逐轮 checkpoint、最小副作用边界和可审计交接。

### 1.2 团队现状与真实需求

`voidtech-core` 的 25 个技能全部是回合式：人发起、人盯守、人验收。成员想让 agent 长时间自主完成一项工作时，现状的绕行方案是人肉反复 prompt，人自己充当循环调度器和 QA。

真实需求不是“要一个循环插件”，而是：**让 agent 无人值守地推进工程任务，并可信地证明某个具体 commit 满足事先约定的规格与 eval。**

可信完成信号必须克制定义：

- `EVALS_PASSED`：指定 commit 通过当前 Goal Spec 的全部 target 与 invariant；
- `ACCEPTED`：开发者结合 manual review 与未被机器表达的上下文接受结果；
- `MERGED`：由人显式执行合入，不属于循环控制器的权限。

“eval 通过”不等于“任务绝对完成”，更不等于“产品方向正确”。

### 1.3 已确认的关键决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 独立插件还是并入 core | 独立插件 `voidtech-loop`，marketplace 默认启用（`defaultEnabled: true`） | 独立插件便于独立演进、失败不污染 core；团队决定默认启用以降低试点门槛（2026-07-16 覆盖原「按需安装」倾向，前提是一期严格保持不自动合入等安全边界） |
| MVP 循环类型 | 单任务 goal 式工程内循环 | 完成条件可机器判定，单人单任务即可产生价值 |
| 控制平面 | 确定性控制器独占状态迁移、checkpoint、验收启动与终态裁定 | worker 不能决定自己是否完成，也不能选择是否执行 checker |
| 循环驱动 | 每轮是一个有界 worker invocation；不以连续阻止 Stop hook 作为唯一调度机制 | Stop hook 有连续阻止上限，用户中断与 API 错误也不走同一路径 |
| 验收权威 | 控制器在一次性验收 worktree 中，对指定 commit 执行不可变 Eval Pack | 命令退出码与结构化结果是硬裁定 |
| worker 的 Git 权限 | worker 只允许只读 Git；所有 checkpoint commit 由控制器生成 | 把“每轮必须提交”和“禁止 push”从 prompt 约定提升为机制约束 |
| Goal Spec 变更 | 单次循环内不可变；修订等价于从指定 commit 发起一个全新循环 | 新 run ID、新 spec、新哈希比 epoch 链与分支接管更简单 |
| 中断语义 | 不实现 pause/resume；中断后干净终止并报告，继续工作时从最后 checkpoint 发起新循环 | 避免半吊子恢复协议猜测状态 |
| 状态地基 | 保留原子状态写入、项目锁、信号处理与干净收尾 | 它们是防并发与防孤儿进程的基础，不是可选恢复功能 |
| 隔离 | 一期固定 best-effort，不提供 strict 模式或可配置能力策略；报告必须如实记录实际工具与网络能力 | 避免不可控的 OS 沙箱工程量，同时不超卖安全承诺 |
| checkpoint 安全 | commit 前保留极简文件名与单文件体积闸门，不建设内容级 secret 扫描系统 | 自动 commit 拆掉了人工提交前看 diff 的闸门，需低成本防住高频事故 |
| Git 边界 | 不自动 push、merge、建 PR、rebase、删除分支或改写用户分支 | 合入与远端副作用永远由人执行 |
| 上游复用 | 不 vendor `ralph-loop`；优先组合 Claude Code 稳定原生能力，自行实现确定性控制器 | 避免继承 Stop hook 荣誉制度与状态限制 |

## 2. 目标用户、场景与指标

### 2.1 目标用户与场景

**目标用户**：VoidTech 团队工程师；已安装 `voidtech-core`，熟悉技能调用、Git worktree 与人工合入流程。

**主场景**：

- 修复某模块测试，直到固定命令退出码为 0；
- 将 TypeScript 严格模式错误降为 0，以 `tsc --noEmit` 退出码为 0 作为目标；
- 按 spec 实现接口，并通过不可变的契约测试；
- 迭代 UI，并通过项目已有的浏览器断言或截图差异命令。

**一期不服务**：

- 完成条件无法客观判定的探索任务，例如“让代码质量更好”；
- 依赖产品 taste、用户研究或跨团队决策才能判断完成的任务；
- 每日 CI 分诊等定时巡检；
- 多任务并行循环；
- 自动生产发布、A/B 测试或外部反馈采集；
- 需要开放网络、外部服务或自定义 worker 能力的任务；
- 需要相对基线指标（如“错误数较基线下降”）作为完成条件的任务。

### 2.2 成功指标

| 指标 | 口径 | 一期目标 |
|------|------|----------|
| 采用人数 | 上线 4 周内至少发起过 1 次有效循环的成员数 | ≥3 人 |
| 有效循环数 | 通过启动体检且至少完成 1 轮 checkpoint 的循环数 | ≥10 次 |
| 启动摩擦 | 四个主场景从任务描述到启动 worker 所需的用户输入 | 均可用一行 `--check` 启动，无需 YAML 或二次确认 |
| eval 假阳性 | `EVALS_PASSED` 后人工复核发现同一 commit 实际未满足 Eval Pack 的次数 | 首批 10 次为 0；样本 ≥30 后比例 <10% |
| 人工接受率 | `EVALS_PASSED` 后未修改代码即进入 `ACCEPTED` 的次数 / `EVALS_PASSED` 次数 | 首期记录基线，不设虚假阈值 |
| 失控副作用 | 自动修改用户分支、自动创建远端引用、两个循环互写同一 worktree 或越过固定能力边界的次数 | 0，出现即停止发布并复盘 |
| 合入回滚 | 循环产出合入后 2 周内因同一目标缺陷被回滚的次数 | 0，出现即补回归 eval 并复盘 |
| 资源画像 | 每次循环的迭代数、墙钟耗时与 token 可用性 | 首期记录分布，为后续预算默认值提供基线 |

指标默认保存在本机交接报告中；一期不新增外部遥测。团队复盘采用人工汇总的原始计数，避免以小样本百分比制造确定性。

## 3. 核心模型与架构

### 3.1 Goal Spec 与 Eval Pack

每次循环以不可变 Goal Spec 为事实来源。命令行简单模式最终也规范化为同一结构并计算内容哈希。

```yaml
schema_version: 1
goal_id: payment-tests
task: Fix failing tests in the payment module
base_commit: 0123456789abcdef
budgets:
  max_iterations: 25
  max_duration_seconds: 3600
protected_paths:
  - tests/payment/acceptance/**
evals:
  - id: payment-tests
    role: target
    command: [npm, test, --, payment]
    cwd: .
    expected_exit: 0
    timeout_seconds: 600
    repeat: 1
manual_review:
  - Confirm the public payment API remains source-compatible
out_of_scope:
  - Performance tuning beyond passing tests
```

规则：

- `goal_id`、`base_commit`、预算、protected paths、eval、manual review、out of scope 清单与可选 `setup` 命令（见技术设计 §12）进入哈希；`goal_hash` 为冻结副本规范化 JSON（键排序、UTF-8 编码）的 SHA-256；
- `base_commit` 默认是启动时的当前 HEAD，也可通过 `--base <commit>` 指向仓库内任意有效 commit；
- 简单模式把一条 `--check` 规范化为一个 target：`cwd` 为仓库根目录、期望退出码为 0、单条 eval 超时为 10 分钟、`repeat` 为 1；`max_duration` 未传时默认 60 分钟；
- 简单模式将 `--check` 按参数序列解析，不经过 shell；检测到管道、重定向、命令替换或控制运算符时拒绝并引导使用 Goal Spec 的显式 `shell: true`；
- 每条 eval 必须有稳定 `id`、`role`、超时、期望结果和工作目录；Eval Pack 至少包含一个 target；
- target 只支持绝对判定（命令退出码与结构化期望结果）；一期 schema 不含相对基线比较器，任何“candidate 优于 baseline”类表达均被 validator 拒绝，相对指标需求归入 out of scope；
- invariant 表达不得退化的守护条件，允许且要求在 base commit 上已经成立；
- `protected_paths` 使用 gitignore 通配语法，按与 `git check-ignore` 一致的语义匹配；
- `EVALS_PASSED` 要求所有 target 与 invariant 在 candidate commit 上同时成立；
- manual review 直接进入交接报告，不再启动额外 LLM reviewer；
- 作者草稿在启动前可编辑；正式启动时控制器复制到插件状态区并计算哈希，活动循环只信任冻结副本；
- 验收证据必须绑定 `goal_hash`、`candidate_commit` 与 eval ID。

### 3.2 控制平面与数据流

```text
Immutable Goal Spec + Eval Pack
                |
                v
      Deterministic Controller
       |        |         |
       |        |         +--> Atomic State + Project Lock
       |        +------------> Controller-owned Git Checkpoint
       v
Restricted Worker in Loop Worktree
       |
       v
Candidate Commit SHA
       |
       v
Disposable Verification Worktree
       |
       v
Deterministic Eval Runner
       |
       +--> Failed Evidence --> Next Worker Iteration
       |
       +--> EVALS_PASSED --> Report + Manual Review --> ACCEPTED
       |
       +--> STOPPED -------> New Goal from Any Commit
```

职责边界：

| 组件 | 可以做 | 不可以做 |
|------|--------|----------|
| 控制器 | 状态迁移、项目锁、创建 worktree、生成 checkpoint、启动 eval、写报告 | 修改业务代码、push、merge、建 PR、替用户接受结果 |
| worker | 搜索、读取、修改循环 worktree 内业务文件、运行获准命令 | Git 写操作、修改冻结 Goal Spec、写用户工作区、决定终态 |
| eval runner | 在一次性验收 worktree 中运行结构化命令、截断并收集证据 | 修改候选 commit、改变验收标准、解释产品 taste |
| 开发者 | 接受、从任意 commit 发起新循环、合入或丢弃 | 无限制；所有不可逆或远端动作只属于人 |

### 3.3 状态存储与项目锁

控制器状态存入插件专属数据目录下按 Git common directory 真实路径派生的项目目录。仅当 `${CLAUDE_PLUGIN_DATA}` 解析后的末级目录是 `voidtech-loop` 时采用该注入值；变量缺失或继承自其他插件时，控制器按官方公式自行推导 `~/.claude/plugins/data/voidtech-loop`。状态不进入循环分支，不受 worker 修改。状态文件采用“写临时文件、fsync、原子 rename”更新；同一项目的活动循环通过原子目录锁互斥，禁止 check-then-create。

状态至少包含：

- schema version、run ID、Goal Spec 冻结副本与哈希；
- 原项目路径、Git common directory、base commit；
- 循环分支、worktree 路径、最近 checkpoint commit；
- 当前状态、停止原因、迭代数、开始时间与累计耗时；
- 每轮 worker 结果、规范化 eval 结果与验收证据路径；
- 固定 best-effort 能力快照、权限拒绝记录与控制器 PID。

锁文件包含 run ID、PID 与启动时间。项目锁只覆盖 `RUNNING` 与 `VERIFYING` 的执行期；进入 `EVALS_PASSED` 或 `STOPPED` 时必须先终止子进程、原子写入状态与报告，再释放锁，使人工可以从 candidate 或最后 checkpoint 发起新循环。后续 `accept` 只原子更新对应旧 run 的状态与报告，不重新占用长生命周期项目锁，也不影响新的活动循环。新启动发现锁的 PID 已不存在时，不恢复旧循环：根据最后原子状态和 Git 事实生成 `STOPPED(interrupted)` 报告并释放陈旧锁。

### 3.4 最小状态机

```text
RUNNING -> VERIFYING -> RUNNING
                    -> EVALS_PASSED -> ACCEPTED

RUNNING | VERIFYING -> STOPPED(reason)

STOPPED | EVALS_PASSED
        -> new goal --base <commit>
        -> new run ID, branch, spec and hash
```

持久状态只有五个：

| 状态 | 说明 |
|------|------|
| `RUNNING` | worker 正在执行或等待下一轮 |
| `VERIFYING` | candidate commit 正在执行硬 eval |
| `EVALS_PASSED` | 机器验收通过，等待人工复核 |
| `ACCEPTED` | 人已接受结果，但仍未自动合入 |
| `STOPPED` | 循环终止；reason 为 `canceled`、`exhausted`、`interrupted`、`blocked` 或 `failed` |

checkpoint 是控制器动作，不是持久状态。`RUNNING` 与 `VERIFYING` 是活动状态，其他三个状态均不持有执行期项目锁。任何 `STOPPED` 都必须保留最近 checkpoint、循环分支和报告；系统不提供 `resume`，继续工作统一走新循环。

## 4. 核心用户路径

### 4.1 启动与 Goal Spec 编译

四个主场景都能一行启动：

```text
/voidtech-loop:goal "Fix failing payment tests" --check "npm test -- payment" --max-iterations 25
/voidtech-loop:goal "Eliminate TypeScript strict errors" --check "npx tsc --noEmit" --max-iterations 25
/voidtech-loop:goal "Implement payment contract" --check "npm test -- contract/payment" --max-iterations 25
/voidtech-loop:goal "Fix the typing flow UI" --check "npm run test:e2e -- typing-flow" --max-iterations 25
```

从已有工作继续时显式指定 base commit：

```text
/voidtech-loop:goal "Continue fixing payment tests" --base a1b2c3d --check "npm test -- payment" --max-iterations 15
```

多 target、invariant 或 manual review 等复杂任务由 `goal-spec` skill 引导，不要求用户手写 YAML：

```text
/voidtech-loop:goal-spec "Migrate payment to the new API, keep contract tests passing, and protect public fixtures"
```

`goal-spec` 交付经过 schema 校验和基线 dry-run 的作者草稿，并输出启动命令：

```text
.voidtech-loop/specs/payment-api-migration.yaml
/voidtech-loop:goal --spec .voidtech-loop/specs/payment-api-migration.yaml
```

`goal-spec` 是 Goal Spec 编译器，不是通用 YAML 编辑器：

1. 探查仓库已有测试、构建、CI 和项目规则，不发明不存在的命令。
2. 将每项要求归入 target、invariant、manual review 或 out of scope；相对基线类指标一期一律归入 out of scope 并提示二期支持；无法归类时才向用户确认。
3. 单 target 且可用一条安全命令表达的任务不生成 YAML，直接返回一行 `--check`。
4. 复杂任务补齐 protected paths、预算、cwd 与环境；需要网络、外部服务或自定义 worker 能力时拒绝并说明不属于一期。
5. YAML 草稿默认写入 `.voidtech-loop/specs/<slug>.yaml`；正式启动时控制器复制并冻结。
6. 调用与控制器相同的 schema validator 和 dry-run；禁止 skill 自行维护第二套字段规则。
7. 输出目标/不变量摘要、基线结果、固定 best-effort 能力、manual review 与准确启动命令；不得自动启动循环或修改业务代码。

启动体检任一项失败即拒绝：

1. 检查试点 OS、Claude Code 最低版本、hooks/后台或 headless 能力、Git、`jq` 及项目依赖；非试点 OS 直接拒绝，不静默运行。
2. 校验 Goal Spec schema、base commit、路径、预算、命令与超时；缺少 target 或包含相对基线比较器时拒绝。
3. 打印规范化 Goal Spec、完整命令和固定 best-effort 能力摘要后计算 `goal_hash`；简单模式命令即视为启动确认，不追加交互。`shell: true` 必须展示并单独确认。
4. 在 base commit 上执行基线 eval：任一 invariant 不成立时拒绝；所有 target 均已成立时拒绝并报告“目标在基线已满足”；至少一个 target 未成立且全部 invariant 成立时允许启动。
5. 检查 protected paths、仓库状态、submodule/LFS 与用户工作区未提交变更。循环只基于记录的 base commit，未提交用户变更不会自动进入循环。
6. 原子获取项目锁；已有活动循环时拒绝。
7. 创建唯一循环分支 `loop/<slug>-<short-id>` 与 worktree，写入初始状态；short-id 与既有分支碰撞时重新生成，不复用已有分支。

### 4.2 每轮执行与验收

1. 控制器启动一个有界 worker invocation，固定 cwd 为循环 worktree，并注入冻结 Goal Spec、上一轮失败 eval ID、规范化证据和最近 checkpoint。
2. worker 每轮只处理一个明确差距，动手前先搜索；Git 写操作、冻结 Goal Spec 写操作和越界路径写入由工具权限与 PreToolUse 机制 best-effort 拦截。
3. worker 返回后，控制器终止遗留子进程并执行确定性后置校验，任一不满足即 fail closed，不生成 checkpoint：worktree HEAD 必须仍等于最后 checkpoint（首轮为 base commit）且分支身份未变；Git 审计集与上一轮快照比对必须零变化，否则进入 `STOPPED(failed)`；protected paths 相对最后 checkpoint 出现 diff 时进入 `STOPPED(blocked)` 并报告命中路径。审计集 = 全部 refs（`refs/remotes/*` 的纯前进变化仅记录不终止）+ `.git/config`、`.git/info/attributes`、`.git/info/exclude`、hooks 目录清单与各 worktree `.git` 指针文件的内容哈希；控制器在每次自身 ref 变更（checkpoint、worktree 创建/销毁）后立即重拍快照，不维护豁免名单。校验通过后以工作树为准枚举待提交文件集合。
4. checkpoint 前执行极简闸门：待提交文件命中敏感文件名模式或单文件超过 10 MiB 时，不执行 `git add`/`commit`，进入 `STOPPED(blocked)` 并报告命中文件。
5. 闸门通过且有业务文件变更时，控制器使用禁用仓库 hooks 与自动签名的 Git 配置生成一次 checkpoint commit；无变更时记录 `no_change`，不生成空 commit。
6. 控制器以 checkpoint SHA 创建一次性验收 worktree（detached、使用加固 Git 配置），在凭据清理后的环境（不继承用户凭据类环境变量）中按 Eval Pack 执行命令；每条命令有超时与进程组清理。eval 执行前后对同一 Git 审计集做快照比对，出现变化即判本次验收无效并进入 `STOPPED(failed)`。
7. 每条 eval 的证据只保存 stdout/stderr 的前 256 KiB、后 256 KiB、总字节数与完整流 SHA-256；注入 worker prompt 的规范化摘要最多 32 KiB。超过上限直接流式丢弃，不建设磁盘预算系统。
8. eval 失败时，将失败 eval ID、退出码与规范化结果注入下一轮；全部 eval 通过时记录 `EVALS_PASSED`、生成报告并释放执行期项目锁。

### 4.3 接受、终止与重新发起

- `accept` 只能从 `EVALS_PASSED` 进入 `ACCEPTED`；manual review 项逐条原样出现在报告中，由人负责确认。该命令只更新旧 run，不阻塞或改变已从其 candidate 发起的新循环。
- `cancel`、预算耗尽、无进展、权限受阻、用户中断或控制器错误统一进入 `STOPPED(reason)`，生成报告并释放项目锁。`cancel` 幂等：对已处于 `STOPPED` 的 run 再次执行返回成功，不改变状态与报告。
- `STOPPED` 不提供 `resume`。报告给出最后 checkpoint SHA 和可直接执行的新 `goal --base <commit>` 命令；报告生成后向用户输出其绝对路径。
- 人工不接受 `EVALS_PASSED` 时，也以 candidate commit 为 base 创建新 Goal Spec 和全新循环；不接管原分支，不建立 epoch 链。
- 新循环拥有新的 run ID、循环分支、冻结 spec 与哈希；旧循环的 Git history 和交接报告构成足够的试点证据链。

## 5. 边缘状态与安全边界

### 5.1 中断与干净收尾

- 每次持久状态迁移与 checkpoint 后原子更新状态；不得承诺保留崩溃瞬间尚未 checkpoint 的内存或文件写入。
- SIGINT、SIGTERM、用户 `cancel` 或 worker API 错误时，控制器先终止完整子进程组，再写 `STOPPED` 状态与报告，最后释放锁。
- SIGKILL、断电或控制器崩溃无法执行收尾；下一次 `goal` 或 `status` 检测到陈旧 PID 后，仅依据最后原子状态与 Git checkpoint 终态化，不恢复未提交工作。
- 状态文件 schema 不支持、校验和不符，或状态、分支、worktree、HEAD 不一致时 fail closed：进入 `STOPPED(failed)`，保留分支与 worktree，不猜测修复。
- worktree 被手工删除不影响已提交 checkpoint；继续工作时从报告中的 commit 发起新循环。

### 5.2 验收失败与无进展

- eval 业务失败不重试 runner，直接打回 worker；基础设施超时或 runner 崩溃可自动重试 1 次，再失败则 `STOPPED(failed)`。
- 无进展使用结构化信号判定：连续 3 轮均无文件 diff，且失败 eval ID、退出码与规范化结果均未改善，进入 `STOPPED(blocked)`。
- 不能使用自由文本“理由相似”作为熔断依据；文本仅用于解释。
- eval 假阳性属于机制缺陷：保留 candidate commit、goal hash 与证据，补回归 eval 并触发复盘。
- Goal Spec 写弱但 eval 正确通过属于人工规格问题；manual review 与固定声明必须阻止报告把它包装成任务绝对完成。

### 5.3 资源与权限

- `max_iterations` 必须由用户显式提供；`max_duration` 必须是有限值，未传时默认 60 分钟。任一耗尽进入 `STOPPED(exhausted)`。
- 每条 eval 和 worker invocation 有独立超时；控制器必须按进程组终止子进程，避免 watch mode、server 或测试子进程泄漏。
- token 一期只记录与警告；宿主无法提供可信数据时报告 `unavailable`，不得估算伪装成精确值。
- 一期不跟踪或限制总磁盘占用；时间上限只能减少暴露时间，不构成磁盘安全保证。
- 同一规范化权限请求连续被拒 2 次后进入 `STOPPED(blocked)`；worker 不得改用等价命令绕过。
- 用户显式 `cancel`（经锁文件 PID 发 SIGTERM）始终优先于循环继续；交互会话的 Ctrl+C 只覆盖前台启动阶段，不达 detach 后的控制器。

### 5.4 checkpoint 闸门与 best-effort 隔离

checkpoint 前只检查本轮待提交文件，不扫描整个仓库：

- 文件名黑名单：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`；`.env.example`、`.env.sample`、`.env.template` 例外；
- 单文件体积阈值：大于 10 MiB 即阻断；
- 命中后不执行 `git add` 或 `git commit`，报告路径、规则和最后安全 checkpoint；
- 一期不做文件内容 token/secret 扫描，不把这个闸门描述成完整秘密检测系统。

固定 best-effort worker 能力：

- 允许仓库搜索、读取、编辑、写入和必要 Bash；禁止 Agent、WebSearch、WebFetch 与 MCP；
- 文件工具限制在循环 worktree；PreToolUse 拦截已知 Git 写命令与越界路径；
- Bash 是不可完全拆分的逃逸面，脚本、构建和测试仍可能写 worktree 外或访问网络；一期不宣称 OS 级文件系统或网络隔离；
- 报告必须列出实际工具集合、拦截器版本、隔离等级 `best_effort`，以及“Bash 网络访问无法由一期完全阻断”的明确声明；
- 仅靠命令正则和 reflog 不能证明没有 push 或外传；4.2 的每轮后置校验负责本地 Git 事实，网络外传只能由固定能力边界与人工复核兜底。

控制器所有 Git 调用统一使用加固配置：显式置空 `core.fsmonitor` 与 `core.hooksPath`，关闭仓库 hooks 与自动签名，防止 worker 写入的 Git 配置借控制器权限执行代码。循环绝不自动 push、merge、建 PR、删除分支或清理 worktree；清理由用户在报告复核后显式执行。

### 5.5 环境漂移与兼容性

- 记录 base commit、工具版本、关键依赖锁文件哈希和固定能力快照；交接时指出与启动基线的差异。
- 循环运行期间不得在同一仓库执行 Git 写操作：用户的 commit、切分支等会改动共享审计集并按 4.2 fail closed 终止（`refs/remotes/*` 纯前进变化仅记录），这是一期为可审计性接受的显式代价，启动确认与报告必须提示。
- 循环结束后基分支前进不影响已绑定 candidate commit 的验收结论；报告计算相对原 base commit 的差距，并提示由人决定 rebase、merge 或 cherry-pick。
- 与活动中的官方 `ralph-loop`、内置 `/goal` 或其他 Stop hook 循环存在调度冲突时拒绝启动；仅安装但未活动不应误报。
- 技术方案必须固定最低 Claude Code 版本与试点 OS allowlist。
- 一期试点 OS 为 macOS arm64；启动体检检测到其他 OS 或架构时直接拒绝并说明“未经一期验证”，不得 best-effort 继续。
- 一期 CI 只验证 macOS arm64；扩大 OS allowlist 必须先增加对应行为测试与 CI，不以文档声明代替验证。

## 6. 功能清单

### 6.1 一期范围（单一 P0）

| # | 功能 | 说明 |
|---|------|------|
| F1 | `goal` | 接受一行 `--check` 或 `--spec`，支持 `--base <commit>`，补齐默认时限并执行启动体检 |
| F2 | `goal-spec` skill | 把复杂任务编译为 Goal Spec；完成仓库探查、四类要求归档、schema 校验和基线 dry-run；简单任务降级为一行 `--check`，不自动启动 |
| F3 | 共享 schema 与 validator | skill、启动 gate 和控制器共用唯一 Goal Spec schema 与确定性 validator |
| F4 | 确定性控制器 | 驱动有界 worker、最小状态机、原子状态、项目锁、时间/迭代预算、进程清理与终态；worker invocation 必须可经测试配置替换为任意可执行文件（默认实现为非 bare `claude -p`） |
| F5 | 受限 worker | 固定 best-effort 能力，在循环 worktree 修改业务代码，但无 Git 写权、冻结契约写权和终态裁定权 |
| F6 | eval runner | 在一次性验收 worktree 对指定 commit 执行 Eval Pack，产生截断且绑定 SHA 的硬证据 |
| F7 | Git 与 checkpoint | 唯一循环分支、控制器 checkpoint、Git hooks/签名禁用、protected paths、敏感文件名与大文件闸门 |
| F8 | 终止与状态 | `status`、`cancel`、信号处理、陈旧锁终态化和完整交接报告；不提供 pause/resume |
| F9 | 接受与重新发起 | `accept`；从任意有效 commit 创建全新 run ID、分支、spec 与哈希 |
| F10 | 交接报告 | 任何 `EVALS_PASSED`、`ACCEPTED` 或 `STOPPED` 都生成字段固定的报告 |

### 6.2 交接报告固定字段

- run ID、状态、stop reason、Goal Spec 与 `goal_hash`；
- base commit、candidate 或最后 checkpoint commit、循环分支与 worktree；
- 每轮与 checkpoint commit 对照；
- 每条 eval 的命令、退出码、耗时、截断摘要、总字节数、SHA-256 与证据路径；
- manual review 与 out-of-scope 清单；
- protected paths、checkpoint 闸门和 Git 引用审计；
- 固定 best-effort 能力：工具集合、拦截器版本、网络与文件系统限制；
- 迭代数、墙钟耗时与 token 可用性；
- 中断、熔断、失败或预算耗尽原因；
- 基分支漂移、人工合入建议和从最后 commit 重新发起的完整命令；
- 固定声明：`EVALS_PASSED` 不等于 `ACCEPTED`，一期不提供 OS 级强隔离，循环未自动合入；审计快照只能发现留下痕迹的篡改；eval 进程仍可经 keychain 与用户配置文件获取凭据，网络外传不受阻断；报告与证据存于插件数据区，卸载插件会一并删除。

### 6.3 明确不做（一期边界）

- `revise`、epoch、同分支接管或跨 run 状态链；
- pause/resume 与未提交工作恢复；
- LLM risk reviewer；manual review 直接来自 Goal Spec；
- strict 隔离模式、OS 级沙箱和可配置能力策略；
- 文件内容 token/secret 扫描、通用大文件策略引擎；
- 相对基线比较类 eval（candidate 优于 baseline）；
- 总磁盘预算、磁盘用量追踪或配额系统；
- 非 macOS arm64 的运行与 CI；
- 定时 / proactive 巡检、Meegle 集成、并行多循环或循环内任务队列；
- 自动 push、merge、建 PR、rebase、发布或部署；
- 自动收集生产数据、客户反馈或执行 A/B 测试；
- 跨 Codex 等其他编码工具支持；
- 浮动版本的外部运行时或要求团队额外安装的循环工具链。

## 7. 验收标准

| # | 标准 | 验证方式 |
|---|------|----------|
| V1 | 缺 `max_iterations` 时拒绝；缺 `max_duration` 时规范化为 3600 秒 | 分别省略字段执行简单模式与 Goal Spec 模式 |
| V2 | 非法 schema、缺 target、无超时命令、非法 cwd、包含相对基线比较器或 protected_paths 含 `!` 否定模式时拒绝 | 参数化 schema fixture |
| V3 | Goal Spec 启动后冻结并绑定哈希；修改作者草稿不影响活动 run | 启动后修改 `.voidtech-loop/specs/` 文件并校验状态区哈希 |
| V4 | 全部 target 基线已满足时拒绝；invariant 基线失败时拒绝；目标未满足且 invariant 成立时允许 | 参数化三类基线 fixture |
| V5 | 四个主场景均可用一行 `--check` 启动，无需 YAML、`max_duration` 或二次确认 | 四个最小项目 fixture |
| V6 | `goal-spec` 对简单任务返回一行 `--check`；对复杂任务生成四类归档完整且通过共享 validator/dry-run 的 YAML | 分别执行简单与复杂任务 fixture |
| V7 | skill、启动 gate 与控制器使用同一 schema 和 validator，不存在独立字段规则副本 | 静态检查资源引用并比较合法/非法 fixture 结果 |
| V8 | 两个进程同时启动同一项目时只有一个获得项目锁，且只创建一个活动 worktree | 并发集成测试 |
| V9 | 非 macOS arm64 在创建分支或 worktree 前被拒绝，并输出“未经一期验证” | 模拟 uname 结果执行启动体检 |
| V10 | worker 尝试 Git 写、修改 protected path、写原工作区或调用禁用工具时被 best-effort 机制拦截并留证 | 以工具调用 JSON 直接驱动 PreToolUse hook 的单元 fixture |
| V11 | 待提交文件命中敏感文件名或大于 10 MiB 时不产生 checkpoint，并报告规则与最后安全 commit；例外模板文件允许 | 参数化文件名与体积 fixture |
| V12 | checkpoint 仅由控制器生成，不执行仓库 Git hooks、交互式签名或空 commit | 配置标记 hook 与强制签名后运行有变更/无变更轮次 |
| V13 | eval 始终在 candidate SHA 的一次性 worktree 运行，不能修改 worker worktree | eval 主动写文件并检查两个 worktree |
| V14 | eval 证据按前后各 256 KiB 截断，记录总字节数与完整流 SHA-256；worker 摘要不超过 32 KiB | 生成多 MiB stdout/stderr fixture |
| V15 | eval 失败把绑定 eval ID 的规范化证据注入下一轮；全部通过只进入 `EVALS_PASSED`，生成报告并释放项目锁 | 完整失败后成功路径，并立即从 candidate 发起新循环 |
| V16 | `accept` 只能从 `EVALS_PASSED` 进入 `ACCEPTED`；manual review 完整进入报告 | 对所有状态参数化执行 `accept` |
| V17 | SIGINT、SIGTERM 与 `cancel` 均终止子进程组、写 `STOPPED` 报告并释放项目锁 | 在 worker 与 eval 阶段注入信号 |
| V18 | 陈旧 PID、状态损坏或 Git 事实不一致时不恢复旧循环，fail closed 并保留最后 checkpoint | 构造陈旧锁、坏校验和与 HEAD 偏移 |
| V19 | 迭代/时间耗尽、连续 3 轮无进展或权限连续拒绝进入正确 `STOPPED(reason)`，报告包含最后 checkpoint | 参数化三类终止路径 |
| V20 | `--base` 接受仓库内任意有效 commit，创建新的 run ID、分支、冻结 spec 与哈希；旧循环状态不被修改 | 从 `EVALS_PASSED` 与 `STOPPED` 的 commit 分别发起新循环 |
| V21 | 报告明确标注 `best_effort`、实际工具、拦截器版本和 Bash 网络限制；用户分支与远端引用前后不变 | 完整 happy path 后检查报告与 Git 引用快照 |
| V22 | macOS arm64 上插件严格校验、行为测试、portability 与 skill-closure 审计全部通过 | 单平台 CI 运行仓库既有及新增审计 |
| V23 | worker 借 Bash 绕过拦截移动 HEAD、改写 refs、篡改 gitdir 审计集或修改 protected path 后，控制器后置校验 fail closed 进入对应 `STOPPED`，不生成 checkpoint 也不进入验收 | 经测试接缝注入 stub worker，执行 `git update-ref`、切分支、改 `.git/config` 与改写 protected path 的 fixture |
| V24 | eval 命令尝试修改共享 Git 目录审计集时，本次验收判无效并进入 `STOPPED(failed)`；eval 环境不含用户凭据类环境变量 | eval 内执行 Git 写操作并打印环境变量的 fixture；凭据断言以 §8.4 环境变量白名单为依据 |

## 8. 技术方案必须定案的问题

以下问题不改变产品边界，但必须在编码前形成 ADR 或技术设计结论：

1. **worker invocation（spike 已完成，见 `docs/spike-worker-invocation-2026-07-15.md`）**：选型定案为非 bare `claude -p` + `--allowedTools` 白名单 + 项目级 PreToolUse hooks。凭据复用、hooks 生效与硬 deny、SIGTERM=143 / SIGINT=0、连续 10 轮稳定均已实测通过；`/goal`（evaluator 为模型判定且不执行命令）与 `--bare`（跳过 hooks/plugins 且不读 OAuth/keychain）均排除。官方已预告 `--bare` 未来会成为 `-p` 默认值，实现必须显式传参并钉死版本下限（候选 2.1.210）。会话连续性已实测定案：每轮全新 `claude -p` 为默认——有界、无跨轮上下文污染，符合有界 invocation 模型；`--resume` 实测可用且因缓存命中更便宜，记录为二期优化选项，凭一期资源画像数据再议。
2. **版本与试点环境**：固定最低 Claude Code 版本、macOS arm64 最低系统版本、`uname`/架构检测方式，以及 Git 最低版本（refs 快照与 worktree 行为依赖）。
3. **固定 best-effort 权限**：确定 worker 工具列表、PreToolUse 规则、Bash 逃逸限制与报告中的标准免责声明；不设计通用策略 DSL。
4. **命令协议**：简单模式字符串到 argv 的可移植解析与拒绝字符集，以及显式 shell、环境变量白名单、submodule/LFS 和 monorepo cwd 的精确定义。白名单定案时一并决定是否对 eval 设 `GIT_CONFIG_GLOBAL=/dev/null` 以切断 keychain credential helper（便宜有效，但需验证对测试套件的副作用）。
5. **规范化 eval 结果**：为常见测试框架优先提取失败测试 ID/错误数；未知命令退化为退出码与清理时间戳、临时路径后的摘要。
6. **checkpoint 与 Git 审计实现**：checkpoint 使用独立临时 index 构建（`GIT_INDEX_FILE` + read-tree/add/write-tree/commit-tree/update-ref），不信任 worker 留下的 per-worktree index；待提交文件枚举与 10 MiB 体积以工作树为准。审计快照用 `git for-each-ref` 加各 worktree 的 symbolic-ref/rev-parse 两元组实现，不直接读 packed-refs，pseudo-refs（FETCH_HEAD/ORIG_HEAD）排除在不变量外。protected paths 匹配用冻结 pattern 文件驱动 `ls-files --exclude-from` 类 plumbing 组合，validator 拒绝含 `!` 否定模式的 spec。外加控制器 Git 命令白名单与加固配置（见 5.4）。
7. **原子状态与陈旧锁**：确定 fsync/rename 顺序、PID 存活检测（PID 叠加进程启动时间比对）、信号陷阱和 crash 后终态化报告的最小可信字段。陈旧锁接管须先将锁目录原子 rename 为唯一 tombstone（仅一个进程能赢），赢家负责终态化；锁内元数据以临时文件 + rename 写入，读者对空锁目录按“创建中”等待短宽限期。一期以 fsync(2) + rename 保证原子性，不追求 F_FULLFSYNC 掉电持久性，损坏由校验和检出并终态化。
8. **token 统计**：确认宿主是否提供逐轮可信 usage；不可用时保持 `unavailable`，不阻塞一期。
9. **Goal Spec 作者文件**：确定 `.voidtech-loop/specs/` 的默认 `.gitignore` 建议与 spec 中允许保存的非敏感元数据；活动 run 始终只信任插件状态区冻结副本。
10. **实现语言与分发**：shell+jq 已排除——shell 无法对指定 fd 执行 fsync，也写不出二进制安全的流式截断；候选收敛为 Node 脚本 vs 钉版本 Agent SDK，与第 1、11 条结论联动。必须满足 6.3 的自包含约束，不引入浮动版本外部运行时，并定义 macOS arm64 CI job 的触发路径过滤。
11. **控制器宿主与生命周期（spike 已完成，见 spike 报告第二轮）**：定案为 detach 守护进程——`goal` 完成前台准备后派生脱离会话的控制器，并等待其通过专用 IPC 回报 ready；只有锁与状态身份接管成功才返回 run ID。握手失败统一写入终态并释放锁。实测确认：被 launchd 收养（ppid=1）、无 TTY 的进程可正常调用 `claude -p` 且凭据可用；SIGTERM 经锁文件 PID 送达并被信号陷阱干净收尾。设计后果：宿主会话关闭不影响循环（与无人值守目标一致）；交互会话的 Ctrl+C 不达守护进程，运行期中断统一走 `cancel`。
12. **验收 worktree 依赖策略**：`setup` 是进入 `goal_hash` 的 shell 命令字符串数组，在基线、循环与每次验收的干净 worktree 中各执行一遍；产物必须由 `.gitignore` 覆盖。`goal-spec baseline` 与 `loop goal` 共用 shell 确认门，只有显式 `--allow-shell` 后才执行。预热安装、APFS clonefile 或其他缓存只能作为未来性能优化，不得改变命令执行次数、candidate 绑定或可观察语义。

## 9. 来源

- Addy Osmani, [Loop Engineering](https://addyosmani.com/blog/loop-engineering/)（Agentic coding、Developer feedback、External feedback 三层循环）
- Claude Code, [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)（原生 `/goal`、恢复、token 与独立 evaluator）
- Claude Code, [Hooks reference](https://code.claude.com/docs/en/hooks)（Stop、StopFailure 与 worktree 事件语义）
- Claude Code, [Create custom subagents](https://code.claude.com/docs/en/sub-agents)（工具、权限与 worktree 隔离限制）
- Geoffrey Huntley, [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/)（每轮一事、搜索先行、无进展跑偏）
- [anthropics/claude-plugins-official · ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)（Stop hook 循环的历史参考，不作为一期运行时依赖）

## 变更记录

- 2026-07-15：初稿（Draft），确认独立插件、goal 式一期与人工合入边界。
- 2026-07-15：第一次评审修订——Git 边界从“循环零 commit”改为“逐轮 checkpoint commit + 禁止离开 worktree”。
- 2026-07-15：第二次架构评审修订——引入确定性控制器、不可变 Goal Spec/Eval Pack、指定 commit 验收与机器/人工双层完成语义，移除不可兑现的本机与 reflog 安全假设。
- 2026-07-15：第三次逻辑评审修订——为 eval 增加 target/invariant 角色，修复基线比较类 eval 与启动体检的冲突。
- 2026-07-15：第四次采用率评审修订——增加低摩擦简单模式、60 分钟默认时限和四个一行 `--check` 主场景。
- 2026-07-15：第五次复杂任务体验评审修订——新增 `goal-spec` skill 与共享 schema/validator，避免用户手写复杂 YAML。
- 2026-07-15：第六次范围收敛——保持单一 P0，不做内部 P0a/P0b 分层；移除 revise/epoch、risk reviewer、strict 双模式、可配置能力策略、磁盘预算、完整 pause/resume 与非试点 OS CI；保留原子状态、项目锁、干净收尾、极简 checkpoint 闸门与证据截断；新增从任意 commit 发起全新循环的统一恢复路径。
- 2026-07-15：第七次可编码性评审修订——4.2 增加 worker 返回后与 eval 前后的确定性后置校验并 fail closed，新增 V23/V24；一期移除相对基线目标，schema 不含相对比较器；钉死 `out_of_scope` 字段、`protected_paths` 的 gitignore 语义与 `goal_hash` 的规范化 JSON SHA-256 定义；补 `cancel` 幂等与循环分支碰撞处理；§8.1 依官方文档查证收敛为非 bare `claude -p` 与 Agent SDK 双路径 spike，新增 §8.10 实现语言与分发。
- 2026-07-15：第八次工程评审修订（依 architect 评审与 spike 实测）——refs 快照扩为 Git 审计集（含 `.git/config`、attributes、hooks 目录、worktree 指针），豁免名单改为控制器自身变更后立即重拍快照；5.5 明确循环期间用户 Git 写操作 fail closed 的取舍（`refs/remotes/*` 纯前进除外）；控制器 Git 调用统一加固配置，checkpoint 改用独立临时 index；F4 增加 worker invocation 测试接缝，V10/V23/V24 验证方式改为可确定复现的 fixture；§8.1 回填 spike GO 结论并遗留会话连续性测项，新增 §8.11 控制器宿主与生命周期、§8.12 验收 worktree 依赖策略，§8.10 排除 shell+jq；6.2 固定声明补审计快照局限、keychain 凭据路径与证据随卸载删除的提示。
- 2026-07-15：第九次 spike 回填——§8.11 定案 detach 守护进程宿主模型（launchd 收养后 `claude -p` 与凭据实测可用，SIGTERM 经锁文件 PID 可达）；§8.1 会话连续性定案为每轮全新调用，`--resume` 记为二期优化；5.3 明确运行期中断统一走 `cancel`，Ctrl+C 只覆盖前台启动阶段。
- 2026-07-15：转 Final——§8 十二项在 `docs/tech-design-voidtech-loop-2026-07-15.md` 全部定案；3.1 哈希规则纳入技术设计新增的可选 `setup` 字段（验收依赖 warm 安装命令）。
- 2026-07-16：F1–F10 实现完成并双路径真实 worker dogfood 通过（简单 `--check` 与复杂 `--spec` 均达 EVALS_PASSED，用户分支/protected path/main 均未被触碰）；插件注册进 marketplace 并按团队决定 `defaultEnabled: true`，1.3 决策行与 portability install-smoke 同步更新。
- 2026-07-16：一期 1.1 收尾——setup 定案为每个干净 worktree 都执行的稳定语义，预热与 clonefile 降级为不改变语义的未来优化；baseline 与正式启动共用 shell 确认门；detach 启动增加 ready 握手与失败终态化；插件数据目录拒绝继承其他插件的注入路径。
