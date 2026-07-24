# Vendored: archify

- 上游: https://github.com/tt-a1i/archify
- 版本: 2.12.0
- 提交: eb847fa65afd8f0913dd9d8915d0895771545c89
- 引入日期: 2026-07-24
- 许可: MIT（见同目录 LICENSE；上游为 Cocoon-AI/architecture-diagram-generator v1.0 的 fork 重写，原始视觉语言归属 Cocoon AI）

## 引入目的

为 logic-atlas 提供五种类型化图渲染基础设施（Architecture / Workflow / Sequence /
Data Flow / Lifecycle）：typed JSON IR + 预编译 schema 校验 + 确定性 SVG/HTML 渲染。
首个接线目标是状态机视图（Lifecycle）；其余图型为后续技术架构阶段的能力储备，
**在上游数据具备真实关系之前不得接线**（Logic Atlas 原则：不虚构关系）。

## 保留内容

| 路径 | 作用 |
|---|---|
| `bin/` | CLI 入口（validate / preview / deliver / guide / compare） |
| `renderers/` | 五种渲染器 + shared（含预编译 `generated-validators.mjs`，运行时零 npm 依赖） |
| `schemas/` | JSON IR schema（schema_version=1） |
| `assets/template.html` | 独立 viewer 模板，渲染必需 |
| `delta/` | Architecture Delta（Before/Delta/After 快照对比） |
| `recipes/` | `guide` 命令的场景选型知识 |
| `scripts/` | validator 重新生成（仅开发期需要 ajv devDependency） |
| `SKILL.md` | 上游 IR 编写与渲染契约（编写 IR 时必读） |

## 裁剪内容

`examples/`（3.0M 示例产物）、`test/`（728K 上游测试）、`package-lock.json`。
影响：`archify.mjs demo` 与无参 `compare` 的内置示例不可用；核心
validate / preview / deliver 不受影响。

## 更新方式

不在本仓库内修改 vendored 代码。升级时整目录替换并更新本文件的版本/提交号；
如需改 schema，先向上游提 PR。

## 运行时要求

Node >= 18（本仓库既有 renderer 验证 harness 已要求 Node >= 22，满足）。
