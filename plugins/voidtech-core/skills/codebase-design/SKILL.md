---
name: codebase-design
description: 设计接口简单、内部能力完整的深模块。当用户需要改进模块接口、确定 seam（可替换接缝）、提高可测试性，或其他技能需要这套架构词汇时使用。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 代码库设计

设计 **deep module（深模块）**：用简单接口提供完整能力，把实现细节留在清晰的 seam（可替换接缝）之后，并通过公开接口测试行为。目标是让调用方用更少的接口获得更多能力，让修改和排错集中在模块内部。

## 术语表

统一使用以下术语，不要用含义不完全相同的 "component"、"service"、"API" 或 "boundary" 替换。

**Module（模块）** — 任何同时具有接口和实现的代码单元，可以是函数、类、包或跨层切片。_避免_：unit、component、service。

**Interface（接口）** — 调用方为了正确使用模块而必须知道的一切，包括类型签名、不变式、调用顺序、错误方式、必要配置和性能特征。_避免_：API、signature（只表达了类型层面的表面）。

**Implementation（实现）** — 模块内部代码。它与 **Adapter** 不同：adapter 描述代码在 seam 处承担的角色，implementation 描述模块内部如何工作。讨论 seam 时使用 "adapter"，其他情况使用 "implementation"。

**Depth（深度）** — 简单接口背后包含的有效能力。接口小、内部能力完整的是 **deep（深）** 模块；接口与实现同样复杂的是 **shallow（浅）** 模块。

**Seam（可替换接缝）** _(Michael Feathers)_ — 无需修改调用方，就能替换实现或改变行为的位置。seam 通常位于模块接口处；放在哪里与背后采用什么实现是两个不同决策。_避免_：boundary（容易与 DDD 的 bounded context 混淆）。

**Adapter（适配器）** — 在某个 seam 处实现接口的对象或模块。这个词描述它承担的角色，而不是内部实现方式。

**Leverage（接口收益）** — 调用方只需理解少量接口，就能使用较多能力。同一份实现可以服务多个调用点和测试。

**Locality（修改集中度）** — 变更、缺陷、领域知识和验证逻辑集中在模块内部，而不是散落到多个调用方。一处修复即可覆盖所有调用点。

## 深模块与浅模块

**Deep module** = 小接口 + 大量实现：

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
└─────────────────────┘
```

**Shallow module** = 大接口 + 少量实现（避免）：

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

设计接口时，问自己：

- 我能减少方法数量吗？
- 我能简化参数吗？
- 我能在内部藏更多复杂度吗？

## 原则

- **Depth 是接口的属性，不是实现的属性。** 深模块内部可以由小型、可 mock、可替换的部件组成，但这些部件不需要暴露为公开接口。模块可以有私有的 **internal seams（内部 seam）**，也可以在公开接口处有 **external seam（外部 seam）**。
- **移除模块检验。** 设想删掉该模块。如果复杂度也随之消失，它可能只是简单转发；如果复杂度会在多个调用方重复出现，这个模块就在承担有效职责。
- **接口就是测试面。** 调用方和测试都应通过同一个 seam 使用模块。如果测试必须绕过接口，模块边界可能设计得不合适。
- **只有一个适配器时，seam 可能只是过度设计；出现两个适配器时，seam 才有明确价值。** 只有确实需要替换实现时才引入 seam。

## 为可测试性而设计

好的接口让测试变得自然：

1. **接受依赖，不要创建依赖。**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **返回结果，不要产生副作用。**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **小表面积。** 更少方法 = 需要更少测试。更少参数 = 更简单的测试搭建。

## 关系

- 一个 **Module** 通过一个明确的 **Interface** 向调用方和测试提供能力。
- **Depth** 是 **Module** 的属性，针对其 **Interface** 来衡量。
- **Seam** 是 **Module** 的 **Interface** 所在之处。
- **Adapter** 坐在 **Seam** 处并满足 **Interface**。
- **Depth** 让调用方用更少接口获得更多能力，也让维护者把修改集中在模块内部。

## 被否决的框架

- **把 depth 当作实现行数与接口行数之比**（Ousterhout）：这种计算会鼓励无意义地增加实现代码。这里改用接口提供能力的多少来判断 depth。
- **把 "interface" 只理解为 TypeScript 的 `interface` 关键字或类的公有方法**：范围太窄。这里的 interface 包含调用方必须知道的所有约束。
- **"Boundary"**：容易与 DDD 的 bounded context 混淆。这里使用 **seam** 或 **interface**。

## 更进一步

- **在考虑依赖的前提下深化一组浅模块** —— 见 [DEEPENING.md](DEEPENING.md)：依赖分类、seam 使用原则，以及“替换旧测试，不要重复叠加”的测试方法。
- **比较备选接口** —— 见 [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md)：让多个子 agent 独立设计不同接口，再比较 depth、locality 和 seam 的位置。
