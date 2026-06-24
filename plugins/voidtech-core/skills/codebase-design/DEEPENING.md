# Deepening

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

如何在给定一个浅模块簇的依赖的情况下安全地加深它。假定你已掌握 [SKILL.md](SKILL.md) 中的词汇——**module**、**interface**、**seam**、**adapter**。

## 依赖类别

评估一个加深候选项时，对它的依赖进行分类。类别决定了加深后的模块如何跨它的 seam 被测试。

### 1. In-process（进程内）

纯计算、内存状态、无 I/O。总是可加深——合并这些模块并直接通过新接口测试。无需 adapter。

### 2. Local-substitutable（本地可替换）

有本地测试替身的依赖（PGLite 替 Postgres、内存文件系统）。若替身存在则可加深。加深后的模块在测试套件中以运行着的替身来测试。seam 是内部的；模块的外部接口处没有 port。

### 3. Remote but owned（远程但自有，Ports & Adapters）

你自己的、跨网络边界的服务（微服务、内部 API）。在 seam 处定义一个 **port**（接口）。深模块拥有逻辑；传输作为 **adapter** 注入。测试用一个内存 adapter。生产用一个 HTTP/gRPC/queue adapter。

推荐措辞：*"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external（真正外部，Mock）

你不掌控的第三方服务（Stripe、Twilio 等）。加深后的模块把外部依赖作为注入的 port 接收；测试提供一个 mock adapter。

## Seam 纪律

- **一个 adapter 意味着假想的 seam。两个 adapter 意味着真实的 seam。** 除非至少有两个 adapter 站得住脚（通常是生产 + 测试），否则别引入 port。单 adapter 的 seam 只是间接层。
- **内部 seam vs 外部 seam。** 一个深模块可以有内部 seam（私有于其实现，供它自己的测试使用），也可以有其接口处的外部 seam。不要仅仅因为测试用了内部 seam 就把它通过接口暴露出去。

## 测试策略：replace, don't layer（替换，不要叠加）

- 一旦在加深后模块的接口处有了测试，浅模块上的旧单元测试就成了废物——删掉它们。
- 在加深后模块的接口处写新测试。**接口就是测试面。**
- 测试针对通过接口可观察到的结果断言，而非内部状态。
- 测试应当在内部重构后存活下来——它们描述行为，而非实现。如果一个测试必须随实现改变而改变，那它在测试越过接口的东西。
