# Changelog

## voidtech-design 0.4.0 - 2026-08-04

Design 插件此前只能把已有设计语言压缩成一次性 brief，或比较临时 UI 结构。两个缺口同时存在：一是不能从项目事实建立一份长期维护、可机器校验的设计系统合同，团队只能手工拼接 `DESIGN.md`，容易把产品事实、设计推导和未经批准的范围写成同一种语气，也会把官方 lint 的 warning 当成可忽略提示；二是没有独立角色审查生成结果，主 Agent 既产出又自评，容易把视觉完成度误当成设计正确性。本版一次补齐规范产出与独立审查两侧，并补上 ADR-0006 已定义但尚未发布的 Designer 审查边界。

### Added

- 新增公开 `/voidtech-design:create-design-md`：完整读取 PRD、实现、设计资产和现有约束，建立产品事实矩阵，区分产品事实、设计推导与 `DD-CANDIDATE`，创建或修订符合 Google design.md specification 的标准 `DESIGN.md`。
- 随 Skill 分发一份最小可用模板和设计合同清单，固定八个规范二级章节、支持的 YAML/token/component 字段，以及产品边界、状态、安全、视觉系统、响应式和无障碍审查项。
- 新增严格校验器：通过随附 lockfile 固定 `@google/design.md@0.4.0` 及完整依赖，禁用安装生命周期脚本；除官方 error 外也把 warning 和非标准章节结构视为失败，避免孤立 token、对比度不足、未知属性或章节漂移带着“退出码 0”进入交付。
- 工作流要求在项目外生成自包含临时 HTML 预览，并在宿主支持时交给独立设计审查者复核；修复 P0/P1 后重新运行机械门禁。
- 新增公开 `designer` subagent：基于真实界面、原型、设计系统与需求证据，独立审查 IA、视觉层级、交互一致性、组件复用、状态覆盖、响应式、可访问性和 AI slop。
- 审查输出固定区分 `revision_required` 与 `ready_for_user_review`；后者只表示可以交给用户复核，不代表已批准。问题按 `blocker`、`major`、`minor` 分级，并要求位置、证据、影响、修改方向和验证方式。
- 允许提出单独标记的 `DD-CANDIDATE`，但不得批准 Design Decision、补写产品事实或把 Agent 结论伪装成用户验收。证据不足时必须报告缺口，不能对未见界面给整体通过结论。
- 双宿主契约和隔离安装检查覆盖 `create-design-md` 与 `designer`，确保 Claude Code 与 OMP 都分发等价的资源与只读、搜索工具声明。

### Compatibility

- Skill 与 subagent 同时随 Claude Code 与 OMP 的 `voidtech-design` 安装；资源只从插件安装目录解析，不依赖仓库 checkout 或用户私有路径。
- 严格 lint 需要 Node.js 18+ 与 `npm`，运行时会按随附 lockfile 安装完整锁定依赖；工具或网络不可用时明确停止，不伪装成已通过。
- `designer` 只读，不授予 Write、Edit 或 Bash；不会修改业务代码、配置和设计产物。现有 `to-design-brief` 与 `ui-prototype` 行为不变。
- 用户可用 `@voidtech-design:designer` 独立评审现有界面或一次性原型；`create-design-md` 的内容审查环节也可交给它执行。
- `create-design-md` 只建立标准 Design Foundation 文档，不替代 `design-from-prd` 规划中的 readiness、Design Workspace、trace、双审查或 accepted 生命周期，也不会自行 commit、push 或发布；未来 `design-from-prd` 可复用 `designer` 的同一审查契约，不要求当前先实现 Design Workspace。
- 0.3.0 只在 `main` 上短暂存在、从未打 tag 或发布，其全部内容包含在本版本中；升级路径是 0.2.0 直接到 0.4.0。

## voidtech-core 0.21.0 / voidtech-product 0.8.0 / voidtech-engineering 0.3.0 - 2026-07-29

两个公开 subagent 固定 `model: fable`，这是插件替用户做的决定，而它有一个用户无法预料的失败模式。

### Fixed

- `architect` 与 `product-manager` 的固定模型由 `fable` 改为 `opus`。三条理由，第一条是硬故障：**Fable 5 要求组织开启 30 天数据保留，配置为零数据保留（ZDR）的组织每个请求都返回 400**，而错误信息不指向真实原因——用户会去查 prompt、网络和 Token，查不到插件锁了一个他的组织不支持的模型；ZDR 在受监管行业是常见配置。其二是成本：Fable 每百万 token $10/$50，是 Opus 5 的两倍，而 frontmatter 的 `model` 会覆盖用户自己的会话选择，一个为控成本特意跑 Sonnet 的用户不会知道自己被切到了最贵档。其三是拒答概率：Fable 的安全分类器有 `cyber` 分类，官方文档写明「benign cybersecurity work 也会触发」，而 `architect` 评审权限边界、认证与凭据处理正落在这个面上，拿到的是 `stop_reason: "refusal"`（HTTP 200，不是错误）而不是方案。Opus 5 是官方定位的「复杂 agentic coding 与企业工作」主力档，前两个问题都没有；**分类器它也有**，安全类评审仍可能被拒答，只是安全阈值按模型能力分档设置，Opus 5 这一档更宽——这一条是降低概率，不是消除。受 ZDR 影响的组织另有官方解法：给单个 workspace 开 30 天保留即可用回 Fable，但那是组织管理员的决定，不该由插件替他做。
- 两个 agent 的 description 由「(最强模型)」改为「(深度推理)」。前者今天准确（Fable 5 确实是最强的广泛发布模型），但它是写在用户可见的 agent 选择器里的模型代际断言，会随下一次模型更迭过期，且没有任何契约测试盯着——描述该说这个 agent 干什么，不该替模型排名。
- 仓库自用的 `loop-security-reviewer` 同样由 `fable` 改为 `opus`。它专审 Shell 逃逸、Git refs、凭据与权限边界，正好落在 `cyber` 分类的面上：拒答风险最高的 agent 用了阈值最紧的模型。Opus 5 同样可能拒答，所以这是降低概率而不是解决问题——真被拒答时换模型重试。`plugin-contract-reviewer` 保留 `fable`——它审的是 manifest 与版本契约，不落在分类器覆盖面上，且只在维护者自己的组织里跑。
- `voidtech-core:research` 的调研分工把 `fable` 和 `haiku` 并列推荐给「资料收集 agent」。同一个仓库对 fable 的定位出现两种互斥说法，这一处是错的：Fable 是最贵最强的档，不是 haiku 的同类。改为只推荐 `haiku`，并写明理由——资料收集的瓶颈是覆盖面而不是推理深度。

