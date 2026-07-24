---
name: prd-maintain
description: 维护既有 PRD 工作树：深化模块到验收级、合入需求变更、定案开放问题、落实评审修订。适用于已按模块化 PRD 工作树规范（prd-from-requirements 产出）组织的目录；不从原始需求生成新工作树。
disable-model-invocation: true
argument-hint: "PRD 工作树路径与维护意图"
---

# prd-maintain

对既有 PRD 工作树做局部维护。心智是「外科手术改主本」，不是「重新产出一棵树」：不重走破题、模块划分确认和 PM 协同生成流程。要从原始需求生成新工作树，用 `voidtech-core:prd-from-requirements`。

## 规则单源

质量红线、推断标记规范、期次权威、深度分级定义、汇总生成物与链接重写规则，全部以 `prd-from-requirements` 为准，本技能不复制、不另立。执行前按需读取：

- `${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/SKILL.md` 的「质量红线」「推断标记规范」「深度分级与分期交付」「机械自检」「状态看板」「评审缺陷处置」
- 涉及验收标准、状态机时，读同目录 `references/` 对应指南；补写文档时用同目录 `templates/` 对应模板

两处表述冲突时，以 `prd-from-requirements` 为准并回报差异。

## 第 0 步：读工作树状态

不重读原始需求全量，先从工作树自身恢复上下文。决策主本（权威）：

- `README.md`（主本规则与结构）
- `00-global/requirement-traceability-matrix.md`（头部声明与本次相关行）
- `00-global/global-open-questions.md`（OQ 状态）
- `00-global/deepening-backlog.md`（深化进度与缺口）——**存在则读**；它只在分期交付时必有，非分期、已全量验收级或早期版本的工作树可能没有。不存在时记录「无分期 backlog」照常继续，不要因此卡住 OQ 定案或需求变更。

`00-global/status-dashboard.md` 是生成物，只作健康快照用于定位，不作决策主本。

Git 处理（谨慎，不做隐式版本控制代理）：

- 不是 git 仓库：建议初始化并说明收益（变更历史、评审 diff、错改回滚），等待用户确认；用户拒绝则继续，不强制。
- 是 git 仓库：维护前记录 `git status`，维护后展示 diff 摘要。
- `git init`、`git commit` 只在用户明确要求时执行。

## 工况路由

按维护意图走对应工况；一次会话可组合多个工况，主本修改全部完成后统一执行一次收尾不变式。意图不明确时，先用一句话向用户确认归属，不要猜。

### 1. 深化模块（骨架级 → 验收级）

1. 确定目标模块：用户指定优先；否则按 `deepening-backlog.md` 的建议顺序取；无 backlog 时从各文档头部深度声明（可借助状态看板定位）找出骨架级模块，与用户确认目标后，先按 `templates/deepening-backlog.md` 补建 backlog 再开始。
2. 只读该模块 `prd.md`、它引用的领域规格、追溯矩阵中对应区间指向的源需求区段。
3. 按 `templates/module-prd.md` 补全；过「跨文档一致性自检」并逐项记录证据，backlog 对应行标「待评审」。此时头部深度暂不改。
4. 交独立核验（规则单源见 `prd-from-requirements`「深度分级与分期交付」）：委派 `@voidtech-core:product-manager` 按 DoD 与一致性自检逐项核验留证，记录写入 backlog「验收级核验记录」表。通过后才更新模块头部深度、第 13 节行级追溯、追溯矩阵区间入口标注和 backlog「已完成」；打回则修订后重新核验。做的人不能给自己认证。

### 2. 需求变更（新增需求或口径变更）

先判定工作树能力：根部存在 `prd-worktree.json` 且 `capabilities.sourceSync` 为 true 的是已迁移树，否则是 legacy 树。

**已迁移树**——变更从哪来决定入口，不手工比对源文件：

- 源文件出了新版本（如 Excel 更新）：一律交 `voidtech-core:prd-sync`（sync → propose → confirm），由它计算差异并经用户确认；确认后的变更集回到本工况，按下面第 3、4 步做影响面确认与主本合入。
- 无可比源文件的带外变更（邮件、口头、会议结论）：先登记，再走影响面确认与主本合入，不直接改主本：
  `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" register-change <工作树> --change-id <id> --requirement <REQ|new> --text <文本>`

**legacy 树**维持现流程：

1. 新需求源落盘到 `_source/changes/YYYYMMDD-{slug}/`，不覆盖 `_source/original/`；是 xlsx 则按 prd-from-requirements 的 Excel 处理流程转换。
2. 新需求点追加编号，**永不重排既有编号**——编号是追溯锚点。
3. 追溯矩阵先扩行（含期次），再用矩阵反查影响面，列出受影响模块清单，向用户确认后才改主本。
4. 口径变更同理：先在矩阵定位原编号，列影响面，确认后修订。

### 3. OQ 定案

1. 更新 `global-open-questions.md` 对应行状态与结论。
2. `grep OQ-xxx` 回扫全树引用处：`[推荐默认]` 内容转正（去标记、按定案改写）或按新结论修订；禁止只改表不改引用方。
3. 定案推翻原默认方案时，影响面按「需求变更」工况处理。

### 4. 评审修订

按 `prd-from-requirements` 的「评审缺陷处置」执行：每条缺陷修复 / 转排期（登记 backlog）/ 转开放问题（立 OQ）三选一，最终回复附三类对账清单，禁止静默丢弃。

### 5. 需求撤回、废弃、替代与移除（生命周期）

