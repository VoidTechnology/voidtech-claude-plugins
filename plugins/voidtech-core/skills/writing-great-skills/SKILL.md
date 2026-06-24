---
name: writing-great-skills
description: 关于如何把技能写好、改好的参考——让技能变得可预测的词汇与原则。
disable-model-invocation: true
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

技能（skill）的存在，是为了从一个随机系统中拧出确定性。**可预测性（Predictability）**——agent 每次运行都走相同的 _过程_，而非产出相同的输出——是根本美德；下文每一个杠杆都为它服务。

**加粗术语** 在 [`GLOSSARY.md`](GLOSSARY.md) 中有定义；到那里查阅其完整含义。

## 触发（Invocation）

两种选择，各自付出不同的代价：

- 一个 **model-invoked** 技能保留 **description**，于是 agent 可以自主触发它，_并且_ 其他技能也能够调到它（你仍然可以手动输入它的名字）。它会贡献 **context load**——description 每一轮都待在上下文窗口里。机制：省略 `disable-model-invocation`，并写一段面向模型的 description，配上丰富的触发措辞（"Use when the user wants…, mentions…"）。
- 一个 **user-invoked** 技能从 agent 的可达范围中剥除 description：只有你，通过输入它的名字，才能触发它——其他技能都不能。零 context load，但它花费 **cognitive load**：_你_ 就是那个必须记得它存在的索引。机制：设置 `disable-model-invocation: true`；此时 `description` 变为面向人类——一行摘要，触发列表被剥除。

仅当 agent 必须自行调到该技能，或另一个技能必须调到它时，才选择 model-invocation。如果它只会被手动触发，就做成 user-invoked，不付任何 context load。

当 user-invoked 技能多到超出你能记住的数量时，这堆积起来的 cognitive load 可由一个 **router skill** 来治：一个 user-invoked 技能，列出其他技能以及何时该调用各个。

## 撰写 description

一段 model-invoked 的 **description** 做两件事——说明这个技能是什么，并列出应当触发它的 **branch**。每一个字都增加 **context load**，所以 description 比正文更应被狠狠修剪：

- **把技能的引领词前置**——description 正是它发挥触发作用的地方。
- **每个 branch 只配一条触发。** 给同一个 branch 改名的同义词就是 **duplication**——"build features using TDD … asks for test-first development" 是把同一个 branch 写了两遍。把它们合并；只保留真正彼此不同的 branch。
- **删掉正文里已有的身份描述。** description 只保留触发，外加任何「当另一个技能需要……时」的可达子句。

## 信息层级（Information hierarchy）

一个技能由两种内容类型搭建——**step** 与 **reference**——二者可自由混合：一个技能可以全是 step、全是 reference，或两者兼有。核心决策是用哪一种、以及各自落在 **information hierarchy** 的何处——这是一道按「agent 多急需该材料」排序的阶梯：

1. **In-skill step**——`SKILL.md` 中一个有序的动作，最顶层：agent 要做什么、按什么顺序做。每个 step 以一个 **completion criterion** 收尾，即告诉 agent 工作已完成的条件。让它 _可检验_（agent 能区分「完成」与「未完成」吗？），并在要紧之处做到 _穷尽_（"every modified model accounted for"，而非 "produce a change list"）——一个含糊的标准会招致 **premature completion**。
2. **In-skill reference**——`SKILL.md` 中一个按需查阅的定义、规则或事实。常常是一个名正言顺的扁平同辈集（一次评审的每条规则都在同一档上）——这是一种合理的安排，而非坏味道。_本技能全部是 reference。_
3. **External reference**——被推出 `SKILL.md`、移入独立文件的 reference，通过一个 **context pointer** 调到，仅在该指针触发时才加载。（跨度从 _已披露的_ reference——像 `GLOSSARY.md` 这样的同级文件，仍属技能的一部分——直到彻底 **external reference**，后者活在技能系统之外，任何技能都能指向它。）

一个高要求的 completion criterion 会驱动彻底的 **legwork**——agent 在工作内部所做的挖掘——无论该技能有没有 step，因为「每条规则都应用了」约束扁平 reference，正如「每个 step 都做了」约束一段序列。

往下压得太少，顶部会臃肿；压得太多，又会把 agent 实际需要的材料藏起来。这种张力正是整个决策的所在。

