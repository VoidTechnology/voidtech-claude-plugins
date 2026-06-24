---
name: to-prd
description: 把当前对话整理成 PRD 并发布到项目的 issue 追踪器。只综合已经讨论过的内容，不重新开展需求访谈。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

本技能接收当前对话上下文与对代码库的理解，产出一份 PRD。不要访谈用户——只综合你已经掌握的内容。

开始前读取 [Issue 跟踪器适配契约](../_shared/ISSUE-TRACKER.md)，据此识别平台、认证和标签映射；不要求任何预先安装的初始化技能。

## 流程

1. 如果尚未做过，先探查仓库以了解代码库的现状。在整份 PRD 中使用项目的领域术语表词汇，并尊重你所触及区域内的任何 ADR。

2. 勾勒出你将用来测试该功能的 seam。优先使用已有的 seam 而非新建。使用尽可能高的 seam。如果确需新的 seam，请在尽可能高的位置提出。跨代码库的 seam 越少越好——理想数量是一个。

若对话中已经确认 seam，把它作为决策记录；若尚未确认，把建议写成 `Testing Decisions` 中明确标注的 proposed decision。不要为此重新开启需求访谈。

3. 使用下面的模板写出 PRD，然后将其发布到项目的 issue 追踪器。使用 category `enhancement` 与 state `ready-for-agent` 对应的实际标签，无需再走 issue 整理流程。若跟踪器不可用，按适配契约生成完整 Markdown 草稿并返回路径。

<prd-template>

## 问题

用户所面临的问题，从用户的视角出发。

## 方案

针对该问题的解决方案，从用户的视角出发。

## 用户故事

一份很长的、带编号的用户故事列表。每条用户故事应采用如下格式：

1. 作为 <角色>，我希望 <功能>，从而 <收益>

<user-story-example>
1. 作为手机银行用户，我希望查看各账户余额，从而更合理地安排支出
</user-story-example>

这份用户故事列表应当极其详尽，覆盖该功能的所有方面。

## 实现决策

一份已做出的实现决策列表。可以包括：

- 将要构建/修改的模块
- 这些模块将被修改的接口
- 来自开发者的技术澄清
- 架构决策
- Schema 变更
- API 契约
- 具体的交互

不要包含具体的文件路径或代码片段。它们可能很快就过时了。

例外：如果原型中的代码片段能更准确地表达某项决策（状态机、reducer、schema、类型结构），可以把它放在相关决策中，并注明来源。只保留表达决策所需的部分，不要附上完整演示。

## 测试决策

一份已做出的测试决策列表。包括：

- 对什么是好测试的描述（只测试外部行为，不测试实现细节）
- 哪些模块将被测试
- 测试的先例（即代码库中类似类型的测试）

## 不在范围内

对本 PRD 范围之外内容的描述。

## 补充说明

关于该功能的任何补充说明。

</prd-template>
