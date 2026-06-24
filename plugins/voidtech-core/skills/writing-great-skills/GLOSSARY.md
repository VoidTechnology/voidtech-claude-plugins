# 术语表 — 打造优秀技能

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

关于「是什么让一个技能变得优秀」的领域模型。技能的存在是为了从一个随机系统中拧出确定性；下文每一个术语都是作用于这一目标的杠杆。这是 [`writing-great-skills`](SKILL.md) 的已披露 reference。

任何定义中的 **加粗术语** 自身也在本术语表中有定义；按其标题查找。

## 语言（Language）

### Predictability（可预测性）

一个技能让 agent 在每次运行时表现出相同 *方式* 的程度——相同的过程，而非相同的输出（一个头脑风暴技能应当 *可预测地* 发散；它的 token 各不相同，行为却始终如一）。它是其他每个术语所服务的根本美德——成本与可维护性是它的症状，而非与它对立的对手。

_Avoid_: consistency, reliability, robustness, output-determinism

### Model-Invoked

一个保留其 **description** 字段的技能，于是 agent 能看到并自主触发它——人类仍可输入它的名字，所以 model-invocation 始终 *包含* user 可达。不存在「仅模型」的状态：description 永远只会 *增加* agent 的发现能力，绝不会移除人类的可达。代价是每一轮都付出一份永久的 **context load** 以换取这份可发现性。它可被其他技能调到，因为让它对 agent 可发现的那个 description，也让它可被调用。一个内容全是 **reference** 的 model-invoked 技能，同时也是共享 reference 的一个落脚处：另一个技能可以调用它，于是被多个技能需要的 reference 就活在一个地方。仅当 agent 必须自行调到该技能时才选 model-invocation；如果它除手动外从不触发，就删掉 description，不付 context load。

_Avoid_: ability, tool, capability

### User-Invoked

一个 **description** 被剥除的技能——对 agent 不可见，只能由人类输入它的名字来调到（user-*only*，而 **model-invoked** 是 user-*and-agent*）。它用 agent 可发现性换取零 **context load**。因为它没有 description，除了人类没有任何东西能调到它：其他技能都无法触发它。

_Avoid_: procedure, workflow, command

### Description

技能那段机器可读的触发器，也是一个 **model-invoked** 技能被迫始终保持加载的唯一 **context pointer**。它的存在本身 *就是* 那条触发轴：保留它，技能就是 model-invoked（且可被其他技能调到）；删除它，技能就成为 **user-invoked**，只有人类能调到。它是一个 model-invoked 技能 **context load** 的来源。

_Avoid_: frontmatter, summary

### Context Pointer

一份持于 agent 上下文中的引用，它指名某段在上下文之外的材料，并编码了调到它的条件。**description** 是顶层的 context pointer（上下文窗口 → 技能）；指向已披露文件的指针是同一种对象在下一层的体现。是它的措辞、而非其目标，决定 agent *何时* 调到——以及 *多可靠地* 调到。一个必备目标若藏在措辞薄弱的指针之后，就是一个方差 bug：先修措辞，只有在磨利失败时才把材料内联。

_Avoid_: link, reference, import

### Context Load

一个 **model-invoked** 技能强加于 agent 上下文窗口的成本——它那段始终加载的 **description**，既花 token 又花注意力。这正是 **user-invoked** 技能因没有 description 而得以逃脱的东西，也是拆分出更多 model-invoked 技能的刹车。

_Avoid_: token cost, context bloat

### Cognitive Load

一个 **user-invoked** 技能强加于人类的成本——他们必须记在脑子里的东西：有哪些技能存在、以及何时该调用各个（人类就是那个索引）。这正是 **model-invocation** 通过对 agent 可发现而移除的东西，也是拆分出更多 user-invoked 技能的刹车。它不是一个要最小化的成本：它是人类能动性的代价，是某些技能保持 user-invoked 的理由。在人类判断要紧之处花掉它；在不要紧之处移除它。

_Avoid_: human index, burden, overhead

### Granularity（粒度）

