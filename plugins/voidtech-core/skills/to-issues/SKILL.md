---
name: to-issues
description: 按端到端垂直切片，把计划、规格或 PRD 拆成可以独立认领和验证的 issue，并发布到项目的 issue 跟踪器。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 转为 Issues

把计划拆成端到端垂直切片，每个切片都能独立认领和验证。

开始前读取 [Issue 跟踪器适配契约](../_shared/ISSUE-TRACKER.md)，据此识别平台、认证和标签映射；不要求任何预先安装的初始化技能。

## 流程

### 1. 收集上下文

从对话上下文里已有的内容着手。如果用户传入一个 issue 引用（issue 编号、URL 或路径）作为参数，从 issue 跟踪器取回它，读全文及评论。

### 2. 探查代码库（可选）

如果你还没探查过代码库，就去探查，以理解代码当前状态。issue 标题与描述应使用项目业务词汇表的词汇，并尊重你所改动区域内的 ADR。

检查是否需要先做小范围重构，以降低后续实现的复杂度。此类重构必须与目标改动直接相关，并能独立验证。

### 3. 起草垂直切片

把计划拆成小而完整的垂直切片。每个 issue 都要端到端覆盖必要的集成层，而不是只处理某一层。

<vertical-slice-rules>

- 每片切片交付一条窄而**完整**的路径，穿过每一层（schema、API、UI、测试）
- 一片完成的切片本身可演示或可验证
- 必要的前置重构应拆成更早完成的独立 issue

</vertical-slice-rules>

### 4. 向用户求证

把建议的拆分以编号列表呈现。对每片切片，展示：

- **标题**：简短的描述性名称
- **前置依赖**：哪些其他切片（若有）必须先完成
- **覆盖的用户故事**：这片切片处理了哪些用户故事（若源材料含有用户故事）

向用户提问：

- 每个 issue 的大小是否合适？（太大 / 太小）
- 依赖关系正确吗？
- 是否有切片应当合并或进一步拆分？

迭代直到用户批准这套拆分。

### 5. 把 issue 发布到 issue 跟踪器

对每个获批切片，向 issue 跟踪器发布一个新 issue。使用下方模板。默认把这些 issue 写到足够让无人值守 agent 直接实现，因此除非另有指示，发布时使用 category `enhancement` 与 state `ready-for-agent` 对应的实际标签。

按依赖顺序（先发布阻塞方）发布 issue，这样你才能在 "Blocked by" 字段中引用真实的 issue 标识符。

<issue-template>
## 上级 Issue

指向 issue 跟踪器上父 issue 的引用（若源是一个既有 issue，否则省略本节）。

## 目标

对这片垂直切片的简洁描述。描述端到端的行为，而非逐层的实现。

避免具体的文件路径或代码片段，因为它们很快就会过时。例外：如果原型中的片段能更准确地表达某项决策（状态机、reducer、schema、类型形态），可以把它放在这里，并注明来源。只保留表达决策所需的部分，不要附上完整演示。

## 验收标准

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## 前置依赖

- 指向阻塞工单的引用（若有）

没有依赖时写“无，可立即开始”。

</issue-template>

不要关闭或修改任何父 issue。若跟踪器不可用，按适配契约输出完整草稿；草稿生成完成后才算本次任务达到可交付状态。