### Added

- 契约门禁新增 `scripts/check-agent-models.mjs`：`plugins/*/agents/` 里的 `model` 字段只允许 `opus` / `sonnet` / `haiku` / `inherit` 或 `claude-` 前缀的具体模型 ID，并显式拒绝一份「带环境前置条件的模型」清单（`fable`、`claude-fable-5`、`claude-mythos-5`、`claude-mythos-preview`），错误信息里写明前置条件是什么。省略 `model` 字段合法，`inherit` 是同一件事的显式写法——两者都表示继承用户的会话模型。此前 `check-portability.sh` 与 `check-doc-contract.mjs` 都不校验 `model`，`docs/dev-rules/` 里也没有任何关于模型选择的规则，所以这类问题没有任何机制会拦住。
- 门禁按 YAML 取值而不是「行尾必须紧跟值」：`model: fable # 说明` 这类带行内注释的写法此前匹配不上，会退回「未声明」分支静默放行——一句注释就能绕过这个门禁。同时把带引号的标量按裸值处理，并对「有 `model` 行但值为空」报错而不是当成未声明。三种情况都有回归测试。

### Notes

拒绝清单是显式维护的，不会自动跟随新模型——新增模型时仍需按「是否存在用户无法预料的环境前置条件」人工评估一次。门禁只覆盖随插件分发的 `plugins/*/agents/`；`.claude/agents/` 是仓库自用、只在维护者组织里运行，不在门禁内（本版对 `loop-security-reviewer` 的修正因此是人工判断，不是门禁产物）。

另一个未覆盖的缺口：无法验证 OMP 是否认识 `opus` / `sonnet` / `haiku` 这些短别名。Claude Code 认（这是它的公开取值），OMP 侧仓库里没有任何验证，`check-portability.sh` 也不检查 `model` 字段的宿主兼容性。
## voidtech-product 0.7.0 - 2026-07-29

一个真实项目建完 PRD 工作树后找不到 `logic-atlas.html`，追下去发现三处错位：文档把 Atlas 归给了不生成它的技能、能力何时该置位没有判据、以及验收级硬门漏掉了 Atlas 依赖的四项审计结构。前两项是文档缺陷，第三项让「验收级」可以不含任何权限与字段契约。

### Fixed

- 验收级审计结构硬门从 6 项补到 10 项，补上 `§3.4 模块交互`、`§5.0.4 步骤权限合同`、`§7.0.2 字段定义`、`§8 权限矩阵`。这四项 Atlas 编译器都要读（字面值与 `atlas.py` 的 marker 常量一致），但此前不在硬门内：一个模块可以写齐流程侧六项、标成「验收级」、机械自检 0 错误退出码 0，而 Atlas 编译时 `requiredActions.permissionRefs` 与字段示例全进 gaps。回归测试构造的正是这棵树。这不回退 0.6.0 把 `§5.0.4` 改为条件适用的决定——硬门接受「不涉及：原因」，纯访客模块照旧一行了事，只是不能再整节省略。
- 「不涉及：{原因}」的豁免声明不再认引用块，只认正文与表格行。`§5.0.4`、`§7.0.1` 的模板说明 blockquote 自带这句示例，而豁免检测搜整个章节——照模板生成的文档只要保留说明、删掉整张表，就被判成「已声明不涉及」。这个假阴性让上一条补的硬门对 §5.0.4 基本无效（模板生成的文档都带那段说明），因此同批修掉。**已有工作树可能因此新报错误**：此前靠模板说明蒙过检查的空章节会现形，需要补真表或把「不涉及」写到引用块外。
- 模板 `§3.4 模块交互` 的清空写法从「无跨模块交互写「无」并删除表格」改成写一行「不涉及：本模块无跨模块交互」。硬门只认「不涉及：原因」，照旧写法办的独立模块标验收级后会拿到一个模板里找不到解法的硬错误。新增两条回归：模板自带的十个章节必须都过硬门（锁 `atlas.py` marker、硬门与模板的三方对齐），且模板教的每种清空写法都必须是硬门认的写法。
- `docs/USAGE.md` 此前写「`prd-from-requirements` 生成的 `logic-atlas.html`」。该技能只生成状态看板，Atlas 的置位在 `prd-sync`、发布在 `prd-maintain` 与 `prd-sync`。按这行文档建树的人拿不到图，也不知道该去哪开。

### Added

- `prd-from-requirements` 新增「Logic Atlas 置位时机」：首建不置位；**首个模块通过验收级评审后**开 `markdown`，此时 gaps 清单才有意义（它列的是剩余模块还差哪些机器可解析声明，正好当深化清单）；试点主流程模块通过验收级评审后升 `html`。骨架级全树开启只会得到一张几乎全是「未声明」的图，会被误读成数据丢失。同时写明 `--enable` 要求工作树已迁移，而 `migrate` 会连带置位 `capabilities.sourceSync` 并引入读取栅栏——不可逆，先与用户确认，不为了出图顺手迁移。

### Notes

