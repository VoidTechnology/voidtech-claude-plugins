# ADR 格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

ADR 放在 `docs/adr/` 下，使用顺序编号：`0001-slug.md`、`0002-slug.md` 等。

惰性地创建 `docs/adr/` 目录——只在需要第一份 ADR 时创建。

## 模板

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

就这样。一份 ADR 可以只有一段话。其价值在于记录*某项决策被做出*以及*为什么*——而不在于把各个小节填满。

## 可选小节

只在确实增加价值时才包含这些。多数 ADR 不需要它们。

- **Status** frontmatter（`proposed | accepted | deprecated | superseded by ADR-NNNN`）——当决策会被重新审视时有用
- **Considered Options** — 仅当被否决的备选方案值得记住时
- **Consequences** — 仅当需要点明非显而易见的下游影响时

## 编号

扫描 `docs/adr/` 找出已有的最大编号，加一。

## 何时提议 ADR

以下三点必须同时成立：

1. **难以逆转** — 日后改主意的代价是实打实的
2. **缺乏背景就令人意外** — 未来的读者看着代码会纳闷"他们到底为什么要这么做？"
3. **是一次真实权衡的结果** — 确有可选项，而你为了特定理由选了其一

如果一项决策容易逆转，跳过它——反正你会逆转。如果它并不令人意外，没人会去纳闷为什么。如果根本没有真实的备选，那就没什么可记的，无非是"我们做了显而易见的事"。

### 哪些够格

- **架构形态。** "我们用 monorepo。" "写模型是事件溯源的，读模型投影进 Postgres。"
- **上下文之间的集成模式。** "Ordering 与 Billing 通过领域事件通信，而非同步 HTTP。"
- **带锁定效应的技术选型。** 数据库、消息总线、认证提供方、部署目标。不是每个库——只是那些要花一个季度才能换掉的。
- **边界与范围决策。** "Customer 数据归 Customer 上下文所有；其他上下文只通过 ID 引用它。" 明确的"不做什么"和"做什么"一样有价值。
- **对显而易见路径的刻意偏离。** "我们用手写 SQL 而非 ORM，因为 X。" 任何会让一个讲道理的读者以为应该反着来的地方。这些能阻止下一个工程师去"修"一个本是刻意为之的东西。
- **代码里看不到的约束。** "出于合规要求我们不能用 AWS。" "因为合作方 API 合约，响应时间必须低于 200ms。"
- **当否决理由不显而易见时，记下被否决的备选。** 如果你考虑过 GraphQL 却出于微妙理由选了 REST，记下来——否则半年后有人又会提议 GraphQL。