**Progressive disclosure** 就是沿阶梯往下移的动作——从 `SKILL.md` 移入一个被链接的文件——好让顶部保持清晰可读。机制：技能文件夹里一个被链接的 `.md` 文件，以它所承载的内容命名（本技能把其完整定义披露到 `GLOSSARY.md`）。有些技能有不止一种用法，每一种不同的用法就是一个 **branch**——不同的运行在技能中走不同的路径。Branch 是最干净的披露判据：每个 branch 都需要的内容就内联，只有部分 branch 会触及的就推到一个指针之后。一个 **context pointer** 的 _措辞_（而非其目标）决定 agent 何时、以及多可靠地调到该材料。

如果说阶梯决定一段内容 _往下多远_，那么 **co-location** 决定它落定之后 _旁边坐着什么_：把一个概念的定义、规则与注意事项放在同一个标题之下，而非散落各处，于是读到其中一部分，就把它的邻居一起带了出来。

## 何时拆分

**Granularity（粒度）** 是你把技能划得多细，而每一刀都花费两种 load 之一，所以只在这一刀值得时才拆。两种切法：

- **按触发拆**——当你有一个独特的 **leading word** 应当独立触发某技能，或另一个技能必须调到它时，拆出一个 **model-invoked** 技能。你要为这个永远加载的新 **description** 付出 **context load**，所以那份独立的可达性必须配得上这代价。
- **按序列拆**——当前方尚未执行的 step（一个 step 的 **post-completion steps**）诱使 agent 草草了事眼前这一步（**premature completion**）时，把这一串 step 拆开。让它们不出现在视野里，会鼓励 agent 在当前任务上做更多 **legwork**。

## 修剪（Pruning）

让每个含义只有一个 **single source of truth**：一个权威的地方，于是改动行为只需在一处编辑。

逐行检查 **relevance**：它是否仍然关乎这个技能要做的事？

然后逐句（而非仅逐行）猎杀 **no-op**：把每一句单独拿出来跑「no-op 测试」，一旦某句没通过，就删掉整句，而不是从中删词。要狠——大多数没通过的文字应当被删除，而非被改写。

## 引领词（Leading words）

一个 **leading word** 是一个紧凑的概念，它已活在模型的预训练里，agent 在运行技能时会用它来思考（例如 _lesson_、_fog of war_、_tracer bullets_）。它在文中反复出现（虽不一定——一个强力的引领词可能只需出现一次），积累起一个分布式的定义，并用最少的 token 锚定一整片行为区域，靠的是调动模型已经持有的先验。

它两次服务于可预测性。在正文中它锚定 _执行_：每当这个词出现，agent 就伸手去拿同样的行为。在 description 中它锚定 _触发_：当同一个词活在你的提示、文档和代码里时，agent 会把这份共享语言与该技能关联起来，从而更可靠地触发它。

留心寻找把技能重构为使用引领词的机会。一个在三处被铺陈展开的三元组（**duplication**）、一段花一整句话去比划一个想法的 description——每一处都是在恳求 **collapse** 成单个 token。例子包括：

- "fast, deterministic, low-overhead" -> _tight_——一个品质在一个阶段里被反复陈述——压成单个预训练词（一个 _tight_ loop）。
- "a loop you believe in" -> _red_——把一个模糊的判据转换成一个二元的可观测状态（这个 loop 要么在 bug 上变 _red_，要么不变）。

你赢了两次：更少的 token，_而且_ 给 agent 一个更锋利的钩子去挂它的思考。假定每个技能都背着引领词能退役掉的那些重述——去把它们找出来。

## 失效模式（Failure modes）

用这些来诊断用户在使用该技能时可能遇到的问题。

- **Premature completion**——在一个 step 真正完成之前就结束它，注意力滑向了 _已经完成_。防御，按顺序：先磨利 completion criterion（廉价、局部）；只有当它不可化约地含糊 _并且_ 你观察到了草率时，才通过拆分（序列切法）把 post-completion steps 藏起来。
- **Duplication**——同一个含义出现在不止一处。既花维护成本又花 token，还把一个含义在阶梯上的显著度抬升到超过其真实排位。
- **Sediment**——沉积的陈旧层，因为添加感觉安全、移除感觉危险而堆积。任何没有修剪纪律的技能的默认归宿。
- **Sprawl**——一个技能单纯太长，哪怕每一行都鲜活且唯一。损害可读性与可维护性，并浪费 token。解药是这道阶梯：把 **reference** 披露到指针之后，并按 **branch** 或序列拆分，让每条路径只承载它需要的内容。
- **No-op**——一行模型默认就会照做的指令，于是你付出 load 却什么也没说。测试：相对于默认，它改变了行为吗？一个弱引领词（agent 已经差不多够仔细时还说 _be thorough_）就是 no-op；解法是一个更强的词（_relentless_），而非另换一种技法。
