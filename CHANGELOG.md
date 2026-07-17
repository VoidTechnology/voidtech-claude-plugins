# Changelog

## voidtech-loop 0.3.0 - 2026-07-17

二期 Agent-first Review 建议模式交付：独立审查 agent 完成评审劳动，人保留方向权与否决权；全部决定由人显式执行，新 run 永不自动启动。有界委托（自动落决定）本版**未开放**，等待盲评质量门数据（≥30 合格 blind case 全门 PASS）。

### Added

- 新命令 `loop review <runId>`（及 `/voidtech-loop:review` 技能）：对终态 run 启动 fresh、无工具、只读冻结事实的审查 agent，产出结构化建议与证据引用；不同意可 `--direction` 带方向重提案（每 run 最多一次，原 proposal 保留）。
- 新命令 `loop approve <runId> [--approve-execution] [--manual-passed]`：展示并一次批准 Revision Draft（来源、变化摘要、未映射内容、完整执行计划；hash 只进审计视图）。verification-only 草稿验证通过直接接受原 run（不建新 run）；coding 草稿经 baseline 后原子冻结并只输出显式启动命令。
- 新命令 `loop abandon <runId> [--reason]`：不经 reviewer 直接放弃终态 run；不修改执行事实，只追加 Decision Record。
- Goal Spec v2（`agent_review` / `review_policy` / `provenance`）与 v1 严格共存：v1 canonicalization 与 `goal_hash` 逐字节兼容（golden 集锁定），简单模式继续生成 v1，未知版本拒绝。
- 审查控制面新地基：Review Operation Journal（prepared/committed + 崩溃恢复矩阵）、per-run review lock、decision slot（first-finalized-wins、幂等/冲突）、Approval Bundle 版本化 conditional hash match、Revision/Supplemental Bundle 同目录原子发布、canonical Execution Plan 与 Delegation Grant（exact plan hash，本版仅存储与判定器，未接入自动决定）。
- Review Fact Pack（manifest + 预算化 controller retrieval + candidate snapshot 路径边界）与 Review Proposal 契约（无可执行字段、evidence ref 必须解析到冻结事实）。
- 盲评质量基建：预登记 case registry（reference 先于揭示、污染标记、揭示后冻结）与 `scripts/review-quality.mjs` 分层指标报告（blind/seeded/boundary 隔离、原始计数、GO/NO-GO/INSUFFICIENT）。
- reviewer invocation spike 报告：`--tools ""` 是唯一有效的整体工具移除（`--allowedTools ""` 只是权限门，只读 Bash 仍会执行）；执行事实一律以 controller 计账为准，不采信 reviewer 自述。

### Changed

- `accept` 迁入事务层：保留 `EVALS_PASSED -> ACCEPTED`，同时生成外部 Decision Record（`decided_by` 诚实区分 human/agent，`identity_verified: false`）；重复 accept 从拒绝改为幂等返回既有决定；spec 含 `manual_review` 时需 `--manual-passed` 逐项显式确认。
- `status` 与报告分别呈现 `run_integrity` 与 `review_integrity`；一期已 accept 的存量 run 按 `legacy_accepted` 读取，不补造 Decision Record。
- `--allow-shell` 语义升级：确认对象从布尔开关变为完整 canonical Execution Plan（shell/argv/setup 同权进 hash），确认即批准该精确计划；CLI 表面契约不变。
- review 功能要求 Claude Code ≥ 2.1.211（`--tools` 语义经实测验证）；`goal` 等一期功能版本要求不变。

### Fixed

- evalrunner：子进程 spawn 失败时 `error`+`close` 双事件二次 finalize 抛 `ERR_CRYPTO_HASH_FINALIZED` 导致控制器 uncaughtException 崩溃；改为幂等 settle 并补回归测试。

## voidtech-loop 0.2.0 - 2026-07-16

### Changed