0.6.0 记下的「表头与列序固定但机械自检不校验表头形状」仍未覆盖：本版只补章节存在性这一维度。已知漏检还有一项——`§7.0 数据读写` 是 `§7.0.1 页面数据读写` 的子串，按 `marker in text` 判定会被 §7.0.1 的标题假命中，因此没有纳入硬门；要纳入得先把判定改成标题级精确匹配，与表头形状检查同批处理更合适。两处都已在代码注释里标明原因，避免后来者把「少一项」当遗漏顺手加上、反而引入假阴性。

## voidtech-product 0.6.0 - 2026-07-29

一次真实的实现可行性评审（架构师读一条完整链路，回答「照这个能不能开工」）给出了两类结果：模板里有章节对实现者零价值或负价值，以及一条已定案的编号格式在夹具里没被遵守。这一版把前者降成条件适用，把后者变成机械检查。

### Added

- 机械自检新增「已声明的编号格式必须被同段数的编号字面量满足」。定案会员号格式后只回扫了 OQ 编号、没回扫编号字面量，三处 AC 夹具因此留着定案前的旧形态；规则上线后立刻又抓出第四处（同一行里第二个字面量没跟着改）。规则自校准：一条正则只管「已经有合规实例」的前缀，因此 `^[A-Z]{2,8}-\d{5}$` 管 `HKSC-` 而不会去管 `OQ-`、`ARC-`；段数不同的编号（收据号三段 vs 会员号两段）互不干涉。

### Changed

- `§5.0.4 步骤权限合同` 由必填改为**条件适用**：模块内存在两个以上角色且操作有差异时才逐步骤铺表。纯访客模块（官网注册登录、站点渲染）写一行「不涉及」即可——实测中这类模块的该表除了重复 §5.0.1 的步骤清单没有新信息，只增加维护面。
- `§7.0.1 页面数据读写` 标明是 Logic Atlas 编译器的输入、不是给实现者读的：它与 `§5.0.2 流程状态影响` 按同一个键投影同一批步骤，必然走偏，而走偏时读到分歧的人要停下来判断哪张对。约定两条：冲突时以 §5.0.2 为准；不启用 Atlas 时整节写「不涉及」，不留没人消费又会漂移的表。
- `§13 需求追溯`、`§14 变更记录` 标明「治理章节，实现者不必读」，省掉实现者逐节确认「这里有没有规则」的成本。

### Notes

新检查有一处已知盲区，是自校准换来的：某前缀下全部字面量都是旧形态、没有任何合规实例时，规则不认领该前缀、什么都不报。它覆盖「新旧共存」，不覆盖「全量陈旧」——后者仍要靠定案时的回扫。这条覆盖是拿来换朴素版本在真实树上的 1314 条假阳性的，盲区与不误报两侧都由 `DeclaredIdFormatTest` 固化，避免后来者把盲区当缺陷「修掉」。

评审同时点出一类本版没有覆盖的缺口：模板声明 Logic Atlas 消费的表「表头与列序固定，不得改动」，但机械自检只校验章节存在且有数据行，不校验表头形状。实测工作树里已有文档改掉了这些表头。这条可以机械化，留待下一版。

## voidtech-product 0.5.0 - 2026-07-29

关掉三类不断复发的文档簿记缺陷。它们的共同成因不是「不够仔细」，而是契约把只能靠记性维持的不变量写进了产物：声明为「生成物」的汇总 PRD 没有生成器、变更记录承担了举证责任、核验没有终止条件。这一版把这三处交给结构，而不是交给自检规则。

### Removed

- 移除两级汇总 PRD（`full-prd.md`、`{system-slug}-full-prd.md`）这个产物，连同 `templates/full-prd.md`。它被声明为「生成物、勿手改」，但技能不分发生成器，实际是手抄的第二、第三份副本；实测一份 9000 行的根汇总吃掉了机械纠错预算的一半，而「整体评审」这个读者需求由 `README.md` 索引表和状态看板满足。机械自检现在直接拦下这类文件。
- 删除「派生」推断标记变体检查。字段定义表的「来源 = 派生」是合法取值（由其他字段计算得出），与「把推断写成派生」无法机械区分——留着就是纯假阳性。

### Added

- 变更记录固定四列 `日期 | 版本 | 主题 | commit`，机械自检校验表头与格内容：禁止数量对账、「某某已修完」、「更正上一版」、核验轮次。这类文本可判真伪但对实现者零价值，且缺陷会沿「正文 → 变更记录 → 对变更记录的更正」搬家，最坏形态是更正虚报的那句声明本身虚报。
- 新增「核验的打回门槛与终止条件」：缺陷分阻断项与卫生项，只有阻断项打回；一份文档最多两轮，第二轮只判阻断项是否清零。实测一份领域规格跑到十一轮，多数轮次处理的是不影响任何实现者的东西，而每轮修订自身都有引入新微缺陷的概率。
- 机械自检新增可判定项：逐字引文与 `_source/` 的一致性（标为「原文（逐字）」的表列必须能在权威源中原样命中）、表格前导句的规模声明与实际行数比对、引用方跨节复述表规模、治理文档（`deepening-backlog.md`）不写数目、未清零的返工标记。
- `generate-dashboard.py` 拒绝非工作树根目录：模块目录（含 `prd.md`）与缺 `00-global/` 的目录一律退出码 2、零写入，且不自行创建 `00-global/`。此前在错误目录下运行会留下一份没人维护的幽灵看板。

### Fixed

- `generate-dashboard.py` 不再把变更记录当数据源。追溯矩阵的区间解析原先扫描整个文件，把变更记录表的行也当映射读入，凭叙述里顺带出现的编号与模块名造出 `OQ-031 → 01-site-rendering` 之类的假映射——端到端路径视图正是靠这些假映射才「解析成功」。修复后它诚实报告无法推导，指向真实缺口。
- 修掉推断标记检查的两类假阳性（占实测告警的绝大多数）：模板固定列名「推荐默认方案」被当成漏标；「是原文而非推断」「挂推荐默认」「见推荐默认栏」这类谈论标记体系的行文被当成漏标。「默认…待确认」变体不再跨表格单元格边界匹配。同时写入规则：脚本报出的假阳性必须当场修脚本或删规则，留着它等于教所有人忽略整个告警通道。

