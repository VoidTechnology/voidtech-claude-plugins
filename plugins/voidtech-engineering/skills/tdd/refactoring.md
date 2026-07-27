# 重构候选

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

TDD 循环之后，寻找：

- **重复** → 抽取函数/类
- **过长的方法** → 拆成私有辅助函数（测试仍留在公开接口上）
- **浅模块** → 合并或深化
- **逻辑过度依赖其他对象的数据（Feature envy）** → 把逻辑移到拥有这些数据的模块
- **用基本类型表达复杂概念（Primitive obsession）** → 引入值对象
- **新代码暴露出的既有设计问题** → 评估是否需要一并重构