「删除需求」不存在——需求历史和编号永不物理删除，只做生命周期迁移：`active → withdrawn / deprecated / superseded`，`deprecated → removed / superseded / active`，`withdrawn → active`；其余迁移非法。`removed` 与 `superseded` 不可复活，能力回来立新编号并回链旧编号。`prd-sync` 只提出候选（如「Excel 中该需求的来源记录消失，疑似撤回」）；候选不是指令，经用户确认为明确维护指令后才进本工况。本工况的裁决要落 journal，只适用于已迁移树；legacy 树先经 prd-sync 完成迁移。

1. **确认输入清单**（缺一项先问，不猜）：目标需求编号；生命周期动作（withdraw / deprecate / supersede / remove）；是否已实现或上线；生效版本或日期；是否存在替代需求；已有数据、接口、页面入口和用户是否需要迁移；整条失效还是部分撤回。**无法确认是否已上线时，不得按 withdrawn 处理**，默认进入影响分析并要求确认——把已上线能力当未实现需求删掉是风险最大的操作。
2. **反向影响分析先行**：从追溯矩阵（和逻辑模型，若有）反查模块功能清单、页面入口、跨系统流程与依赖、领域对象与状态机、字段、权限、功能开通矩阵、通知、埋点、验收标准、OQ、深化任务和其他需求引用；输出拟修改、保留和新增迁移项清单，向用户确认，确认前不改主本。
3. **先落 transition 裁决，再改矩阵投影，最后改主本**（顺序不可倒）：
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" lifecycle <工作树> <需求编号> <action> [--effective-at <ISO 时间>]
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" confirm <工作树> <proposal-id>
   ```
   confirm 提交后更新追溯矩阵的生命周期投影列（生命周期状态、生效日期/版本、原因、替代需求、决策来源——含「是否已上线」的回答及依据、影响状态），**原行永不删除**（墓碑记录）；随后按动作剧本修改模块主本。
4. 按动作执行对应剧本：
   - `withdrawn`（未交付）：从本期功能清单、用户路径、权限、通知和验收标准移除规范性要求；模块第 13 节追溯保留编号并标「已撤回」；取消相关深化任务并记录原因；OQ 改「不再适用」不物理删除；变更记录写明原因和影响范围。
   - `deprecated`（已交付、兼容期）：保留当前行为描述并明确标记；写出禁止新增进入的具体 gating 规则；补迁移对象、兼容期限、替代入口和回退规则；建立下线任务或 OQ——没有迁移方案不能进入 `removed`。
   - `superseded`：旧编号保留并链接新编号；新需求承接的功能、状态、验收标准必须明确；未被新需求覆盖的部分不能静默消失。
   - `removed`（兼容期结束）：删除主路径中的旧入口和旧操作；更新状态机、字段、权限、通知和依赖；保留历史追溯、废弃说明和变更记录；仍有历史数据时必须说明只读、归档、迁移或清理规则。API、数据库或客户端兼容属于后续实施范围，PRD 给出要求，本技能不修改代码。
5. 部分撤回不得让编号含义漂移：REQ 含 A、B、C 只撤回 B 时，小范围口径收缩可修改原需求（变更记录保留前后语义）；B 可独立验收、独立排期或已有实现时应拆分——旧需求走 supersede，新增明确的替代需求。
6. 本工况收尾在通用收尾不变式之外追加机械检查：
   - `withdrawn`、`removed` 需求不得出现在有效功能清单、主流程和有效验收标准中。
   - `deprecated` 必须有兼容规则，且有替代需求、迁移任务或 OQ 之一。
   - `superseded` 必须引用存在的替代需求，且无替代循环。
   - 历史需求编号仍存在于追溯矩阵；被移除的状态或字段不存在活动需求引用。
   - 取消的 backlog 条目保留原因；OQ 标「不再适用」而非删除。
   - 有效需求覆盖率与历史需求数量分别统计。
   - 矩阵投影与裁决记录一致；复活候选（来源记录重新出现而需求仍是 withdrawn）未裁决前，矛盾态保持报警可见，不自行消音。

## 收尾不变式（每次维护会话硬性执行，缺一不可）

按工作树能力分层，判定同工况 2。

**legacy 树（六条不变）：**

1. 只改模块主本与全局主本，不直接改任何生成物。
2. 重新生成系统汇总与根汇总（按链接重写规则）。
3. 运行机械自检，错误清零：
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/check-prd-tree.py" <工作树>`
4. 重新生成状态看板：
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/generate-dashboard.py" <工作树>`
5. 受影响文档追加变更记录（日期、变更摘要、原因、影响范围）。
6. Git 仓库时展示 diff 摘要。

**已迁移树**：第 1、5、6 条同上；第 2–4 条改经 operation overlay 走内容门，另加三条：

- 主本修改随所属 operation 暂存与发布，不逐文件手工落盘：机械自检加 `--operation-id <id>` 检查预提交视图；Atlas 门在 `capabilities.logicAtlas` 开启时执行，按 `logicAtlasStage` 裁剪（Markdown 阶段不要求 HTML）。
- 机械自检可能返回退出码 3（读取栅栏：工作树存在未完成 operation）。先恢复再继续，不硬闯：
  `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" recover <工作树>`
- Atlas 生成物随 operation 发布，不手工重生成：
  `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" atlas <工作树> --publish`

## 明确不做

- 不从原始需求生成新工作树，不重走模块划分确认与 PM 协同生成流程。
- 不覆盖、不重排既有需求编号；不覆盖 `_source/original/`。
- 不手改汇总 PRD 和状态看板等生成物。
- 不自动 `git init` 或 `git commit`。

## 最终回复

- 本次工况与改动文件清单
- 机械自检结果与看板就绪统计变化（如 3/24 → 5/24）
- 变更记录位置；评审修订工况附缺陷处置对账清单
- Git 仓库时附 diff 摘要