## voidtech-product 0.4.0 - 2026-07-28

Logic Atlas 的场景评审不再只展示「缺少工程信息」：PRD 现在必须把事务、异步事件、状态结果、失败恢复和权限边界写成可追溯合同；读取器会保真呈现已声明的事件名、提交点和四维权限，不再把数据范围或字段可见性误当成操作权限。

### Added

- `prd-from-requirements` 增加跨系统工程合同规则：复合副作用必须声明事务边界、生产者/消费者、投递语义、幂等键、重放、失败影响、自动重试、人工接管、责任人和终止结果；无法确认的架构选择标为 `[推荐默认]` 并进入开放问题。
- 权限矩阵增加「操作权限 / 数据范围 / 字段可见性 / 越权拒绝行为」四维元数据。列名以「数据范围」或「可见性」结尾、或包含「拒绝行为」时，编译器将其附着到角色访问规则，不再生成虚假操作节点。
- 浏览器验证夹具新增事件名、事务提交点、重试幂等和权限维度的保真断言。
- 新增「流程 + 步骤 ID + 用途 + 执行角色 + 所需操作」步骤权限合同：编译器解析主操作、读取资源、异常恢复的精确权限引用，校验当前角色与转交角色的 `allow/deny`，并把恢复发起角色、实际执行角色和责任交接路径挂回失败分支。

### Changed

- 场景流程升级为可评审的「场景合同 + 评审就绪度 + 五个流程透镜 + 六段式步骤合同」：顶部直接声明目标、触发、前置、成功标准、参与方和范围外事项，以阻断/待确认/已满足替代纯数量统计；状态、数据、异常和权限留在同一主线切换，异常直接挂接触发步骤，缺失的状态影响、页面数据、恢复路径或权限规则可一键定位。二轮评审修复步骤与子事实选中冲突，增加场景级阻断结论和判定规则；顶部只保留三个最高优先级问题，其余问题进入可按步骤、透镜、严重程度过滤的列表；默认流程透镜仅展开当前步骤，跨系统连线和步骤合同保真显示同步/异步、事件、事务点、重试/幂等及失败影响，未声明项不推断。宽屏保留稳定 Inspector，窄屏以纵向主线和同页步骤合同恢复焦点与滚动位置。
- 场景步骤工程边界可从已声明正文中识别 `*.vN` 事件名与 `TX-*` 提交标识，并继续对未声明值明确显示缺口。
- 模块 PRD 模板和评审缺陷规则同步要求四维权限与跨系统工程合同；客户开通示例补全本地全成全败、两个领域事件、状态归宿、失败恢复和权限拒绝合同。
- 系统任务与事件消费者步骤可用 `—` 明确声明无 UI 上下文，不再借用结果展示页，也不再因缺少人类角色权限而被误判为越权阻断；其执行边界转由生产者/消费者和工程合同评审，数据范围、字段可见性与越权拒绝行为标记为非用户操作不适用。
- 非跨系统步骤将 `无`、`不涉及`、`不适用` 识别为无外部依赖，仅保留一行不适用提示；流程失败与页面边缘状态分别标注触发声明情况。步骤权限区把角色完整矩阵下沉为默认折叠的整行紧凑表格，并将权限表中的数据范围明确标为角色全局补充边界，不再暗示当前步骤读取该类数据。

### Compatibility

- `logicModelSchemaVersion` 保持 2；权限节点只追加可选元数据，`flow` 节点固定携带 `detail`。`generatorVersion` 1.7.0 → 1.8.0，Renderer / validation harness 9.0.0 → 10.2.1。旧 PRD 仍可编译，未声明维度继续显示「未单独声明」而不推断。


## voidtech-core 0.20.0 / voidtech-product 0.3.0 / voidtech-design 0.2.0 / voidtech-engineering 0.2.0 - 2026-07-27

Logic Atlas 从「展示所有结构」改成「帮助读者完成具体判断」。默认入口先回答从哪里开始、可以查什么和哪些信息仍缺失；高密度审计与关系图退到按需入口，避免把机器可读性直接当成人类可读性。

同一套 Core、Product、Design、Engineering 工作流现可安装到 Claude Code 或 Oh My Pi（OMP）。双宿主共享业务内容，但把 Hook、脚本执行和资源定位收敛到各自原生适配层；`voidtech-loop` 不做低保证降级，仍只支持 Claude Code。

### Added

- 新增默认「探索」首页，按用户任务进入场景流程、页面、数据与字段、访问规则、需求和来源。当前模型没有可机械证明的完整旅程契约，因此明确显示未声明；跨模块事实仍可从系统关系逐项浏览，不按标题相似度拼接伪旅程。
- Logic Model schema v2 新增 `field` 与 `permission` 节点。固定字段表保留对象、含义、类型、必填、来源、校验、可编辑、可导出和敏感标记；只有明确非敏感的字段才保留示例。新版权限模板新增固定的末列需求编号，编译器仍兼容旧矩阵；条件原文和冲突定义不被提升成无条件权限结论。
- 新增独立「数据与字段」「访问与可见性」视图，并将字段和访问规则纳入全局搜索；搜索无匹配时显示明确空结果。

