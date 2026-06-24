---
name: improve-codebase-architecture
description: 扫描代码库寻找加深（deepening）机会，以可视化的 HTML 报告呈现，然后就你挑中的那个进行盘问。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# Improve Codebase Architecture

浮现架构上的摩擦，并提出 **deepening opportunities（加深机会）**——把浅模块变成深模块的重构。目标是可测试性与 AI 可导航性。

本命令*由*项目的领域模型提供信息，并构建在一套共享的设计词汇之上：

- 运行 `/codebase-design` 技能以获得架构词汇（**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**）及其原则（删除测试、“接口就是测试面”、“一个 adapter = 假想的 seam，两个 = 真实的”）。在每条建议中精确使用这些术语——不要漂移到 "component"、"service"、"API" 或 "boundary"。
- `CONTEXT.md` 中的领域语言为好的 seam 命名；`docs/adr/` 中的 ADR 记录了本命令不应重新争论的决策。

## 流程

### 1. 探查

先阅读项目的领域术语表（`CONTEXT.md`）以及你所触及区域内的任何 ADR。

然后用 Agent 工具配 `subagent_type=Explore` 走查代码库。不要遵循僵化的启发式——有机地探查，并记下你在哪里感到摩擦：

- 在哪里理解一个概念需要在许多小模块之间来回跳？
- 哪里的模块是**shallow（浅的）**——接口几乎和实现一样复杂？
- 哪里的纯函数仅仅为了可测试性而被抽出，但真正的 bug 藏在它们如何被调用之中（缺乏 **locality**）？
- 哪里紧耦合的模块跨它们的 seam 泄漏？
- 代码库的哪些部分未被测试，或者通过当前接口难以测试？

对任何你怀疑是浅的东西应用**删除测试**：删掉它会让复杂度集中，还是只是搬走？一个“会，集中”就是你想要的信号。

### 2. 把候选项呈现为 HTML 报告

把一个自包含的 HTML 文件写到操作系统的临时目录，这样不会有任何东西落进仓库。从 `$TMPDIR` 解析临时目录，回退到 `/tmp`（Windows 上为 `%TEMP%`），并写到 `<tmpdir>/architecture-review-<timestamp>.html`，让每次运行都得到一个新文件。为用户打开它——Linux 上用 `xdg-open <path>`，macOS 上用 `open <path>`，Windows 上用 `start <path>`——并告诉他们绝对路径。

报告使用 **Tailwind via CDN** 做布局与样式，并在图/流程/时序能可靠传达结构之处使用 **Mermaid via CDN** 画图。把 Mermaid 与手工 CSS/SVG 视觉元素混用——当关系是图状（调用图、依赖、时序）时用 Mermaid，当你想要更具编辑感的东西（质量图、剖面图、坍缩动画）时用手搭的 div/SVG。每个候选项都配一张 **before/after 可视化**。要有视觉感。

为每个候选项渲染一张卡片，包含：

- **Files** — 涉及哪些文件/模块
- **Problem** — 为什么当前架构在造成摩擦
- **Solution** — 用平白英语描述会发生什么改变
- **Benefits** — 用 locality 和 leverage 来解释，以及测试会如何改善
- **Before / After diagram** — 并排、自绘，图示其浅与加深
- **Recommendation strength** — `Strong`、`Worth exploring`、`Speculative` 之一，渲染为一个 badge

报告以一个 **Top recommendation** 段落收尾：你会先动手哪个候选项以及为什么。

**领域用 CONTEXT.md 词汇，架构用 `/codebase-design` 词汇。** 如果 `CONTEXT.md` 定义了 "Order"，就谈 "the Order intake module"——而不是 "the FooBarHandler"，也不是 "the Order service"。

**ADR 冲突**：如果某个候选项与现有 ADR 抵触，只在摩擦真实到值得重新审视该 ADR 时才浮现它。在卡片中清楚标注（例如一个 warning callout：_"contradicts ADR-0007 — but worth reopening because…"_）。不要把某个 ADR 所禁止的每一个理论上的重构都列出来。

完整的 HTML 脚手架、图表模式和样式指引见 [HTML-REPORT.md](HTML-REPORT.md)。

现在还不要提出接口。文件写好后，问用户："Which of these would you like to explore?"

### 3. 盘问循环

一旦用户挑中一个候选项，运行 `/grilling` 技能与他们一起走查设计树——约束、依赖、加深后模块的形态、seam 背后是什么、哪些测试得以幸存。

副作用在决策成形时就地发生——运行 `/domain-modeling` 技能，让领域模型随进展保持最新：

- **要按一个不在 `CONTEXT.md` 中的概念给加深后的模块命名？** 把该术语加入 `CONTEXT.md`。若文件不存在则惰性创建。
- **在对话中打磨某个模糊术语？** 当场更新 `CONTEXT.md`。
- **用户以一个承重的理由否决了候选项？** 提议一份 ADR，措辞如：_"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ 仅当该理由确实会被未来的探查者用来避免重复建议同一件事时才提议——跳过短暂性的理由（“现在不值得”）和不言自明的理由。
- **想为加深后的模块探索备选接口？** 运行 `/codebase-design` 技能并使用其 design-it-twice 并行子 agent 模式。