你把技能划得多细。更细的划分会花费两种 load 之一：更多 **model-invoked** 技能花 **context load**（更多 description 挤占窗口、争夺注意力）；更多 **user-invoked** 技能花 **cognitive load**（人类要记住和调用的更多）。两种切法引导这一划分。**按触发（invocation）**，在你有一个独特的 **leading word** 去触发它时——一个你在提示里真正会用的触发词——拆出一个 model-invoked 技能。**按序列（sequence）**，在一个 step 的 **post-completion steps** 需要被藏起来时拆开一串 **step**，因为把它孤立到自己的上下文里能清掉其后续。当心反向操作：合并序列会把每个 step 的 post-completion steps 暴露给其后续，招致 premature completion。

_Avoid_: chunking, modularity

### Router Skill

一个 **user-invoked** 技能，它的职责是指向你的其他 user-invoked 技能——为每个命名并说明何时该调用它——好让人类只需记住一个技能，而非许多。它只能提示，绝不能触发它们：user-invoked 技能没有 **description**，所以除了人类没有任何东西能调到它们。它是当 user-invoked 技能增多时治 **cognitive load** 的解药。

_Avoid_: dispatcher, menu, registry, index, router procedure

### Information Hierarchy（信息层级）

一个技能的内容，按 agent 多急需它来排序——一道单一的阶梯，由两次切割产生：在文件内或在指针之后，以及 step 或 reference。各档为：

- **Steps**——在文件内，最顶层
- **Reference**，在文件内——次级
- **Reference**，已披露——在一个 **context pointer** 之后

一个没有 **step** 的技能只用底下两档——常常是一个名正言顺的扁平同辈集（例如一次评审的每条规则都在同一档上），这是一种合理的安排，而非坏味道。该层级独立于触发方式：无论一个技能全是 step、全是 reference 还是两者兼有，它都可以是 model- 或 user-invoked。当一个技能有 step 时，本应被披露却留在文件内的 reference 会把 step 埋掉，并把「是否关注到它们」变成一次抛硬币——这是一根方差杠杆，而不只是可读性杠杆。让阶梯顶部保持清晰可读；能往下推的尽量往下推。

_Avoid_: structure, organization, layout

### Co-location（就近放置）

把 agent 需要同时取用的材料放在一个地方——一个概念的定义、规则与注意事项同处一个标题之下，而非散落整个文件——于是读到其中一部分，就把它的邻居一起带了出来。它是 **Information Hierarchy** 在文件内的同伴：层级排序 *一段内容往下多远*；co-location 决定它落定后 *旁边坐着什么*。一段 **reference** 的正确格式没有公式可循；判据是：一个技能应当读起来像是为 agent 写的文档，而分组过的材料读起来就是那样，散落的材料则不然。它有别于 **Duplication**：后者把一个含义重复在两处，而散落是把单个含义碎裂到多处。

_Avoid_: grouping, clustering, cohesion

### Branch（分支）

一个技能可被触发的一种不同方式——技能所处理的一种情形——于是不同的运行在它之中走不同的路径。一个有许多 step 的技能可能携带许多 branch；一个线性的技能则没有。

_Avoid_: path, case, fork

### Progressive Disclosure（渐进披露）

把 **reference** 沿阶梯往下移——移出 SKILL.md、放到一个 **context pointer** 之后——好让顶部保持清晰可读。它主要不是一种 token 优化；它是 **information hierarchy** 受到保护的方式。它由 **branching** 授权：披露只有部分 branch 需要的内容，内联每条路径都需要的内容；如果某个指针在必备材料上触发不可靠，就磨利它的措辞，仅在那也失败时才把它拉回内联。

_Avoid_: lazy loading, chunking

### Steps（步骤）

agent 执行的有序动作——当一个技能拥有它们时，它们是其内容的最顶层，也是赢得在 SKILL.md 中占位的那部分。并非每个技能都有 step：一个技能可以全是 step（`tdd`）、全是 **reference**（一次评审），或两者兼有，与触发方式无关。每个 step 都以一个 **completion criterion** 收尾，无论清晰还是含糊。

_Avoid_: workflow, instructions, choreography

### Completion Criterion（完成判据）

