---
name: feature-context
description: 建立并维护项目的功能上下文。当用户需要统一业务词汇、澄清场景边界、记录架构决策，或其他技能需要更新功能上下文时使用。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 功能上下文

在设计过程中同步维护项目的功能上下文：检查业务词汇是否准确，用具体场景验证概念边界，并把确认后的术语和决策及时写入词汇表或 ADR。仅仅读取 `CONTEXT.md` 不需要调用本技能；只有新增、修改或澄清功能上下文时才使用。

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

按需创建文件。确认第一个业务术语时再创建 `CONTEXT.md`；需要记录第一份 ADR 时再创建 `docs/adr/`。

## 会话进行中

### 对照词汇表检查用词

当用户用的术语与 `CONTEXT.md` 中既有的语言冲突时，立即指出。"你的词汇表把 'cancellation' 定义为 X，但你似乎指的是 Y——到底是哪个？"

### 明确含糊的措辞

当用户使用模糊或一词多义的术语时，提出一个精确的规范术语。"你说 'account'——你指的是 Customer 还是 User？这是两样不同的东西。"

### 用具体场景验证

讨论业务概念关系时，使用具体场景验证边界情况，帮助用户明确相近概念之间的区别。

### 与代码交叉核对

当用户说明某项业务规则时，检查代码是否一致。发现矛盾时直接指出："代码会取消整个 Order，但你刚才说可以部分取消。哪一个才是预期行为？"

### 内联更新 CONTEXT.md

术语确认后立即更新 `CONTEXT.md`，不要等到会话结束再集中整理。使用 [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) 中的格式。

`CONTEXT.md` 应当完全不含实现细节。不要把 `CONTEXT.md` 当成规格、草稿本或实现决策的仓库。它是一份词汇表，仅此而已。

### 谨慎提议 ADR

只有当以下三点同时成立时，才提议创建 ADR：

1. **难以逆转** — 以后改变决定的成本较高
2. **缺少背景就难以理解** — 未来读者可能无法判断为什么这样选择
3. **是一次真实权衡的结果** — 确有可选项，而你为了特定理由选了其一

只要三者缺一，就跳过 ADR。使用 [ADR-FORMAT.md](./ADR-FORMAT.md) 中的格式。
