# 任务:Lifecycle 状态机视图接线——prdsync 确定性布局器与 archify 渲染桥

- **日期**:2026-07-24
- **状态**:Draft(待工程认领)
- **归属**:voidtech-core `prd-from-requirements`,Gate 5(Logic Atlas)呈现层;前置依赖 0.15.0 已 vendored 的 archify(v2.12.0 @ eb847fa,见 `vendor/archify/VENDOR.md`)
- **一句话摘要**:Atlas 现有状态机视图把每条流转渲染成独立的「左状态 → 右状态」卡片行,同一状态重复出现(会籍 5 状态被画成 7 行,「有效」出现 3 次),人无法重建状态图、无法审计漏转和死状态。本任务在 prdsync 内实现确定性布局器(状态→lane/col 映射)与 archify 渲染桥(依 validator 机器可读诊断做有界自动修复),把状态机 tab 换成真正的 Lifecycle 图;Node 缺失或修复预算耗尽时按 ADR-0005 §8 降级为现有列表并如实标注,不阻塞内容门。

## 背景与问题

- 2026-07-24 对示例项目 `logic-atlas.html` 的人工审查将「状态机不是状态机」列为 P0:一行一条流转、状态节点复制,审计者无法回答「有没有漏掉的流转、有没有进得去出不来的死状态」——这是画状态机的唯一理由。
- archify 五种图渲染基础设施已 vendored 并验证(doctor 全绿、五模式 deliver 冒烟通过)。用「会籍」真实数据手工构建 Lifecycle IR 的 spike 证明:图形化后每状态唯一、终态无出边一眼可读;但人工经历了 5 轮布局迭代才通过 fail-closed 校验。**这 5 轮迭代的全部逻辑就是本任务要自动化的内容**,且 validator 诊断是机器可读的(稳定 rule code + 精确 subject + supportedFixes,含建议坐标),自动修复可行性已被 spike 证明。
- 现库规模完全在 Lifecycle 容量内:6 个状态机,最大 6 状态 7 流转(会籍 5/7、入会订单 6/6、支付段 5/5、账号 4/4、身份认证 3/3、身份等级 2/2);其中存在环(会籍、身份认证、身份等级)、多终态(入会订单 2 个)与无终态(身份等级)三种必须处理的形态。

## 目标

Gate 5 生成 Atlas 时,对 logic-model 中每个状态机确定性地产出一张通过 archify fail-closed 校验的 Lifecycle 图并嵌入状态机 tab:每个状态恰好出现一次,终态与流转方向可直读;同一输入重跑产物字节一致;渲染能力缺失时降级不阻塞。

## 范围

### 做

1. **`prdsync/lifecycle_ir.py`(新,纯标准库)**:从 logic-model 提取状态机(transition 边按 scope+对象分组,端点并集为状态)并确定性生成 archify Lifecycle IR:
   - **lane 映射**:最长 start→终态路径上的非终态状态入 `main`;其余非终态状态入单一中间带 lane(「分支/中断」);无出边状态入 `terminal`。
   - **col 映射**:Tarjan SCC 缩点后按 DAG 最长路径深度赋列(环内状态取所在 SCC 深度),`main` 带压缩到 0–4,`terminal` 带压缩到 0–2。
   - **type 映射**(v1 冻结的确定性关键词表,写入代码并在测试中锁定):入度 0 → `start`;无出边且标签命中 通过/生效/成功 → `success`,命中 未通过/失败/拒绝 → `failure`,否则 → `neutral`;有出边且标签或进入条件命中 待/暂停/到期 → `waiting`,否则 → `active`。
   - IR JSON 键排序、数组顺序稳定(按 nodeId/edgeId 排序),字节可复现。
2. **`prdsync/archify_bridge.py`(新,标准库 subprocess)**:调 `node vendor/archify/bin/archify.mjs deliver lifecycle … --json`,解析 diagnostics,按固定规则表做有界自动修复(≤8 轮,规则按 code 匹配、按固定顺序应用):
   - `clean-flow/edge-through-node` → 按固定升级序列换路由:straight → drop → bottom-channel(channelY 步进) → left/right-channel。
   - 标签遮挡类 `layout/constraint` → 直接采用诊断 evidence 中的建议 labelAt/labelDy。
   - `artifact/legend-clearance` → channelY 收缩步进(有界)。
   - 预算耗尽或未知 code → 该状态机降级(见 4),其余状态机不受影响。
3. **嵌入**:从 deliver 产物 HTML 提取唯一 `<svg>`(已验证恰一个),内联进 Atlas 状态机 tab;来源列表、需求 chips 等追溯面板保留在 Atlas 侧图下方,不引入 archify 自带 viewer 的交互层。
4. **降级与呈现风险**:`node` 不可用、deliver 失败或修复预算耗尽时,该状态机保留现有列表渲染,`_generated` 记录 diagnostics 摘要,状态看板 `presentationRisk` 如实标注;**内容门照常完成**——对齐 ADR-0005「图形渲染失败时保留表格或列表降级内容」与「呈现能力不决定维护能否完成」。
5. **ADR-0005 变更记录一行**:「编译器与渲染器满足 Python 标准库自包含」修订为「呈现层允许调用插件内 vendored 的零 npm 依赖 Node 子系统(≥18);缺失时按 §8 降级,不阻塞内容门」。
6. **验证证明与浏览器断言**:renderer 验证证明继承键覆盖 archify 资产(新增 `archifyDigest` 或并入 `assetDigest`,见开放问题 2);viewer/harness 版本 bump,浏览器断言新增:Lifecycle SVG 存在、每状态标签在图内唯一、无 console/page error、降级路径可达。

