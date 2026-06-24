# 深化模块

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

说明如何在考虑依赖的前提下，把一组浅模块安全地整合为深模块。开始前先阅读 [SKILL.md](SKILL.md) 中的 **module**、**interface**、**seam** 和 **adapter** 定义。

## 依赖类别

评估模块深化方案时，先对依赖分类。依赖类别决定了深化后的模块如何跨 seam 进行测试。

### 1. In-process（进程内）

纯计算、内存状态、无 I/O。通常可以直接合并这些模块，并通过新接口测试，不需要 adapter。

### 2. Local-substitutable（本地可替换）

有本地测试替代实现的依赖，例如用 PGLite 代替 Postgres、用内存文件系统代替真实磁盘。存在可靠替代实现时可以深化模块，并在测试中使用它。seam 留在模块内部，不需要把 port 暴露到公开接口。

### 3. Remote but owned（远程但自有，Ports & Adapters）

团队自己维护、但通过网络访问的服务，例如微服务或内部 API。在 seam 处定义一个 **port**（接口）。业务逻辑放在深模块中，传输方式通过 **adapter** 注入。测试使用内存 adapter，生产环境使用 HTTP、gRPC 或消息队列 adapter。

推荐措辞：*"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external（真正外部，Mock）

你无法控制的第三方服务，例如 Stripe、Twilio。深化后的模块通过注入的 port 接收这类依赖；测试使用 mock adapter。

## Seam 使用原则

- **只有一个 adapter 时，seam 可能没有实际价值；有两个 adapter 时，替换需求才成立。** 除非至少有两个合理的 adapter（通常是生产实现和测试实现），否则不要引入 port。
- **内部 seam vs 外部 seam。** 一个深模块可以有内部 seam（私有于其实现，供它自己的测试使用），也可以有其接口处的外部 seam。不要仅仅因为测试用了内部 seam 就把它通过接口暴露出去。

## 测试策略：replace, don't layer（替换，不要叠加）

- 深化后的模块已经通过公开接口覆盖行为时，删除浅模块上重复的旧单元测试。
- 在深化后模块的接口处写新测试。**接口就是测试面。**
- 测试针对通过接口可观察到的结果断言，而非内部状态。
- 内部重构后测试仍应通过，因为测试描述的是行为而不是实现。如果测试必须随内部实现一起修改，说明它越过了公开接口。
