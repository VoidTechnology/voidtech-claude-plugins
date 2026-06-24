# CONTEXT.md 格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

## 结构

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## 规则

- **要有主见。** 当同一概念存在多个词时，挑出最好的那个，把其余的列在 `_Avoid_` 下。
- **定义要紧凑。** 最多一两句。定义它*是*什么，而非它*做*什么。
- **只收录这个项目上下文特有的术语。** 通用编程概念（超时、错误类型、工具模式）不属于这里，哪怕项目大量使用它们。添加术语前先自问：这是该上下文独有的概念，还是通用编程概念？只有前者才属于这里。
- **当自然出现聚类时，把术语归到子标题下。** 如果所有术语都属于一个内聚领域，平铺列表也行。

## 单上下文 vs 多上下文仓库

**单上下文（多数仓库）：** 仓库根目录一份 `CONTEXT.md`。

**多上下文：** 仓库根目录一份 `CONTEXT-MAP.md`，列出各上下文、它们所在之处，以及它们之间如何关联：

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

技能会推断适用哪种结构：

- 若存在 `CONTEXT-MAP.md`，读它来找各上下文
- 若只存在根目录的 `CONTEXT.md`，即单上下文
- 若两者都不存在，在第一个术语被敲定时惰性创建根目录的 `CONTEXT.md`

当存在多个上下文时，推断当前话题关联哪一个。若不清楚，就提问。
