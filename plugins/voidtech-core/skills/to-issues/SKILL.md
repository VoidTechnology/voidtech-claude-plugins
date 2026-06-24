---
name: to-issues
description: 用曳光弹式垂直切片，把一份计划、规格或 PRD 拆成可被独立认领的 issue，发布到项目的 issue 跟踪器上。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 转为 Issues

用垂直切片（曳光弹）把一份计划拆成可被独立认领的 issue。

issue 跟踪器与三类（triage）标签词汇本应已提供给你——若没有，运行 `/setup-matt-pocock-skills`。

## 流程

### 1. 收集上下文

从对话上下文里已有的内容着手。如果用户传入一个 issue 引用（issue 编号、URL 或路径）作为参数，从 issue 跟踪器取回它，读全文及评论。

### 2. 探查代码库（可选）

如果你还没探查过代码库，就去探查，以理解代码当前状态。issue 标题与描述应使用项目领域术语表的词汇，并尊重你所改动区域内的 ADR。

寻找可以预重构（prefactor）代码、让实现更易上手的机会。"先让改动变容易，再做那个容易的改动。"

### 3. 起草垂直切片

把计划拆成**曳光弹**式 issue。每个 issue 是一片薄薄的垂直切片，端到端贯穿所有集成层，而**不是**单一层的水平切片。

<vertical-slice-rules>

- 每片切片交付一条窄而**完整**的路径，穿过每一层（schema、API、UI、测试）
- 一片完成的切片本身可演示或可验证
- 任何预重构都应先做

</vertical-slice-rules>

### 4. 向用户求证

把建议的拆分以编号列表呈现。对每片切片，展示：

- **Title**：简短的描述性名称
- **Blocked by**：哪些其他切片（若有）必须先完成
- **User stories covered**：这片切片处理了哪些用户故事（若源材料含有用户故事）

向用户提问：

- 颗粒度感觉对吗？（太粗 / 太细）
- 依赖关系正确吗？
- 是否有切片应当合并或进一步拆分？

迭代直到用户批准这套拆分。

### 5. 把 issue 发布到 issue 跟踪器

对每片获批的切片，向 issue 跟踪器发布一个新 issue。使用下方的 issue 正文模板。这些 issue 被视为可供 AFK agent 使用，因此除非另有指示，发布时打上正确的 triage 标签。

按依赖顺序（先发布阻塞方）发布 issue，这样你才能在 "Blocked by" 字段中引用真实的 issue 标识符。

<issue-template>
## Parent

指向 issue 跟踪器上父 issue 的引用（若源是一个既有 issue，否则省略本节）。

## What to build

对这片垂直切片的简洁描述。描述端到端的行为，而非逐层的实现。

避免具体的文件路径或代码片段——它们很快就会过时。例外：如果某个原型产出的片段比散文更精确地编码了一项决策（状态机、reducer、schema、类型形态），就把它内联在此，并简短注明它来自一个原型。修剪到富含决策的部分——不是一个可运行的演示，只是重要的那几段。

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- 指向阻塞工单的引用（若有）

或者写 "None - can start immediately"，若无阻塞。

</issue-template>

不要关闭或修改任何父 issue。