- 将 `setup` 定案为 Goal Spec 的稳定语义契约：在基线、循环与每次验收的干净 worktree 中各执行一遍，产物必须由 `.gitignore` 覆盖；预热安装与 APFS clonefile 降级为不改变语义的未来性能优化。
- `goal-spec baseline` 与 `loop goal` 共用 shell 确认门；含 `shell: true` eval 或 `setup` 的规格必须经 `--allow-shell` 明确确认后才会执行。
- 准备阶段在 setup 前落盘初始状态；setup 或后台握手失败时统一写入可信终态并释放项目锁，同时保留分支和 worktree 供排查。
- 插件数据目录只接受尾部为 `voidtech-loop` 的 `CLAUDE_PLUGIN_DATA`，避免继承其他插件环境变量后把 run 证据写入错误目录。

### Fixed

- L2 取消测试改为跟踪并验证 stub 的准确 PID，移除可能误伤并行任务或本机同名进程的全局 `pgrep` 断言。

## 0.11.1 - 2026-07-14

### Added

- 新增 `prd-maintain` 技能：维护既有 PRD 工作树的轻量入口，四种工况（深化模块、需求变更合入 `_source/changes/`、OQ 定案回扫、评审修订处置）+ 硬性收尾不变式（改主本 → 重生成汇总 → 机械自检 → 重生成看板 → 追加变更记录）；规则与脚本单源引用 `prd-from-requirements`，不复制红线；git 仅建议不代办。在 README、使用指南和可移植性检查中登记第 25 个核心技能。
- `prd-from-requirements` 新增状态看板生成器 `generate-dashboard.py`：从深度声明、引用领域规格、追溯矩阵映射、跨系统流程与机械自检结果自动生成 `00-global/status-dashboard.md` + 自包含 `.html`，按依赖闭包判定模块「可交开发/被依赖阻塞/存疑/待深化」，并推导端到端路径就绪视图；看板是生成物禁止手改，「自报深度」与「机械信号」分列以暴露可疑绿灯。

### Changed

- `prd-from-requirements` 按大规模需求实测结果补强：新增深度分级与分期交付机制（骨架级/验收级声明 + `deepening-backlog.md` 深化任务清单），需求超规模时先确认分期计划，不再以骨架产出冒充完整交付；新增 `domain-spec.md`（跨端对象只定义一次）与 `feature-gating-matrix.md`（功能开通矩阵）两个模板；新增 `check-prd-tree.py` 机械自检脚本（断链、占位符、绝对路径权威源、裸推断标记、OQ 编号对账、深度声明）；权威源必须拷入 `_source/original/` 或记录校验和；期次口径以追溯矩阵为唯一权威并写入质量红线。
- `prd-from-requirements` 第二轮实测补强（针对「验收级虚标」）：深化 DoD 增加跨文档一致性自检（幽灵状态、终态唯一裁决、空指针/循环互指、编号格式、声明与事实一致）；新增评审缺陷处置规则（修复/转排期/转开放问题三选一并对账，禁止静默丢弃）；深化 pass 收尾必须回扫术语表、跨系统依赖、OQ 与功能开通矩阵；自检脚本新增编号零填充一致性、幽灵状态启发式、「开放问题 #n」回指三项检查，深度声明检查改按文档角色（`*-matrix.md`）匹配，改名不再豁免。
- `prd-from-requirements` 第三轮实测补强（针对「自我认证失效」与「无剧本增量更新」）：验收级改为评审认证制——深化完成先标「待评审」，由 product-manager subagent 独立核验并在 `deepening-backlog.md` 新增的「验收级核验记录」表逐项留证，通过后才可标验收级/已完成，自检脚本校验每份验收级文档必须有核验条目；生成技能对已有 PRD 工作树的更新意图增加强制路由检查点（转 prd-maintain / 全量重建归档 / 明确增量清单，三选一确认前不得动手）；幽灵状态检查抑制否定语境与页面名两类误报。
- 状态看板 HTML 重排为「作战面板」（MD 保持审计账本不变，同源生成）：顶部汇总卡（可交开发/被阻塞/待深化/存疑/未决 OQ/链路就绪率）+「下一步建议」区块（按阻塞面推荐深化目标与需先定案的 OQ）；模块按系统分组、中文标题为主 slug 为辅、按状态排序；依赖列只显示短板，完整依赖与 OQ 明细收进可展开的 `<details>`；OQ 从编号视图改为摘要视图（编号降级为可复制锚点）；带状态筛选按钮与链路进度条，仍为自包含 HTML（内联 CSS + 原生 JS，无外部依赖）。