- 新增 OMP marketplace catalog，发布 Core、Product、Design、Engineering 与两组独立 MCP；明确排除依赖 Claude Code worker、权限和 Hook 语义的 `voidtech-loop`。
- Core 新增 OMP Session Hook，在会话启动时注入中文协作约定与 OMP 对应的更新命令；更新检查仍只提示、不自动升级。
- Product 新增 OMP 原生 `voidtech_product_runtime` Tool：不经过 shell，统一启动 PRD 转换、机械检查、Dashboard、PRD Sync 与 Logic Atlas 脚本，并保留退出码、stdout 和 stderr。跨插件 Archify Runtime 同时支持 Claude Code 与 OMP 安装注册表。
- Engineering 的 Git Safety 新增 OMP `tool_call` 防护 Hook，与 Claude Code 版共享同一危险 Git 行为矩阵；Design brief 与公开 agents 改为双宿主工具语义。

### Changed

- 流程失败、页面边缘状态、交互失败恢复和成功后的状态影响改为四类可点击分支，不再压成一个「异常」计数。
- 页面详情采用渐进披露：首屏只回答入口、主体、前置条件、动作结果和可证明去向；数据与状态、异常与恢复、字段、访问规则、需求与来源按需展开。`mapped`、`none`、`missing`、`unparsed` 四种页面数据声明不再混成空白。
- 审计页改名为「质量与来源」，机械覆盖、内容深度、缺口和新鲜度分别展示；不再用单一健康数字暗示 PRD 内容正确。
- Product 三个工作流共用一份宿主运行说明，不再要求 OMP 解释 `${CLAUDE_PLUGIN_ROOT}`；MCP 插件继续使用独立、固定版本的 `.mcp.json`，不并入 Core。

### Compatibility

- `logicModelSchemaVersion` 1 → 2，`generatorVersion` 1.6.0 → 1.7.0。现有 PRD 主本无需强制迁移即可重新生成；未采用固定字段表的模块只会缺少字段视图，不会由编译器猜测补齐。
- 新生成的 Atlas 使用新版阅读界面；旧 HTML 仍可独立阅读，但不会获得字段、访问规则和新的缺失状态语义。重新运行 `atlas --publish` 完成升级。
- OMP 最低验证版本为 17.1.5；Core、Product、Design、Engineering 和两组 MCP 完成隔离安装冒烟，Claude Code 原入口与命名空间保持不变。
- OMP 通过 `omp plugin marketplace add VoidTechnology/voidtech-claude-plugins` 添加市场。`voidtech-loop` 不在 OMP catalog 中，不能在 OMP 安装；需要工程内循环时继续使用符合其试点条件的 Claude Code。


## voidtech-product 0.2.0 / voidtech-core 0.19.0 - 2026-07-27

Logic Atlas 此前答不出「数据在模块之间怎么流」：跨模块的数据读写关系是 0 条，跨模块页面跳转也是 0 条，读者看到的是一列列互不相连的方框。根因不是渲染，是编译器把「权威来源」当字符串存进节点属性，从没变成边。本次把它编译成关系并画出来，同时修掉一个会让任何较大图静默降级的渲染基础设施缺陷。

### Added

- 数据对象按「标题 + 权威来源」判定同一逻辑对象，新增 `owns`（主本模块拥有该对象）与 `shares`（同一对象的跨模块副本）两类关系。归并只认两个声明键字面相等，不按语义猜测同名对象；声明不一致时不归并，改为如实记录口径冲突缺口。
- 模块视图新增「跨模块 / 主本」一列：主本模块可点击跳转，领域规格只读展示。门户与机构后台之间的会籍、入会订单、账号等接缝首次可从图上走通并往返。
- 模块级数据契约（原文已声明「本模块读/写该对象」但未下推到页面）现在画在独立的「本模块契约」轨道上，用点线与页面级读写明确区分，读者能一眼看出这条关系精确到页面还是只到模块。
- 未参与任何页面级读写的页面标注「未声明数据读写」，区分「本页确实不碰数据」与「PRD 没写」。
- 系统关系总览同时呈现模块调用与数据流：数据流走虚线、调用走实线、两者兼有的加重。

### Fixed

- vendored Archify 的 `deliver` 用管道读取产物检查回执，而检查脚本在输出大 JSON 后立即退出，管道上未排空的部分被丢弃（约 64KB 截断）。任何回执超限的图会被误判为交付失败并整体降级为内建后备图。改为从调用侧重做渲染与检查、回执经文件读取；不修改 vendored 代码，也不复制其诊断分类逻辑。此前该缺陷把总览图的可增长上限压在约 24 条连接。
- 总览连接密度改为按几何自适应：列间隙宽度由该间隙实际承载的车道数与最宽标签算出，需求大就撑开画布，绝不因放不下而丢关系。外侧通道改用标签纵向错开，避免横向撑宽把画布拉到看不清。同一条间隙上的跨列与列内通道各占互不重叠的一段，修掉两者独立分车道可能压线的既有隐患。

### Compatibility

- `logicModelSchemaVersion` 保持 1：新增边类型、数据对象字段与缺口上下文键均为追加，既有模型仍可校验通过。
- 生成器版本 1.5.0 → 1.6.0。已发布的 Atlas 需重新生成才会出现新关系；不重新生成不影响既有产物可读。
- 渲染器验证证明已重签。

## VoidTech Product Delivery Suite 0.1.0 / voidtech-core 0.18.0 - 2026-07-24

将原先集中在 `voidtech-core` 的产品、设计与工程工作流按交付责任拆成四个独立插件；Core 只保留共享约定、跨领域能力和唯一 Archify Runtime。此次为一次性命名空间迁移，不保留旧命令别名。

### Added

