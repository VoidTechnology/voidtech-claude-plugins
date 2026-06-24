# 学习记录格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

学习记录存放于 `./learning-records/`，采用顺序编号：`0001-slug.md`、`0002-slug.md`，依此类推。惰性地创建该目录——仅在写入第一条记录时才创建。

它们是教学领域里相当于 ADR 的东西：记录那些不显而易见的经验、关键洞察，以及已声明的先验知识，用以引导未来的会话。它们用于计算最近发展区。

## 模板

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

这就是全部格式。一条学习记录可以只是单个段落。其价值在于记录下「_这件事_」现在已知，以及「_为什么_」它会改变接下来该教什么——而不在于把各小节填满。

## 可选小节

仅在它们带来真正价值时才包含。大多数记录都不需要。

- **Status** frontmatter（`active | superseded by LR-NNNN`）——当早先的理解后来被证明有误并被取代时有用。
- **Evidence**——用户是如何展示这一理解的（答对了一个问题、完成了一个练习、引用了过往经验）。当该主张日后可能被重新审视时有用。
- **Implications**——这为未来的会话解锁了什么或排除了什么。当其不显而易见时值得记录。

## 编号

扫描 `./learning-records/`，找出现有的最大编号并加一。

## 何时写一条学习记录

当以下任一条成立时写一条：

1. **用户对某件非平凡的事展示了真正的理解**——不只是接触过，而是有证据表明他们能正确运用该概念。这为接下来该教什么设定了一个新的下限。
2. **用户披露了先验知识**——「我已经懂 X 了。」记录下来，以免未来的会话重教。同时记录其声称的 _深度_。
3. **一个误解被纠正**——用户此前相信某个错误的东西，现在明白了为什么错。这些极有价值：它们能预测相关主题上未来的绊脚石。
4. **mission 因学习而发生了转向**——用户发现自己在意的与原以为的不同。交叉链接到 [[MISSION.md]] 并更新它。

### 哪些 _不_ 够格

- 仅仅被讲过的材料。讲过不等于学会。等到有证据再说。
- 已在 [[GLOSSARY.md]] 中作为术语定义简要记录过的内容。不要重复。
- 逐次会话的活动日志。学习记录不是日记——它们是决策级别的洞察。

## 取代（Supersession）

当一条较晚的记录与较早的记录相矛盾时（用户的理解加深或得到纠正），将旧记录标记为 `Status: superseded by LR-NNNN`，而非删除它。理解如何演进的历史本身就是有用的信号。
