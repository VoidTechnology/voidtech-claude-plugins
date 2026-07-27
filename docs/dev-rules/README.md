# 开发规则索引

- 日期：2026-07-27
- 状态：Current
- 摘要：列出维护 VoidTech Claude Plugins 时按任务加载的权威规则。

| 文档 | 读取时机 |
|---|---|
| [仓库地图](repo-map.md) | 首次定位代码或判断能力归属 |
| [开发工作流](development-workflow.md) | 创建 worktree、实现、测试、Review、PR |
| [插件编写与可移植性](plugin-authoring-and-portability.md) | 修改 Skill、Agent、Hook、MCP、资源和第三方内容 |
| [Loop 安全边界](loop-security-boundaries.md) | 修改命令执行、Git、worktree、状态、权限和验收 |
| [发布与版本](release-and-versioning.md) | 修改插件版本、CHANGELOG、兼容性和 Release |

规则入口为根 `AGENTS.md`。文档与代码冲突时，以 manifest 和实现为当前事实，并在同一改动修正文档。