## 0.11.0 - 2026-07-14

### Added

- 新增 `prd-from-requirements` 技能：从原始需求、Excel 整理稿、访谈纪要、需求清单或旧版 PRD 生成模块化 PRD 工作树，包含产品总览、术语表、跨系统依赖、跨系统流程、模块 PRD、需求追溯矩阵和开放问题清单。
- 在 README、使用指南和可移植性检查中登记第 24 个核心技能，并允许技能引用已发布的 `product-manager` subagent。

### Changed

- 首次安装引导开启 marketplace 自动更新：`templates/project-settings.json` 为 `voidtech` 声明 `"autoUpdate": true`，ONBOARDING 新增必做步骤（settings 写入 + `/plugin` 界面确认），插件发版后团队自动收到更新提示。

## 0.10.0 - 2026-07-14

### Added

- 新增 `architect` 与 `product-manager` 两个插件级 subagent：前者只读侦察复杂技术问题并产出架构方案，后者把模糊需求转为用户场景、MVP 边界、PRD/User Story 或体验评审结论。
- 在 README 与使用指南中登记 subagent 的调用方式和适用场景。

### Changed

- 优化本地 `architect` / `product-manager` agent 定义：补充 `effort`、`maxTurns`、工作边界和验证要求；`architect` 移除 `Bash` 权限，保持真正只读。

## 0.9.0 - 2026-07-13

### Added

- 新增 `to-design-brief` 技能：读取设计语言文档（design tokens 分析）与 PRD，合成一份自包含的设计 brief，可整段粘贴进 claude.ai/design 作为逐页生成 UI 的风格锚点。产出包含两层 token 结构（原始色板 + 语义映射）、组件规范、带需求编号追溯的逐页规格和出图顺序建议。
- 在 README 和使用指南中登记 `to-design-brief` 的触发方式与场景速查，核心技能数更新为 23。

## 0.8.3 - 2026-06-30

### Changed

- 更新检查从单纯的命令提示改为「先征求同意」：发现新版时由助手先询问用户是否现在升级，同意后才运行更新命令并提醒重开会话生效，拒绝则当次会话不再提及。钩子自身仍只注入上下文，不自动改动本地插件或 Marketplace。

## 0.8.2 - 2026-06-30

### Changed

- `to-prd` 发布前默认按 `text-naturalizer` 规则润色 PRD 正文，去掉模板腔和抽象表达，同时保留事实、结构、范围与决策内容。
- `to-issues` 发布前增加轻量文案自审，只处理标题、目标描述和背景说明，不改写验收标准、依赖、标签、代码片段、接口名、字段名或业务术语。

## 0.8.1 - 2026-06-30

### Changed

- 继续审查 22 个核心技能及其参考文件的中文表达，清理“追问”“提取能力”“极其详尽”“每片切片”等不贴合中文工程语境的表述。
- 将部分发布文档中的“逻辑闭环”“心智模型”“沉淀架构决策”等抽象表达改为更直接的中文。

## 0.8.0 - 2026-06-30

### Changed

- 将 `domain-modeling` 技能迁移为 `feature-context`，降低 `domain` 在中文语境中的理解成本。
- 同步更新跨技能调用、使用指南、审计文档和可移植性检查中的公共技能名称契约。
- 将 `voidtech-core` 版本提升到 `0.8.0`。

## 0.7.0 - 2026-06-26

### Added

