---
name: to-prd
description: 把当前对话转化为 PRD 并发布到项目的 issue 追踪器——不做访谈，只是综合你们已经讨论过的内容。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

本技能接收当前对话上下文与对代码库的理解，产出一份 PRD。不要访谈用户——只综合你已经掌握的内容。

issue 追踪器与 triage 标签词表应当已经提供给你了——如果没有，运行 `/setup-matt-pocock-skills`。

## 流程

1. 如果尚未做过，先探查仓库以了解代码库的现状。在整份 PRD 中使用项目的领域术语表词汇，并尊重你所触及区域内的任何 ADR。

2. 勾勒出你将用来测试该功能的 seam。优先使用已有的 seam 而非新建。使用尽可能高的 seam。如果确需新的 seam，请在尽可能高的位置提出。跨代码库的 seam 越少越好——理想数量是一个。

与用户确认这些 seam 是否符合他们的预期。

3. 使用下面的模板写出 PRD，然后将其发布到项目的 issue 追踪器。打上 `ready-for-agent` triage 标签——无需额外 triage。

<prd-template>

## Problem Statement

用户所面临的问题，从用户的视角出发。

## Solution

针对该问题的解决方案，从用户的视角出发。

## User Stories

一份很长的、带编号的用户故事列表。每条用户故事应采用如下格式：

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

这份用户故事列表应当极其详尽，覆盖该功能的所有方面。

## Implementation Decisions

一份已做出的实现决策列表。可以包括：

- 将要构建/修改的模块
- 这些模块将被修改的接口
- 来自开发者的技术澄清
- 架构决策
- Schema 变更
- API 契约
- 具体的交互

不要包含具体的文件路径或代码片段。它们可能很快就过时了。

例外：如果某个原型产出的代码片段比散文更精确地编码了一项决策（状态机、reducer、schema、type shape），就把它内联到相关决策中，并简要注明它来自一个原型。只保留富含决策的部分——不是一个可运行的 demo，只是重要的那几段。

## Testing Decisions

一份已做出的测试决策列表。包括：

- 对什么是好测试的描述（只测试外部行为，不测试实现细节）
- 哪些模块将被测试
- 测试的先例（即代码库中类似类型的测试）

## Out of Scope

对本 PRD 范围之外内容的描述。

## Further Notes

关于该功能的任何补充说明。

</prd-template>