告诉 agent 一个工作单元已完成的条件——它据以判断的标的。两个属性使它成为一根杠杆，而不只是一项品质。它的 **清晰度（clarity）**（agent 能区分「完成」与「未完成」吗？）抵御 **premature completion**——一个含糊的界限（"understanding reached"）会让 agent 宣告完成并滑向下一步；这条轴需要 *step* 才能咬合，因为 premature completion 是一种「步与步之间」的失败。它的 **要求量（demand）**（它要求多少）设定 **legwork**——"every modified model accounted for" 强制做彻底的工作，而 "produce a change list" 不会——而这条轴 *不* 受 step 束缚：它也能约束一段扁平 reference，这正是一个没有 step 的技能仍然携带一条穷尽性标准（"every rule applied"）的方式。最强的判据兼具可检验与穷尽两者。

_Avoid_: done condition, exit condition, stopping rule

### Post-Completion Steps（后续步骤）

紧跟当前 step 之后的那些 **step**。可见时，它们把 agent 往前拽进 **premature completion**——它看到的越多，拉力越强；防御之法是把它们藏起来，方式是把这串 step 拆成两段。

_Avoid_: horizon, fog of war, lookahead

### Legwork（跑腿活）

agent 在单个 step 内部、台面之下所做的工作——读文件、探索代码库、做改动、自己挖出它需要的东西，而非把活推给用户。它活在 step 结构之下：从不被写成一个独立的 step，而是潜伏在措辞中，由 agent 而非技能掌控。它是 **post-completion steps** 那种「跨步拉力」在「步内」的对应物。它被一个 **leading word**（_comprehensive_、_thorough_）或一个要求工作做到穷尽的 **completion criterion** 抬升——包括应用于扁平 reference 的「要求量」轴，正是这驱动一个由扁平 reference 构成的技能去覆盖它所有的档。当那份要求缺失时，或当 **premature completion** 把 step 切短时，它就会变薄。

_Avoid_: scope, effort, diligence, coverage

### Reference（参考）

agent 按需查阅的材料——定义、事实、参数、示例、条件性指令。当一个技能有 **step** 时，它次于 step；当一个技能没有 step 时，它就是全部内容；或者它彻底活在任何技能之外——见 **External Reference**。它通过 **context pointer** 被调到，是 **progressive disclosure** 的首要候选。

_Avoid_: supporting material, docs, background

### External Reference（外部参考）

活在技能系统之外的 **reference**——一个普通文件，没有 **description**、没有 **step**、不可被调用——任何技能都能指向它。它是那些无需自行触发的共享 reference 的归宿，也是两个 **user-invoked** 技能唯一能共用的共享归宿，因为二者都没有 description，所以谁也无法触发对方。

_Avoid_: doc, resource, knowledge base

### Leading Word（引领词）

一个紧凑的概念——也叫 *Leitwort*——已活在模型的预训练里，agent 在运行技能时会用它来思考。它通过调动模型已经持有的先验，用尽可能少的 token 编码一条行为原则（例如 _lesson_、_proximal zone of development_、_fog of war_、_tracer bullets_）。作为一个 token、而非一句话被反复使用，它在整个技能中积累起一个分布式的定义，并锚定一整片行为区域。自创一个词也行，前提是你把它定义清楚，但一个生造的词不调动任何先验——你用定义 token 付出了一个预训练词免费给你的东西。先伸手去找一个现成的词。

一个引领词两次服务于 **predictability**。在正文中它锚定 **execution**——每当那个概念出现，agent 就伸手去拿同样的行为，而在扁平 reference 内部，它把注意力聚焦到某一类要留意的东西上，每次运行都调动起对的检查。在 **description** 中它锚定 **invocation**——而且不止在技能之内：当同一个词活在你的提示、你的文档和你的代码库里时，agent 会把这份共享语言与该技能关联起来，从而更可靠地触发它。用你在想要某个技能时真正会用的那些引领词来撰写 description。

_Avoid_: keyword, term, motif

### Single Source of Truth（唯一真相来源）

一种理想状态：每个含义恰好活在一个权威的地方，于是对技能行为的改动就是一处的改动。**Duplication** 是它的违背。

_Avoid_: home, canonical location

### Relevance（相关性）