- 新增 `research` 技能：对陌生问题开展多信源开放网络调研，优先委派低成本子 agent 使用官方 `exa`、`firecrawl`、`youdotcom-agent-skills` 收集证据，再由主 agent 汇总结论、分歧、风险和建议。
- 在 README、上手指南和使用指南中补充开放网络调研工作流，以及 `exa`、`firecrawl`、`youdotcom-agent-skills` 官方插件的安装与配合方式。

## 0.6.0 - 2026-06-26

### Added

- 为 `voidtech-core` 增加 `SessionStart` 更新检查：每天最多访问一次远端 `plugin.json`，发现新版本时提示用户运行 Marketplace 与插件更新命令。
- 增加更新检查脚本的行为测试，覆盖版本相同静默、发现新版本提示、缓存有效期内不重复检查、离线静默降级。
- 在安装、使用与 issue 跟踪器契约中补充 `gh`、`glab` CLI 依赖、安装命令与认证检查。
- 新增 `ship` 技能：审查当前 diff、运行验证、提交、推送，并使用 `gh` 或 `glab` 创建 PR/MR；PR/MR 标题和正文必须按 `text-naturalizer` 的口吻规则润色。
- 在 README、上手指南和使用指南中补充官方插件搭配建议，说明推荐安装项、工作流接入点和不建议重复安装的插件。

## 0.5.0 - 2026-06-24

### Changed

- 审查 20 个核心技能及其参考文件的汉化内容，清理生硬直译、夸张比喻、口语化表达和未解释的中英混用。
- 统一技能入口说明、工作流标题、Issue 模板和架构术语的中文表达；保留命令、字段名、代码块及必要的通用技术术语。
- 重写技能写作术语表和学习类参考格式，使定义更短、更直接，并在首次出现时解释必要术语。
- 增加汉化文案回归检查，防止已淘汰的生硬译法重新进入发布技能。

## 0.4.0 - 2026-06-24

### Changed

- 对 20 个核心技能完成插件内自洽性审计，清除对未分发上游命令、目录和远程前端运行时的依赖。
- 为 issue 工作流增加插件内跟踪器适配契约、标签发现、认证检查与 Markdown 草稿降级路径。
- 随附脚本统一通过 `${CLAUDE_PLUGIN_ROOT}` 定位；Git 防护脚本增加输入校验与行为测试。
- 架构审查报告改为纯内联 HTML、CSS 与 SVG，断网时仍可完整阅读。
- 修正技能编写指南，使调用可见性与当前 Claude Code 的 `disable-model-invocation`、`user-invocable` 语义一致。
- 补齐 `text-naturalizer` 的本地许可证，并将第三方声明更新为“已汉化并完成插件内自包含适配”。

## 0.3.0 - 2026-06-24

### Changed

- 将 11 个不够直观的技能命令迁移为简单英文名称：`debug`、`git-safety`、`plan-review`、`plan-review-docs`、`plan-review-core`、`architecture-review`、`fix-conflicts`、`setup-git-checks`、`learn`、`prepare-issue`、`write-skills`。
- 保留 `codebase-design`、`domain-modeling`、`handoff`、`implement`、`prototype`、`tdd`、`text-naturalizer`、`to-issues`、`to-prd`。
- 将 `plan-review-core` 标记为仅供模型编排的内部技能，不在用户命令菜单中展示。
- 增加核心技能公共命令名称契约检查，避免目录名与展示名再次漂移。

## 0.2.0 - 2026-06-23

### Changed

- 将 `voidtech-toolkit` 拆分为 `voidtech-core`、`voidtech-mcp-common` 与 `voidtech-mcp-apple`。
- MCP 改为默认禁用并固定本地执行包版本。
- 中文约定改为每个会话注入一次。

### Removed

- 从发布区移除依赖完整 gstack 运行时的 8 个技能。
- 从工作树删除缺少明确许可证的 `karpathy-guidelines` 原文，只保留审计记录。
- 停止分发已废弃的 GitHub npm MCP、第三方 Figma MCP、Desktop Commander 与 Fetch MCP。

### Added

- 增加可移植性检查、隔离安装冒烟测试与 GitHub Actions 质量门。
