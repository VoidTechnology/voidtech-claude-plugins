# 项目配置模板

将 [project-settings.json](project-settings.json) 的字段合并到项目 `.claude/settings.json`。

- 模板只默认启用 `voidtech-core`。
- MCP 插件由成员按需安装，不写入项目默认设置。
- 不要向 JSON 添加 `"//"` 伪注释键；Claude Code 会把它当作设置字段处理。
