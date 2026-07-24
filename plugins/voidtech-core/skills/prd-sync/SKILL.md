---
name: prd-sync
description: 向既有 PRD 工作树导入外部需求源的新版本：存量迁移、只读同步、三方归并、人工裁决落 journal、生命周期候选与恢复。只产出可审阅变更集与裁决记录，不改 PRD 主本；主本修改与收尾交 prd-maintain。
disable-model-invocation: true
argument-hint: "PRD 工作树路径与同步意图（如：导入新版 Excel / 存量迁移 / 巡检）"
---

# prd-sync

把外部需求源（如人工维护的 Excel）的新版本安全地并入既有 PRD 工作树。心智是「先裁决身份，再改主本」：本技能只负责导入、归并和把裁决落进 reconciliation journal，**从不直接修改 PRD 主本**（ADR-0004 职责分工）：

- `prd-from-requirements`：从未建树的原始需求建立首个工作树（首建走它，不走本技能）。
- `prd-sync`（本技能）：导入某数据源的新版本，计算差异，与需求账本三方归并，形成可审阅的变更集与候选项，用户裁决后落 journal。
- `prd-maintain`：按已确认变更集修改模块主本与全局主本，执行统一收尾不变式。

全部操作通过同一个 CLI 执行：

```
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" <command> <worktree> [options]
```

所有命令支持 `--json` 输出机器 payload。

## 规则单源

质量红线、推断标记规范、编号与追溯规则，全部以 `prd-from-requirements` 为准，本技能不复制、不另立。涉及主本修改口径时读 `${CLAUDE_PLUGIN_ROOT}/skills/prd-maintain/SKILL.md` 对应工况。两处表述冲突时以 `prd-from-requirements` 为准并回报差异。

## 退出码语义（所有子命令统一）

| 退出码 | 含义 | 处置 |
|---|---|---|
| 0 | 成功 | 按命令输出继续 |
| 1 | 引擎/业务错误（锁被持有、源未注册、源已退休、校验失败等） | 把 stderr 报给用户，按错误修正后重试 |
| 2 | 用法错误（参数缺失、多源未指定 `--source` 等） | 修正命令行 |
| 3 | 读取栅栏：存在未完成发布的 operation | 走工况 5（recover），恢复后重试原命令 |
| 4 | 需要人工裁决/确认（迁移人工项、歧义裁决、rebaseline、恢复二选一） | 把待裁决项呈现给用户，拿到裁决后带参数重试 |

任何命令退出码为 3 时，先执行工况 5，再回到原工况；不要绕过栅栏读工作树。

## 工况路由

按意图走对应工况。意图不明确时，先用一句话向用户确认归属，不要猜。

### 1. 存量迁移（老工作树首次接入 source sync）

适用：`prd-from-requirements` 早期生成、还没有 `prd-worktree.json` 机器清单的工作树。

1. 只读分析：

   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" migrate <worktree> --dry-run
   ```

2. 把输出中的**人工确认项**逐条呈现给用户（itemKey、所在 sheet/模块），对照原始 xlsx 确认每条的目标需求编号；区间级追溯缺口如实告知（缺口未清零时提交会被引擎拒绝，无「部分迁移」）。
3. 拿到全部裁决后提交：

   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" migrate <worktree> --confirm KEY=REQ-ID [--confirm KEY2=REQ-ID2 ...]
   ```

   裁决多时改用 `--confirmations file.json`（itemKey → 编号的 JSON 对象）。退出码 4 表示还有未裁决项，stderr 会列出缺哪些。

### 2. 导入源新版本（主路径）

1. 只读同步（只推进 observed/pending 游标，不动主本）：

   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" sync <worktree> --input <新版.xlsx> [--source <id>]
   ```

   单 versioned 源可省略 `--source` 自动推断；多源必须显式。报 no-op 时如实告知用户「内容与已应用版本一致」，流程结束。退出码 4（rebaseline required）时先执行 `rebaseline <worktree>` 再重试。
2. 三方归并出 proposal：

   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" propose <worktree> [--source <id>]
   ```