- 新增 `voidtech-product 0.1.0`：`prd-from-requirements`、`prd-maintain`、`prd-sync` 与 `product-manager` agent；完整迁移 PRD templates、references、scripts、tests、assets 与 Logic Atlas 适配代码。
- 新增 `voidtech-design 0.1.0`：`to-design-brief` 与从原 `prototype` 明确更名的 `ui-prototype`，区分 UI 结构试验与工程逻辑试验。
- 新增 `voidtech-engineering 0.1.0`：架构、实现、调试、TDD、Issue、Git 与发布技能，以及 `architect` agent；原 `prototype` 的状态/逻辑/TUI 部分独立为 `logic-spike`。
- Product 的 Logic Atlas 通过 `core_archify` adapter 定位已安装的 `voidtech-core` 并复用唯一 Archify Runtime；Core Runtime 暴露稳定的 `architecture_ir`、`archify_bridge`、`lifecycle_ir` 接口，不复制 vendor。

### Changed

- `voidtech-core` 收口为 6 个公共技能与共享 Archify Runtime，版本 0.17.2 → 0.18.0。
- Marketplace、默认项目配置、README、USAGE 与可移植性门禁更新为四插件架构；隔离安装冒烟同时验证跨插件 Runtime 解析、脚本执行权限和 27 个现有技能 / 2 个 agent 的精确归属。
- 公开命令改为 `/voidtech-product:*`、`/voidtech-design:*`、`/voidtech-engineering:*`；原 `/voidtech-core:*` 迁移命令不再保留兼容入口，避免命令重复和长期双轨。

## voidtech-core 0.17.2 - 2026-07-24

状态机布局返工：0.17.1 的打磨在放大目检下暴露三个真问题——互转小环同列堆叠导致节点叠压、长中文子标签溢出状态盒互压、vendor 校验器按拉丁口径估宽且不查子标签使上述缺陷可静默过 fail-closed 门禁。本次修根因并补上 CJK 感知的机器守门。

### Fixed

- 互转 SCC 不再同列 yOffset 堆叠：小环成员沿列展开为横链（分量内入口态在前，确定性排序），环的返程边统一走顶部通道与正向直边分离——消除节点叠压、边穿标题（客户套餐 3 态由堆叠改为 0→1→2 横链）。
- 子标签适配：`font-size:7` 单行子标签按 CJK 估宽（全宽 ≈7px/字）超过最窄状态盒（118px 留边距）时不上画布，完整文本仍在「状态与流转来源」面板——消除子标签横向溢出互压。
- viewBox 右侧预留改为按需：仅存在右向回环通道时才预留 160px，否则只留描边边距。

### Added

- `archify_bridge.svg_text_overflows`：CJK 感知的 SVG 文本几何审计（任何文本越出 viewBox、子标签估宽超状态盒即违规），接入 `render_machine`——违规机器降级为内建状态图并标注 `artifact/text-overflow`，此类缺陷从此进不了发布产物（vendor 校验器测不出 CJK 溢出，这是本次漏网的机制性原因）。
- 新增布局与审计单测 2 项（199 全绿）；RENDERER_VERSION 8.2.0 → 8.3.0，proof 重签。

### Known

- vendor 三带（主生命周期/中断与恢复/结果）为固定几何：无节点的中带仍绘制横带留白、图例保底宽 652px——实证收窄会触发标签落点回撞状态框，判定为 vendor 版面语言固有留白，长期解为向上游提 compact 模式（backlog）。
- 高密度机器（4 态 6 边）中近似标签的归属仍需借助追溯面板确认（如会籍两条「被机构移除」边）。

### Changed

- 核心插件版本 0.17.1 → 0.17.2。

## voidtech-core 0.17.1 - 2026-07-24

Logic Atlas 状态机与场景流程呈现打磨：只调渲染层，不改内容抽取与数据契约。收束五个「给人看」的缺陷，18 张真实状态机 deliver 全绿、0 呈现降级、无新增 gap，同输入两次发布字节一致。

### Added

- 已声明终点可见：mermaid `X --> [*]` 出口不再被丢弃。当声明出口的状态仍有后继流转（终点被丢、结果带空）时，Lifecycle IR 在结果带补一个显式「已声明终点」标记（`neutral`，非业务状态、不进 `stateNodeIds`），出口边指向它并原样带上 `terminalResult` 标签；结构性终态已自证，不重复标注。仅依据已声明 `declaredTerminal` 生成，绝不凭空造终点（本次 5 张机器命中）。
- renderer harness 新增断言：导入的 Lifecycle SVG 内无 `data-legend-bridge`（英文图例已移除）、已声明终点标记可见且状态数多于业务状态数、场景连线无空/「—」占位标签。

### Changed

- 画布密度：Lifecycle IR `meta.viewBox` 按内容外接框收紧（列心由渲染器固定，收紧只去除右侧/底部空白，状态坐标不变）——小状态机由 `[980,660]` 收到 `[652,566/660]`，不再「内容挤一角 + 全屏空白」；结果带无节点时高度收到 schema 下限 566。
- 泳道中文化：`main/branch/terminal` 标签统一为「主生命周期 / 中断与恢复 / 结果」；结果带仅在确有节点时声明。
- 边标签贴边：流转标签不再预置栅格槽位（旧行为使标签漂到画布中部），改由渲染器按边中点自动贴边，仅冲突时经 archify fail-closed validator 有界微调；同列往复流转仍走通道并在通道处标注。
- viewer 8.2.0：`importLifecycleSvg` 确定性移除 Archify 内置英文 Legend（`g[data-legend-bridge]`），消除与 Atlas 中文图例重复；场景流程连线在 condition 为空/「—」时不再输出标签节点。
- 渲染桥并发化：18 台机器的渲染/修复循环相互独立，改为按机器次序并发回收（同输入字节一致），发布耗时约 9s → 2s。
- viewer 8.1.0 → 8.2.0、renderer harness 8.1.0 → 8.2.0、核心插件 0.17.0 → 0.17.1。

## voidtech-core 0.17.0 - 2026-07-24

Logic Atlas 状态机视图正式接入 vendored Archify Lifecycle：默认以唯一状态节点和有向流转展示真实生命周期；Node 或图形校验不可用时，仅该状态机降级为内建状态图并标注呈现风险，不阻塞 PRD 内容门。

