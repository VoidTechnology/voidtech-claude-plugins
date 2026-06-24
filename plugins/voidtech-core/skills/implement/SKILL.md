---
name: implement
description: 根据 PRD 或一组 issue 完成功能实现、测试和交付检查。
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

实现用户在 PRD 或 issue 中所描述的工作。

尽可能使用 `voidtech-core:tdd`，在事先约定好的 seam 处进行。

经常运行类型检查，经常运行单个测试文件，并在最后运行一次完整的测试套件。

完成后直接执行以下自审，不依赖其他评审技能：

- 逐条核对 PRD 或 issue 的验收标准，并给出实现或测试证据。
- 检查正确性、错误路径、边界条件、安全性和明显的性能退化。
- 检查 diff 中是否混入无关改动、调试代码、临时文件或敏感信息。
- 运行项目规定的格式、静态检查、类型检查和完整测试；无法运行的项目要说明原因。

只有用户明确要求提交时才提交到当前分支；否则保留已验证但未提交的工作树，并给出变更摘要。
