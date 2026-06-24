---
name: codebase-design
description: 用于设计深模块的共享词汇。当用户想要设计或改进某个模块的接口、寻找加深机会、决定 seam 放在哪里、让代码更可测试或更易被 AI 导航，或当另一个技能需要深模块词汇时使用。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# Codebase Design

设计**deep modules（深模块）**：在一个小接口背后藏大量行为，放在一个干净的 seam 上，并通过该接口可测试。在任何设计或重构代码之处都使用这套语言和这些原则。目标是给调用者 leverage，给维护者 locality，给所有人可测试性。

## 术语表

精确使用这些术语——不要用 "component"、"service"、"API" 或 "boundary" 替换。语言一致正是关键所在。

**Module（模块）** — 任何具有接口和实现的东西。刻意做到与规模无关：一个函数、类、包，或跨层的切片。_避免_：unit、component、service。

**Interface（接口）** — 调用者为了正确使用模块而必须知道的一切：类型签名，但也包括不变式、顺序约束、错误模式、必需的配置，以及性能特征。_避免_：API、signature（太窄——它们只指类型层面的表面）。

**Implementation（实现）** — 模块内部的东西，它的代码本体。区别于 **Adapter**：一个东西可以是带大实现的小 adapter（一个 Postgres repo），也可以是带小实现的大 adapter（一个内存 fake）。当 seam 是话题时用 "adapter"；否则用 "implementation"。

**Depth（深度）** — 接口处的 leverage：调用者（或测试）每学习一单位接口能调动的行为量。当大量行为坐落在一个小接口背后时，模块是 **deep（深）**；当接口几乎和实现一样复杂时，是 **shallow（浅）**。

**Seam** _(Michael Feathers)_ — 一个你能在不于该处编辑的情况下改变行为的地方；模块接口所在的*位置*。seam 放哪是它自己的设计决策，与放什么在它背后是两回事。_避免_：boundary（被 DDD 的 bounded context 过载了）。

**Adapter** — 在某个 seam 处满足某个接口的具体东西。描述的是*角色*（它填哪个槽），而非实质（它内部是什么）。

**Leverage（杠杆）** — 调用者从 depth 中得到的：每学习一单位接口换得更多能力。一份实现在 N 个调用点和 M 个测试上得到回报。

**Locality（局部性）** — 维护者从 depth 中得到的：变更、bug、知识和验证集中在一处，而不是散布到各调用者。一次修复，处处修复。

## Deep vs shallow

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

- **Depth 是接口的属性，不是实现的属性。** 一个深模块内部可以由小的、可 mock 的、可替换的部件构成——它们只是不属于接口。一个模块可以有 **internal seams（内部 seam）**（私有于其实现，供它自己的测试使用），也可以有其接口处的 **external seam（外部 seam）**。
- **删除测试。** 设想删掉该模块。如果复杂度消失了，它是个 pass-through。如果复杂度在 N 个调用者处重现，它在挣它的饭钱。
- **接口就是测试面。** 调用者和测试穿过同一个 seam。如果你想测试*越过*接口，那这模块大概形状不对。
- **一个 adapter 意味着假想的 seam。两个 adapter 意味着真实的 seam。** 除非确有东西跨它而变，否则别引入 seam。

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

- 一个 **Module** 恰有一个 **Interface**（它向调用者和测试呈现的表面）。
- **Depth** 是 **Module** 的属性，针对其 **Interface** 来衡量。
- **Seam** 是 **Module** 的 **Interface** 所在之处。
- **Adapter** 坐在 **Seam** 处并满足 **Interface**。
- **Depth** 为调用者产生 **Leverage**，为维护者产生 **Locality**。

## 被否决的框架

- **把 depth 当作实现行数与接口行数之比**（Ousterhout）：这会奖励往实现里灌水。我们改用 depth-as-leverage。
- **把 "interface" 当作 TypeScript 的 `interface` 关键字或一个类的公有方法**：太窄——这里的 interface 包含调用者必须知道的每一个事实。
- **"Boundary"**：被 DDD 的 bounded context 过载了。说 **seam** 或 **interface**。

## 更进一步

- **在给定其依赖的情况下加深一个簇** —— 见 [DEEPENING.md](DEEPENING.md)：依赖类别、seam 纪律，以及 replace-don't-layer 的测试法。
- **探索备选接口** —— 见 [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md)：拉起并行子 agent 用几种截然不同的方式设计接口，然后就 depth、locality 和 seam 放置进行比较。