一行是否仍关乎这个技能所做的事——决定保留什么的透镜。一行失去相关性，要么是它从不关乎任务（纯属铺陈，或一个本应被披露的 **branch**），要么是它变陈旧：随着它所描述的行为或世界变化而逐渐过时。更短的技能更容易保持相关，因为每一行检查起来更便宜。它有别于 **no-op**：相关性问的是一行是否关乎任务，而非它是否改变行为。

_Avoid_: load-bearing, staleness, freshness

## 失效模式（Failure Modes）

### Premature Completion（过早完成）

在当前 step 真正完成之前就结束它，因为 agent 的注意力滑向了「已经完成」而非工作本身。这是一种「步与步之间」的失败：它需要有 **step** 才会发生——一个没有 step 的技能若提前收手，那不是 premature completion，而是要求未被满足之下的薄 **legwork**。它是两股力量的拔河：可见的 **post-completion steps**（往前的拉力）与 **completion criterion** 的清晰度（阻力——锋利、可检验的界限能顶住；含糊的界限则松手）。含糊是必要条件：一个锋利的界限无论后面有多少 step 可见都顶得住拉力，所以一个从不草率的 step 无需防守。两根杠杆能顶住一个会草率的 step，但要按顺序去拿：**先磨利界限**——它局部且廉价。只有当判据不可化约地含糊 *并且* 你确实观察到了草率时，才去 **把后续 step 藏起来**——而藏只有跨越一个真正的上下文边界才管用（一次 user-invoked 的交接，或一次子 agent 派发；一次内联的 model-invoked 调用会把后续 step 留在上下文里，什么也清不掉）。它是薄 legwork 的一个成因，但与之有别：哪怕一个 step 跑到了完整完成，legwork 也可能是薄的。

_Avoid_: premature closure, the rush, rushing, shortcutting

### Duplication（重复）

同一个含义被给了不止一个 **single source of truth**。它花维护成本（改一处，你必须改其余处），花 token，并抬升显著度——重复一个含义会把它在阶梯上的权重抬过其真实排位。它是 **leading word** 的意外反面，后者通过重复一个 token（而非含义）有意提升注意力。

_Avoid_: repetition, redundancy

### Sediment（沉积）

旧内容的层层堆叠，沉积在技能里且从不被清除，因为添加感觉安全、移除感觉危险——于是陈旧、无关的行不断累积，你必须钻穿它们才能找到仍然鲜活的东西。它是任何没有修剪纪律的技能的默认归宿；它是 **relevance** 的缓慢侵蚀，与 **duplication** 的「重复含义」相对。

_Avoid_: accretion, bloat, cruft, rot

### Sprawl（蔓生）

一个技能单纯太长——SKILL.md 里行数太多——与这些行是否陈旧或重复无关。哪怕一个全鲜活、全唯一的技能也能蔓生。它花可读性（agent 在能动手前要趟过更多内容，注意力也在冗余中变薄）、可维护性（每多一行就多一行要保持 **relevant**）以及 token。解药是 **information hierarchy**：把 **reference** 往下推到 **context pointer** 之后，并按 **branch** 或序列拆分，让每条路径只承载它需要的内容。它有别于 **sediment**（长度来自陈旧累积）与 **duplication**（长度来自重复含义）——sprawl 就是长度本身，无论其成因。

_Avoid_: bloat, length, size, verbosity

### No-Op（空操作）

一条什么也不改变的指令，因为模型默认就会照做——你付出 load 去告诉 agent 它本来就会做的事。测试：相对于默认，一行改变了行为吗？一行可以完全 **relevant** 却仍是 no-op。让 **leading word** 免费的那同一批先验，也让 no-op 一文不值。

leading word 是一项 *技法*；No-Op 是对一行的一个 *判决*——两者交叉。一个弱到无法压过默认的 leading word 就是 no-op（agent 已经差不多够仔细时还说 _be thorough_），解法是一个能通过判决的更强的词（_relentless_），而非另换一种技法。所以 No-Op 测试——相对于默认它改变行为吗？——也是你评判一个 leading word 是否配得上它那些重复的方法。这是相对于模型、而非相对于读者的：两个人就「某行是否 no-op」争执不下，争的其实是默认行为，靠运行技能、而非靠辩论来裁决。

_Avoid_: redundant instruction, restating the obvious, belaboring
