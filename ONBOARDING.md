# VoidTech · Claude Code 团队工具上手

## 1. 前置条件

- Claude Code 2.1.154 或更高版本
- 使用 MCP 插件时需要 Node.js 20.19 或更高版本
- Apple MCP 仅支持安装了 Xcode 的 macOS

```bash
claude --version
node --version
```

## 2. 安装核心插件

项目的 `.claude/settings.json` 应合入 `templates/project-settings.json`。手动安装时执行：

```bash
claude plugin marketplace add VoidTechnology/voidtech-claude-plugins
claude plugin install voidtech-core@voidtech
```

从旧版迁移时，先把项目 `.claude/settings.json` 中的 `voidtech-toolkit@voidtech` 替换为 `voidtech-core@voidtech`，再更新 Marketplace 并移除旧插件：

```bash
claude plugin marketplace update voidtech
claude plugin uninstall voidtech-toolkit@voidtech
claude plugin install voidtech-core@voidtech
```

## 3. 按需安装 MCP

通用 MCP：

```bash
export CONTEXT7_API_KEY="your-context7-key"
claude plugin install voidtech-mcp-common@voidtech
```

Apple MCP：

```bash
claude plugin install voidtech-mcp-apple@voidtech
```

两个 MCP 插件都默认禁用。安装后使用 `claude plugin enable <plugin>@voidtech` 启用，并在首次连接时审查 MCP 权限。

## 4. 外部工具

- GitHub：执行 `gh auth login`，团队技能优先使用 `gh` CLI。
- Figma：安装 Figma 官方插件并使用其 OAuth 流程。
- Vercel：按项目需要安装 Vercel 官方插件。

团队 Marketplace 不分发 GitHub、Figma、Vercel 的第三方替代实现。

## 5. 验证

```bash
claude plugin list
```

进入 Claude Code 后检查：

```text
/skills
/hooks
/mcp
/doctor
```

预期结果：`voidtech-core` 已启用；中文约定由 `SessionStart` hook 注入一次；只有主动安装并启用的 MCP 才出现在 `/mcp`。
