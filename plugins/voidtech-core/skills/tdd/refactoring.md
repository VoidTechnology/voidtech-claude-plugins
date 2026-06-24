# 重构候选

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

TDD 循环之后，寻找：

- **重复** → 抽取函数/类
- **过长的方法** → 拆成私有辅助函数（测试仍留在公开接口上）
- **浅模块** → 合并或深化
- **依恋情结（Feature envy）** → 把逻辑挪到数据所在之处
- **基本类型偏执（Primitive obsession）** → 引入值对象
- **新代码揭示出有问题的**既有代码