3. 把输出完整呈现给用户：变更分类桶、歧义项（含候选编号）、撤回候选、拟改文件。**歧义项与 new 占位必须逐条由用户裁决**，不替用户猜；撤回候选只是候选，确认停用走工况 4。
4. 按用户裁决提交：

   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" confirm <worktree> <proposal-id> --decision OCC=REQ-ID --decision OCC2=new [...]
   ```

   `--decision` 的值是既有需求编号（归并到它）或 `new`（分配新编号）；裁决多时用 `--decisions file.json`。退出码 4 会列出仍缺裁决的 occurrence。
5. 提交成功后，把已确认变更集（proposal 输出 + confirm 结果）交给 `voidtech-core:prd-maintain` 工况 2 合入主本并执行统一收尾。本技能到此为止。

### 3. 带外变更登记（没有可比较源文件时的降级入口）

```
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" register-change <worktree> --change-id <YYYYMMDD-slug> --requirement <REQ-ID|new> --text "<规范化正文>"
```

`--requirement new` 会分配新编号并在输出中报告。登记只落 change manifest 与 journal；主本相应修改仍走 `prd-maintain`。

### 4. 生命周期候选（撤回/废弃/替代/移除/复活）

源记录消失或用户确认需求停用时，先落提案再提交：

```
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" lifecycle <worktree> <REQ-ID> <withdraw|deprecate|supersede|remove|reactivate|cancel-deprecation> [--effective-at <ISO8601>]
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" confirm <worktree> <proposal-id>
```

提交前必须拿到用户对 ADR-0004 §8 裁决输入的确认（是否已上线、生效时点、替代需求、数据迁移）；无法确认是否上线时不得按 withdrawn 处理。提交只改 journal 与 Ledger 读模型；主本入口、状态机等修改指向 `prd-maintain` 工况 5。

来源治理同属本工况：`retire-source <worktree> <source-id>`（退休源，不再接受新 revision）、`invalidate-assertions <worktree> <source-id>`（批量失效该源支撑），均产出提案后走 `confirm`。

### 5. 恢复（任何命令退出码 3 时）

```
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" recover <worktree>
```

再次退出码 4 表示存在 publish-conflict，需要用户二选一后重试：`--choice overwrite`（覆盖第三方修改）或 `--choice keep`（保留第三方修改并回滚本次 operation）。把冲突文件清单呈现给用户再问，不替用户选。

### 6. 巡检

```
python3 "${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/prd-sync.py" status <worktree>
```

报告能力开关、各源游标（applied/pending/observed）、open proposal、非终态 operation、读取栅栏与 Atlas 新鲜度（能力开启时）。只读；有栅栏时如实报告并建议工况 5。Atlas 的检查与发布用 `atlas <worktree> [--check|--publish|--gate]`；Logic Atlas 能力阶段的置位用 `atlas <worktree> --enable <markdown|html|polish>`。置位前，模块 `prd.md` 必须补齐模板中适用的机器可解析表；统一场景流程至少需要页面契约、核心流程、页面交互、流程状态影响、带步骤 ID/交互 ID 的边缘状态，以及本地或领域规格中的可引用状态机。跨模块页面使用 `<module-scope>::<页面名>`；交互成功链必须唯一入口且可终止，坏引用进入 gaps。置位后运行 `atlas --publish` 生成或更新生成物。

## 明确不做

- 不修改任何 PRD 主本、汇总生成物与状态看板——那是 `prd-maintain` 的职责。
- 不从原始需求首建工作树——首建走 `voidtech-core:prd-from-requirements`。
- 不替用户裁决歧义项、new 占位、撤回候选与 publish-conflict 二选一。
- 不绕过读取栅栏读工作树，不手改 `_source/reconciliation/` 下任何文件。

## 最终回复

- 本次工况与执行的命令清单（含退出码）
- 已提交的 operation/proposal ID 与 revision 游标变化
- 交给用户的待裁决项对账清单（已裁决/未裁决）
- 后续动作指向（如「已确认变更集交 prd-maintain 工况 2」）
