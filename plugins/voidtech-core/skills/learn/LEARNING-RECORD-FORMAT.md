# 学习记录格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

学习记录存放于 `./learning-records/`，采用顺序编号：`0001-slug.md`、`0002-slug.md`，依此类推。仅在写入第一条记录时创建该目录。

学习记录类似软件项目中的 ADR，用于保存不容易从资料中直接获得的经验、关键认识和用户已有知识，帮助后续会话判断适合教授什么。

## 模板

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

一条学习记录可以只有一个段落。重点是记录已经确认的内容，以及它为什么会影响后续课程；不需要为了完整形式增加多余小节。

## 可选小节

仅在它们带来真正价值时才包含。大多数记录都不需要。

- **Status** frontmatter（`active | superseded by LR-NNNN`）——当早先的理解后来被证明有误并被取代时有用。
- **Evidence**——用户是如何展示这一理解的（答对了一个问题、完成了一个练习、引用了过往经验）。当该主张日后可能被重新审视时有用。
- **Implications**——这为未来的会话解锁了什么或排除了什么。当其不显而易见时值得记录。

## 编号

扫描 `./learning-records/`，找出现有的最大编号并加一。

## 何时写一条学习记录

当以下任一条成立时写一条：

1. **用户对重要内容表现出真正理解**——不仅接触过，而且有证据表明能正确运用该概念。这会影响后续课程的起点。
2. **用户披露了先验知识**——「我已经懂 X 了。」记录下来，以免未来的会话重教。同时记录其声称的 _深度_。
3. **一个误解被纠正**——用户理解了原有认识为什么错误。记录它可以帮助后续课程避免相似误解。
4. **学习目标发生变化**——用户发现实际关注点与原先不同。链接到 [[MISSION.md]] 并更新它。

### 哪些 _不_ 够格

- 仅仅被讲过的材料。讲过不等于学会。等到有证据再说。
- 已在 [[GLOSSARY.md]] 中作为术语定义简要记录过的内容。不要重复。
- 逐次会话的活动日志。学习记录不是日记，只保存会影响后续教学的重要认识。

## 取代（Supersession）

当一条较晚的记录与较早的记录相矛盾时（用户的理解加深或得到纠正），将旧记录标记为 `Status: superseded by LR-NNNN`，而非删除它。理解如何演进的历史本身就是有用的信号。
