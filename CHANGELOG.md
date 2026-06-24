# Changelog

## 0.2.0 - 2026-06-23

### Changed

- 将 `voidtech-toolkit` 拆分为 `voidtech-core`、`voidtech-mcp-common` 与 `voidtech-mcp-apple`。
- MCP 改为默认禁用并固定本地执行包版本。
- 中文约定改为每个会话注入一次。

### Removed

- 从发布区移除依赖完整 gstack 运行时的 8 个技能。
- 从工作树删除缺少明确许可证的 `karpathy-guidelines` 原文，只保留审计记录。
- 停止分发已废弃的 GitHub npm MCP、第三方 Figma MCP、Desktop Commander 与 Fetch MCP。

### Added

- 增加可移植性检查、隔离安装冒烟测试与 GitHub Actions 质量门。
