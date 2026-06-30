---
name: architecture-review
description: 扫描代码库，找出可以整合浅模块、简化接口的架构改进点，以 HTML 报告呈现，并进一步审查选中的方案。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 改进代码库架构

找出理解、修改和测试代码时遇到的架构阻力，并提出**模块深化方案（deepening）**：把职责零散的浅模块整合成接口简单、内部能力完整的深模块。目标是提升可测试性，让开发者和 AI 更容易理解代码。

审查时使用项目现有的功能上下文和统一的架构术语：

- 运行 `voidtech-core:codebase-design` 技能，了解架构词汇（**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**）及其原则（移除模块检验、“接口就是测试面”、“一个 adapter 通常不足以证明需要 seam，两个 adapter 才能证明替换需求真实存在”）。每条建议都使用这些术语，不要换成含义不完全相同的 "component"、"service"、"API" 或 "boundary"。
- `CONTEXT.md` 中的业务词汇为好的 seam 命名；`docs/adr/` 中的 ADR 记录了本命令不应重新争论的决策。

## 流程

### 1. 探查

先阅读项目的业务词汇表（`CONTEXT.md`）以及你所触及区域内的任何 ADR。

然后用 Agent 工具配 `subagent_type=Explore` 走查代码库。若当前环境没有 Agent 工具，直接使用文件搜索、符号搜索和测试入口完成同样的探查，不得因此要求安装上游工具。根据实际代码寻找以下问题：

- 在哪里理解一个概念需要在许多小模块之间来回跳？
- 哪里的模块是**shallow（浅的）**——接口几乎和实现一样复杂？
- 哪里的纯函数仅仅为了可测试性而被抽出，但真正的 bug 藏在它们如何被调用之中（缺乏 **locality**）？
- 哪些紧耦合模块把内部细节泄漏到了 seam 之外？
- 代码库的哪些部分未被测试，或者通过当前接口难以测试？

对任何疑似浅模块应用**移除模块检验**：假设删掉它，复杂度是消失了，还是被迫散落到调用方？如果复杂度会散落，说明这个模块可能值得保留并进一步深化。

### 2. 把候选项呈现为 HTML 报告

把一个自包含的 HTML 文件写到操作系统的临时目录，这样不会有任何东西落进仓库。从 `$TMPDIR` 解析临时目录，回退到 `/tmp`（Windows 上为 `%TEMP%`），并写到 `<tmpdir>/architecture-review-<timestamp>.html`，让每次运行都得到一个新文件。为用户打开它——Linux 上用 `xdg-open <path>`，macOS 上用 `open <path>`，Windows 上用 `start <path>`——并告诉他们绝对路径。

报告必须离线可读：把全部样式写进 `<style>`，图表使用语义化 HTML、CSS Grid/Flex 与内联 SVG，不加载 CDN、字体、脚本或其他远程资源。把仓库名、路径、符号名、注释和其他动态文本按 HTML 文本或属性上下文正确转义，绝不把仓库内容拼成标签或 SVG 标记。每个候选项都配一张 **before/after 可视化**；当关系是图状时用内联 SVG 的方框、连线和箭头表达。

为每个候选项渲染一张卡片，包含：

- **Files（文件）** — 涉及哪些文件或模块
- **Problem（问题）** — 当前架构为什么难以理解、修改或测试
- **Solution（方案）** — 用简单英语描述具体改动
- **Benefits（收益）** — 使用 locality 和 leverage 解释收益，并说明测试如何改善
- **Before / After diagram（改动前后图）** — 并排展示模块深化前后的结构
- **Recommendation strength（推荐程度）** — `Strong`、`Worth exploring`、`Speculative` 之一，以徽标显示

报告以 **Top recommendation（首选建议）** 段落收尾：说明应优先处理哪个候选项以及原因。

**业务命名用 `CONTEXT.md` 词汇，架构说明用 `voidtech-core:codebase-design` 词汇。** 如果 `CONTEXT.md` 定义了 "Order"，就谈 "the Order intake module"——而不是 "the FooBarHandler"，也不是 "the Order service"。

**ADR 冲突**：如果某个候选项与现有 ADR 抵触，只有在当前问题严重到值得重新审视该 ADR 时才提出。在卡片中清楚标注，例如 _"contradicts ADR-0007 — but worth reopening because…"_。不要列出 ADR 已明确否决、且没有新证据支持的重构。

完整的 HTML 模板、图表模式和样式说明见 [HTML-REPORT.md](HTML-REPORT.md)。

现在还不要提出接口。文件写好后，问用户："Which of these would you like to explore?"

### 3. 审查选中的方案

用户选中候选项后，运行 `voidtech-core:plan-review-core`，逐项检查约束、依赖、深化后的模块形态、seam（可替换接缝）背后的实现，以及哪些测试需要保留或替换。

副作用在决策成形时就地发生——运行 `voidtech-core:feature-context` 技能，让功能上下文随进展保持最新：

- **要用 `CONTEXT.md` 中没有的概念为深化后的模块命名？** 把该术语加入 `CONTEXT.md`。若文件不存在则按需创建。
- **在对话中明确了某个模糊术语？** 当场更新 `CONTEXT.md`。
- **用户基于长期有效的关键理由否决了候选项？** 提议记录 ADR。只有当该理由能帮助未来的维护者避免重复提出同一建议时才记录；“现在不值得”等临时理由不需要 ADR。
- **想为深化后的模块比较多种接口？** 运行 `voidtech-core:codebase-design`，使用其中的多方案接口设计流程。
