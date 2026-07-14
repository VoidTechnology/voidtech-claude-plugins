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

## 收尾不变式（每次维护会话硬性执行，缺一不可）

1. 只改模块主本与全局主本，不直接改任何生成物。
2. 重新生成系统汇总与根汇总（按链接重写规则）。
3. 运行机械自检，错误清零：
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/check-prd-tree.py" <工作树>`
4. 重新生成状态看板：
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/generate-dashboard.py" <工作树>`
5. 受影响文档追加变更记录（日期、变更摘要、原因、影响范围）。
6. Git 仓库时展示 diff 摘要。

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
