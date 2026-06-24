# Design It Twice

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

当用户想为某个选定的加深候选项探索备选接口时，使用这种并行子 agent 模式。基于 "Design It Twice"（Ousterhout）——你的第一个想法不太可能是最好的。

使用 [SKILL.md](SKILL.md) 中的词汇——**module**、**interface**、**seam**、**adapter**、**leverage**。

## 流程

### 1. 框定问题空间

在拉起子 agent 之前，为选定的候选项写一份面向用户的问题空间说明：

- 任何新接口都需要满足的约束
- 它会依赖的依赖，以及它们落入哪个类别（见 [DEEPENING.md](DEEPENING.md)）
- 一段粗略的示意代码草图，用来落地这些约束——不是一个提案，只是把约束变具体的一种方式

把这个展示给用户，然后立即进入步骤 2。用户阅读和思考的同时，子 agent 并行工作。

### 2. 拉起子 agent

用 Agent 工具并行拉起 3 个以上子 agent。每一个都必须为加深后的模块产出一个**截然不同**的接口。

用一份独立的技术 brief 提示每个子 agent（文件路径、耦合细节、来自 [DEEPENING.md](DEEPENING.md) 的依赖类别、seam 背后是什么）。该 brief 独立于步骤 1 中面向用户的问题空间说明。给每个 agent 一个不同的设计约束：

- Agent 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Agent 2: "Maximise flexibility — support many use cases and extension."
- Agent 3: "Optimise for the most common caller — make the default case trivial."
- Agent 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

在 brief 中同时纳入 [SKILL.md](SKILL.md) 词汇与 CONTEXT.md 词汇，这样每个子 agent 给事物命名时都与架构语言和项目领域语言保持一致。

每个子 agent 输出：

1. 接口（types、methods、params——外加 invariants、ordering、error modes）
2. 展示调用者如何使用它的用法示例
3. 实现在 seam 背后藏了什么
4. 依赖策略与 adapter（见 [DEEPENING.md](DEEPENING.md)）
5. 取舍——哪里 leverage 高，哪里薄

### 3. 呈现并比较

按顺序呈现各设计，让用户能逐个吸收，然后用散文比较它们。从 **depth**（接口处的 leverage）、**locality**（变更集中在何处）和 **seam placement（seam 放置）** 三方面对比。

比较之后，给出你自己的推荐：你认为哪个设计最强以及为什么。如果来自不同设计的元素能很好地组合，提出一个混合方案。要有主见——用户想要一个强有力的判断，而不是一份菜单。
