---
name: domain-modeling
description: 构建并打磨项目的领域模型。当用户希望敲定领域术语或统一语言（ubiquitous language）、记录一项架构决策，或当其他技能需要维护领域模型时使用。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 领域建模

在设计的同时，主动构建并打磨项目的领域模型。这是一门*主动*的纪律——质询术语、构想边界场景、一旦术语和决策成形就立刻写进词汇表和决策记录。（仅仅*读* `CONTEXT.md` 取词汇并不是这个技能——那是任何技能都能做的一行习惯。这个技能用于你*在改动模型*之时，而不只是消费它。）

## 文件结构

多数仓库只有单一上下文：

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

如果根目录存在 `CONTEXT-MAP.md`，说明仓库有多个上下文。这张图指向每个上下文所在之处：

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

惰性地创建文件——只在你确有内容可写时创建。如果不存在 `CONTEXT.md`，在第一个术语被敲定时创建。如果不存在 `docs/adr/`，在需要第一份 ADR 时创建。

## 会话进行中

### 对照词汇表质询

当用户用的术语与 `CONTEXT.md` 中既有的语言冲突时，立即指出。"你的词汇表把 'cancellation' 定义为 X，但你似乎指的是 Y——到底是哪个？"

### 磨锐含糊的措辞

当用户使用模糊或一词多义的术语时，提出一个精确的规范术语。"你说 'account'——你指的是 Customer 还是 User？这是两样不同的东西。"

### 讨论具体场景

当讨论领域关系时，用具体场景对其做压力测试。构想能探查边界情况的场景，逼用户在概念之间的边界上把话说精确。

### 与代码交叉核对

当用户陈述某件事如何运作时，检查代码是否同意。如果发现矛盾，把它摆出来："你的代码取消的是整个 Order，但你刚说可以部分取消——哪个对？"

### 内联更新 CONTEXT.md

当一个术语被敲定时，就地更新 `CONTEXT.md`。不要攒着批量处理——发生时就捕获。使用 [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) 中的格式。

`CONTEXT.md` 应当完全不含实现细节。不要把 `CONTEXT.md` 当成规格、草稿本或实现决策的仓库。它是一份词汇表，仅此而已。

### 谨慎提议 ADR

只有当以下三点同时成立时，才提议创建 ADR：

1. **难以逆转** — 日后改主意的代价是实打实的
2. **缺乏背景就令人意外** — 未来的读者会纳闷"他们为什么要这么做？"
3. **是一次真实权衡的结果** — 确有可选项，而你为了特定理由选了其一

只要三者缺一，就跳过 ADR。使用 [ADR-FORMAT.md](./ADR-FORMAT.md) 中的格式。