### 不做

- 不修改 `logic-model.schema.json` 的状态机结构,不修上游数据(有效态三条出边的重复标签**忠实呈现**——那是数据缺陷显形,不是渲染缺陷;见「关联缺陷」)。
- 不接线其余四种图型(Architecture/Workflow/Sequence/Data Flow 等各自数据就绪后另行立项)。
- 不修改 vendored archify 代码(升级 = 整目录替换,见 VENDOR.md)。
- 不做超容量状态机的自动分页/聚类(现库最大 6 状态;超容量直接降级列表 + 呈现风险标注)。
- 不引入 archify 独立 viewer/iframe、动画、Present 模式。

## 行为规格(输入 → 行为 → 错误)

| 输入 | 行为 | 错误/边界 |
|---|---|---|
| 常规状态机(含环、多终态) | 提取 → 布局 → deliver → (≤8 轮修复) → SVG 内联 | 布局器对环缩点;多终态并排 terminal 带 |
| 无终态状态机(身份等级) | 全部状态按 SCC 深度入 main/中间带,不伪造终态 | 不得误标 `success/failure/neutral` 终态类型 |
| 状态数超 main 带容量 | 不尝试渲染,直接降级列表 + presentationRisk | 无静默截断 |
| `node` 不在 PATH / 版本 <18 | 全部状态机降级列表,内容门继续 | 状态看板与 atlas-meta 如实标注,无异常中断 |
| deliver 非 0 退出 / stdout 非 JSON | 该状态机降级 + 记录原始 stderr 摘要 | 不重试超过预算,不吞错 |
| 同一 logic-model + 同一 archify 版本重跑 | IR、修复序列、SVG 字节一致 | 任何时间戳/随机性进入产物即为缺陷 |

## 验收标准(全部可判真伪)

1. 示例项目 6 个状态机全部 deliver `ok:true`;每个状态标签在对应 SVG 中恰好出现一次(现有视图中「有效」×3、「到期」×2 的重复不复存在)。
2. 「终态」「已通过」等无出边状态位于 terminal 带;身份等级(2 状态互转、无终态)正常渲染且无终态类型标记。
3. 同一输入连续两次全量生成,6 份 IR JSON 与 6 份 SVG 逐字节一致。
4. 移除 `node` 后执行 Gate 5:内容门完成,状态机 tab 为列表降级,`presentationRisk` 标注;恢复 `node` 重跑回到图形渲染。
5. 构造一个修复不可收敛的 fixture:仅该状态机降级并留有 diagnostics 摘要,其余 5 个正常出图。
6. 既有 unittest 套件不回归;新增布局器单测(lane/col/type 映射、缩点、容量压缩)不依赖 Node 即可运行。
7. 浏览器 harness 新断言全部通过并签发新验证证明;archify 资产 digest 变化使旧证明失效。

## 开放问题(附推荐默认)

1. **嵌入形态**:内联静态 SVG(推荐:Atlas 保留自己的追溯壳,体积可控)vs 另存独立 archify HTML 并从 Atlas 链接(交互全套但双导航体系、每图 ~600KB)。
2. **证明继承键**:新增独立 `archifyDigest`(推荐:归因清晰,archify 升级只作废呈现证明)vs 并入现有 `assetDigest`(键少但混淆 viewer 与图渲染器的变化源)。
3. **type 关键词表的长期归属**:v1 冻结在代码(推荐:先跑起来,表可测试可审计)vs 模块模板新增机器可解析「状态性质」列(彻底但动公共契约,建议与关联缺陷的模板修订合并评估)。

## 关联缺陷(独立于本任务,须另行登记)

Gate 5 编译器从领域规格的**按状态**表(`当前状态 | 进入条件 | 可执行操作 | 下一状态`)爆炸生成流转边,把状态级「可执行操作」整团复制到每条出边——导致有效→到期/已终止/暂停三条边标签完全相同,且「缴费生效」(进入条件)被当作出边条件。而**同一份领域规格的 mermaid 块里存在正确的逐边触发**(`到期 --> 有效: 续费成功`、`有效 --> 已终止: 被机构移除(MBR-018)`),未被编译器消费。修复方向(纳入 mermaid 解析,或模板改逐边行)动的是提取契约,与本任务(布局与渲染)正交;本任务的图会让该缺陷持续可见,修复后无需改动本任务任何代码即自动受益。

## 结语

Spike 已经证明两件事:图形化让「状态唯一、死状态直读」第一次成为可能,fail-closed 诊断精确到可机械修复。本任务只是把人工做过一遍的事写成确定性代码——布局器是纯函数,修复循环是查表,降级路径是 ADR-0005 早已定好的分层。接完这条线,状态机 tab 从「P0 审计障碍」变成 Atlas 里最能打的视图,也为其余四种图型的接线立下「数据就绪才接线、缺能力就降级」的模板。
