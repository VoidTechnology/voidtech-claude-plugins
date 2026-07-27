# 发布与版本规则

- 日期：2026-07-27
- 状态：Current
- 摘要：定义插件内容变化、语义化版本、CHANGELOG、兼容性和显式发布流程。

## 发布边界

每个 `plugins/<name>` 是独立发布单元。任何会进入安装目录的文件变化都必须提升该插件的 `plugin.json` 版本，包括 Skill、Agent、Hook、MCP 配置、Runtime、模板、schema、资源和随包测试。

只修改根治理文件、CI、根文档、`scripts/` 或 `.claude/` 不触发插件版本提升。

## 语义化版本

- **patch**：兼容修复、文案修正、性能改进，不增加公开能力、不改变权限。
- **minor**：新增向后兼容的 Skill、Agent、命令、字段或能力。
- **major**：删除或改名公开命令、破坏数据/schema、扩大默认权限、改变不可兼容行为。

版本不能回退，也不能以重复版本发布不同内容。

## 同步要求

插件版本变化必须在同一 PR 同步：

1. `plugins/<name>/.claude-plugin/plugin.json`
2. `README.md` 插件表
3. `CHANGELOG.md`

CHANGELOG 写用户可见行为、迁移方式、兼容边界和风险，不罗列文件名。

## 兼容性

- README 声明的最低 Claude Code、Node.js、平台必须有对应 CI 或明确的手工验证证据。
- MCP 使用精确版本；升级时检查许可证、权限、弃用和漏洞。
- Loop 的最低版本与平台和其他插件分开声明，不用 Core 的宽兼容承诺替代。

## 发布流程

1. 维护者选择插件和目标版本。
2. 版本、README、CHANGELOG 已在 PR 中完成并通过 version guard。
3. 运行全部质量门和七插件隔离安装。
4. Review 最终 diff 与第三方许可证。
5. 维护者显式触发 Release workflow，输入插件名和 manifest 中已有版本。
6. Workflow 验证 tag 不存在后创建 `<plugin>-v<version>` Release。
7. 用户更新 Marketplace 和对应插件。

自动化不得自行决定版本、修改 manifest、push 或发布。

## 回滚

- 代码回滚通过新 patch 版本发布，不能重写已发布 tag。
- 安全问题在 Release Notes 标明受影响版本和最低安全版本。
- MCP 或外部工具故障优先禁用可选能力，不扩大 Core 默认权限。