### Added

- 新增确定性 Lifecycle IR：按业务对象分组，使用 SCC 缩点与最长路径分配 lane/column，冻结状态类型关键词、IR 排序和摘要。
- 新增 Archify 渲染桥：调用插件内零 npm 依赖的 Node 子系统，按机器诊断做不超过 8 轮的受限修复，内联唯一 SVG，并保留 Atlas 来源追溯面板。
- 渲染器证明新增 `archifyDigest`；浏览器 harness 同时验证真实 SVG、状态标签唯一性、控制台清洁及 Node 缺失降级路径。

### Changed

- generator 1.5.0 改为只从 `stateDiagram-v2` 逐边提取流转；按状态表仅提供节点元数据，不再将动作与下一状态做笛卡尔积。共享 Mermaid 图按对象当前/下一状态裁切，避免跨对象串边；缺逐边来源时进入可审计 gap。
- viewer 8.1.0、renderer harness 8.1.0：状态机 tab 优先展示 Archify Lifecycle SVG；修复 HTML 合法但 XML 不合法的 valueless `data-*` 属性导入，并对 SVG 做同一套严格清理。
- Example PRD 的 13 个可提取状态机全部通过 Archify fail-closed deliver；「用户与会员」模块 6 张图均为真实 SVG，每个状态标签只出现一次。
- 核心插件版本 0.16.0 → 0.17.0。

### Fixed

- 修复 Archify SVG 导入后整体渲染为黑块：SVG 为纯类名着色，样式与主题变量留在其宿主模板里未随导入搬运，全部元素回落默认 `fill:black`。生成端现从 vendored 模板确定性抽取 SVG 语义类与 preset 主题变量，作用域化到 `.archify-lifecycle-svg` 并随 payload 单份下发，viewer 注入并桥接 Atlas 明暗主题；样式抽取失败或缺失时该状态机降级为内建状态图，绝不裸嵌无样式 SVG。浏览器 harness 新增计算样式守门（style 标签存在 + 状态文本 computed fill 非黑）。

## voidtech-core 0.16.0 - 2026-07-24

Logic Atlas 从「图形化展示」收口为 PRD 质量审计入口：默认首页先回答覆盖率、模块健康、需求反向追溯和待补齐缺口，再按需进入业务场景、生命周期与模块边界。

### Added

- 首页新增覆盖率与模块健康驾驶舱：显示模块、页面、场景、状态、需求、页面数据读写和未结构化模块，并可直接下钻问题模块。
- 新增需求摘要与反向追溯中心；页面与数据对象的读写关系只接受 PRD 显式 `页面数据读写（机器可解析）` 表，不按同名或邻近文本猜测。
- 验收级模块强制具备六类非空审计结构；纯服务模块必须写明「不涉及：原因」，缺表、空表或缺少关系均阻塞门禁。
- 状态流转边分别保留动作与结果；显式 `终态（结果）` 不再伪装成业务状态。状态图按对象分组去重，同一状态只出现一次。

### Changed

- generator 1.4.0、viewer 7.0.0、renderer harness 7.0.0：模板缺口折叠为单一待补齐入口，详情卡移除 Markdown 与本地路径泄漏，来源恢复为可点击精确锚点，切换视图自动关闭旧详情。
- Example PRD 完成 5 个验收级模块试点；后台会籍、支付，以及门户账号、会员中心、报名模块补齐状态、交互、页面数据读写与模块依赖关系。
- 核心插件版本 0.15.0 → 0.16.0。

## voidtech-core 0.15.0 - 2026-07-24

引入 archify（MIT, v2.12.0 @ eb847fa）作为 Logic Atlas 的类型化图渲染基础设施：五种图型（Architecture / Workflow / Sequence / Data Flow / Lifecycle）的 typed JSON IR + 预编译 schema 校验 + fail-closed 布局验证 + 确定性 SVG/HTML 渲染，运行时零 npm 依赖（Node >= 18）。

### Added

- `prd-from-requirements/vendor/archify/`:保留 bin、renderers(含预编译 validators)、schemas、assets/template.html、delta、recipes、scripts 与上游 SKILL.md;裁剪 examples(仅留 doctor 必需的 7 个示例)与上游测试,来源与升级方式见 `vendor/archify/VENDOR.md`。
- 接线纪律:Atlas 仅对已有真实关系数据的图型接线(首个目标为 Lifecycle 状态机视图);Architecture/Sequence 等上游数据具备后再启用,禁止对空数据渲染虚构关系。
- 验证:`archify.mjs doctor` 全绿;五种图型 validate+deliver 冒烟通过;以示例项目「会籍」状态机真实数据(5 状态 7 流转,membership §2.2 + MBR-016/018/023)手工构建 IR 渲染验收——每个状态仅出现一次,终态无出边可直读,上游 action 字段按状态整团复制的抽取缺陷在图上直接显形。

### Changed

- 核心插件版本 0.14.0 → 0.15.0。

## voidtech-core 0.14.0 - 2026-07-24

Logic Atlas 视觉表达按信息语义分型：业务流程用角色泳道 Workflow，生命周期用状态图，系统关系保留 Architecture 图；不再用一套卡片布局承载所有问题。

### Added

- 内联 SVG 语义图标系统覆盖模块、页面、角色、操作、条件、即时反馈、系统动作、成功、异常、依赖及生命周期起点/过程/终点；保持完全离线、零外链和文本转义边界。
- 场景主流程按角色生成横向泳道，S1/S2/S3 以正交箭头跨泳道连接并标注条件；步骤卡保留页面、动作、成功结果、下一步和来源入口，下方继续展开页面交互轨迹。
- 生命周期视图新增起点/过程/终点图例和差异化节点语义；系统关系图新增架构节点类型图标。技能文档明确 Markdown 固定表是权威输入，Atlas 负责按问题类型生成可视图。

