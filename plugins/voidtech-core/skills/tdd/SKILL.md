---
name: tdd
description: 测试驱动开发。当用户希望以测试先行的方式构建功能或修复缺陷、提到 "red-green-refactor"、或需要集成测试时使用。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 测试驱动开发

## 理念

**核心原则**：测试应当通过公开接口验证行为，而非验证实现细节。代码可以彻底改变，但测试不该随之改变。

**好的测试**是集成风格的：它们通过公开 API 走真实的代码路径。它们描述系统*做什么*，而不是*怎么做*。一个好的测试读起来像一份规格说明——"user can checkout with valid cart" 直接告诉你存在哪种能力。这类测试能在重构中存活，因为它们不关心内部结构。

**坏的测试**与实现耦合。它们 mock 内部协作者、测试私有方法，或通过外部手段验证（比如直接查数据库而不是走接口）。警示信号是：你重构时测试挂了，但行为根本没变。如果你重命名一个内部函数导致测试失败，那些测试测的是实现，不是行为。

示例见 [tests.md](tests.md)，mock 指南见 [mocking.md](mocking.md)。

## 反模式：水平切片

**不要先写完所有测试再写所有实现。** 这是"水平切片"——把 RED 当成"写完所有测试"、把 GREEN 当成"写完所有代码"。

它产出的是**垃圾测试**：

- 批量写出的测试测的是*想象中*的行为，不是*实际*的行为
- 你最终测的是事物的*形态*（数据结构、函数签名），而不是面向用户的行为
- 测试对真实变更变得迟钝——行为坏了它们却通过，行为没事它们却失败
- 你冲到了车灯照不到的地方，在理解实现之前就锁定了测试结构

**正确做法**：用曳光弹方式做垂直切片。一个测试 → 一份实现 → 重复。每个测试都回应你从上一轮学到的东西。因为代码刚刚才写，你确切知道哪些行为重要、如何验证。

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## 工作流

### 1. 规划

探查代码库时，读 `CONTEXT.md`（若存在），让测试命名与接口词汇匹配项目的领域语言，并尊重你所改动区域内的 ADR。

写任何代码之前：

- [ ] 与用户确认需要哪些接口变更
- [ ] 与用户确认要测试哪些行为（排好优先级）
- [ ] 识别深模块的机会（小接口、深实现）——运行 `/codebase-design` 技能获取相关词汇与可测性检查
- [ ] 列出要测试的行为（不是实现步骤）
- [ ] 获得用户对计划的批准

提问："公开接口应该长什么样？哪些行为最值得测试？"

**你无法测试一切。** 与用户确认到底哪些行为最重要。把测试精力集中在关键路径和复杂逻辑上，而不是每一个可能的边界情况。

### 2. 曳光弹

写一个测试，确认系统的一件事：

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

这就是你的曳光弹——证明这条路径端到端走得通。

### 3. 增量循环

对剩余的每个行为：

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

规则：

- 一次一个测试
- 只写刚好让当前测试通过的代码
- 不要预判未来的测试
- 让测试聚焦于可观察的行为

### 4. 重构

所有测试通过后，寻找[重构候选](refactoring.md)：

- [ ] 抽取重复
- [ ] 深化模块（把复杂度藏到简单接口背后）
- [ ] 在自然之处应用 SOLID 原则
- [ ] 思考新代码揭示了已有代码的什么问题
- [ ] 每一步重构后都跑一遍测试

**永远不要在 RED 状态下重构。** 先到 GREEN。

## 每轮循环的检查清单

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```
