# 多方案接口设计

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

当用户想为某个模块深化方案比较多种接口时，使用本流程。核心原则来自 Ousterhout 的 “Design It Twice”：不要只评估第一个想到的方案。

使用 [SKILL.md](SKILL.md) 中的词汇——**module**、**interface**、**seam**、**adapter**、**leverage**。

## 流程

### 1. 明确问题和约束

在启动子 agent 之前，为选定的候选项写一份面向用户的问题说明：

- 任何新接口都需要满足的约束
- 它会依赖的依赖，以及它们落入哪个类别（见 [DEEPENING.md](DEEPENING.md)）
- 一段简短的示意代码，用来具体说明这些约束；它不是正式方案

把这个展示给用户，然后立即进入步骤 2。用户阅读和思考的同时，子 agent 并行工作。

### 2. 生成独立方案

优先用 Agent 工具并行启动至少 3 个子 agent。若当前环境没有 Agent 工具，则按下列约束依次独立设计三个方案；完成当前方案前不要融合前一个方案。无论采用哪种方式，每个方案都必须为深化后的模块提供一个明显不同的接口。

为每个子 agent 提供独立的技术说明，包括文件路径、耦合关系、[DEEPENING.md](DEEPENING.md) 中的依赖类别，以及 seam 背后的实现。技术说明与步骤 1 的用户说明分开。每个 agent 使用不同的设计约束：

- Agent 1：把接口压缩到 1–3 个入口，尽量提高每个入口能提供的能力。
- Agent 2：优先考虑扩展性，支持更多合理用例。
- Agent 3：优先优化最常见的调用方式，让默认路径最简单。
- Agent 4（适用时）：围绕 ports and adapters 设计跨 seam 依赖。

技术说明应同时使用 [SKILL.md](SKILL.md) 的架构词汇和 `CONTEXT.md` 的领域词汇，保证各方案命名一致。

每个子 agent 输出：

1. 接口，包括类型、方法、参数、不变式、调用顺序和错误处理方式
2. 展示调用方如何使用接口的示例
3. 实现在 seam 背后藏了什么
4. 依赖策略与 adapter（见 [DEEPENING.md](DEEPENING.md)）
5. 取舍，包括哪些接口收益较高、哪些接口仍然复杂

### 3. 呈现并比较

依次呈现各方案，再从三方面比较：**depth**（接口是否足够简单、能力是否完整）、**locality**（修改是否集中）和 **seam placement**（可替换接缝的位置是否合理）。

比较之后，明确推荐一个方案并说明理由。如果不同方案的部分设计可以合理组合，再提出一个混合方案。不要只列选项而不给结论。