### Changed

- viewer 6.0.0 与 renderer harness 6.0.0：浏览器验收新增角色泳道、流程连线、交互字段图标、生命周期图例/起终点及架构节点图标断言。
- 核心插件版本 0.13.0 → 0.14.0。

## voidtech-core 0.13.0 - 2026-07-24

Behavioral Atlas 从单层业务行为图升级为「业务场景 + 步骤内页面交互」两层模型：既保留可读的业务主线，也能直接回答每一步在哪个页面、操作什么、何时可用、即时反馈、系统动作、成功结果、失败恢复和下一操作。

### Added

- 模块 PRD 新增 `§5.0.3 页面交互（机器可解析）` 固定表；generator 1.3.0 编译 `interactionStep` 节点、`interaction-success` 成功关系及 step/page/stateImpact/pageState 追溯，校验交互 ID、事件白名单、唯一入口、断头、循环与可终止性，坏引用 fail closed 进入 gaps。
- 页面引用支持精确的 `<module-scope>::<页面名>` 跨模块语法；核心流程与页面交互共用解析器，目标模块或页面未结构化时不按同名猜测。
- renderer fixture 与 CDP 浏览器 harness 覆盖步骤切换、唯一展开轨迹、状态/异常精确挂载、页面级横向裁切防护、XSS、零外链及 console/page error。

### Changed

- viewer 5.0.0：主流程卡只保留场景摘要并严格对齐箭头；点击 S1/S2/S3 后在下方展开当前步骤的页面交互卡网格，状态变化与异常绑定到具体操作，跨模块/外部依赖保留独立泳道，来源抽屉保留为二级入口。
- 核心插件版本 0.12.0 → 0.13.0；Logic Model schema 继续为 v1，仅使用既有开放 `detail` 与 node/edge 类型并增加 `interactionCount` 覆盖统计。

## voidtech-core 0.12.0 - 2026-07-23

prd-sync/Logic Atlas 引擎(五门全通)的 skill 层接线交付:引擎能力首次获得面向使用者的命令入口。ADR-0004 第三阶段(overriding 完整流程、复活候选、多可更新源)仍为后续工作。

### Added

- 新公共技能 `prd-sync`(`/voidtech-core:prd-sync`)与 CLI `skills/prd-from-requirements/scripts/prd-sync.py`:13 个子命令(status/migrate/sync/rebaseline/propose/confirm/lifecycle/retire-source/invalidate-assertions/register-change/recover/atlas,atlas 含 `--enable <stage>` 能力阶段置位),统一退出码契约(0 成功 / 1 错误 / 2 用法 / 3 读取栅栏 / 4 需人工裁决),支持 `--json`;单 versioned 源自动推断,多源必须显式 `--source`。
- 渲染器浏览器验证 CI(ADR-0005 §8):`scripts/validate-renderer.mjs`(零 npm 依赖,自带最小 CDP 客户端驱动 headless Chrome)+ `.github/workflows/renderer-validation.yml` + 渲染器验证证明 `assets/renderer-validation-proof.json`(七继承键,真实浏览器断言签发)。渲染器升级至 viewer 3.0(`assets/logic-atlas-viewer.html`):在模块关系图之上新增用户流程、业务状态机、边界与异常三种可复核视图;核心流程显示页面级步骤、条件、成功结果、失败分支与需求来源,状态机解析本地状态表或领域规格引用,边缘状态可显式绑定单页/多页。generator 1.1.0 新增 flow/state/boundary 节点与 navigates/transition/traces 边,缺表、坏引用与断头步骤如实进入 gaps;全部脚本样式内联零外链,模板即资产本体,`assetDigest` 覆盖模板字节故改模板即失效旧证明。
- 新测试模块 `test_cli`(12 用例)、`test_check_prd_tree`(6 用例)、`test_renderer_env`(4 用例),全部接入 check-portability 已过门套件。
- Behavioral Atlas 统一场景流程：generator 1.2.0 新增步骤级 `stateImpact` 契约与 `state-impact-step` / `page-state-step` 追溯，严格校验流程步骤、权威状态流转和模块/外部依赖，坏关联进入 gaps；viewer 4.0.0 将主流程、状态变化、折叠异常和跨模块/外部依赖泳道整合到单场景视图，新增场景选择器并设为默认入口，完整状态机与边界审计视图保留。模块模板新增「流程状态影响」表，边缘状态表新增步骤 ID；Example「入会审批与缴费」试点发布 3 步、3 条状态影响、12 条步骤级页面异常。

### Changed

- `check-prd-tree.py` 改造(技术设计 §9):正则类检查迁入 `prdsync/markdown_validator.py`;默认严格只读,发现 publishing/publish-conflict 返回退出码 3 且零写入;默认扫描经 overlay resolver 排除 `_source/reconciliation/`;`--operation-id` 检查预提交合成视图(同一逻辑文件只出现一次);logicAtlas 开启的工作树追加 Atlas 新鲜度检查,带外修改报 stale。legacy 工作树输出与退出码与改造前逐字节一致(已对照验证)。
- `prd-maintain` 接线:新增工况 5(需求撤回、废弃、替代与移除——四套剧本、部分撤回拆分规则、工况 5 收尾机械检查);工况 2 按能力分叉(已迁移树源文件新版本一律走 prd-sync,带外变更 register-change);收尾不变式按能力分层(已迁移树经 operation overlay 走内容门、退出码 3 先 recover、Atlas 随 operation 发布不手工重生成)。
- `prd-from-requirements`:机械自检段补退出码语义与 `--operation-id` 说明;追溯矩阵模板补六列生命周期投影字段(ADR-0004 §7)。
- 核心插件版本 0.11.2 → 0.12.0;技能集合 25 → 26(ADR-0002 登记 `prd-sync`);USAGE.md 同步。

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
