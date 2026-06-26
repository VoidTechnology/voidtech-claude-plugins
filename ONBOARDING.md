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

- GitHub：安装 `gh` CLI，执行 `gh auth login`。
- GitLab：安装 `glab` CLI，执行 `glab auth login`。
- Figma：安装 Figma 官方插件并使用其 OAuth 流程。
- Vercel：按项目需要安装 Vercel 官方插件。

macOS 推荐使用 Homebrew 安装命令行工具：

```bash
brew install gh glab
gh auth login
glab auth login
gh auth status
glab auth status
```

如果使用 GitHub Enterprise Server 或 GitLab Self-Managed，在对应仓库目录内运行登录命令；`gh` 和 `glab` 都会根据交互流程绑定目标 host。也可以显式指定 host：

```bash
gh auth login --hostname github.example.com
glab auth login --hostname gitlab.example.com
```

其他平台或企业分发环境参考官方安装文档：[GitHub CLI](https://cli.github.com/) 和 [GitLab CLI](https://gitlab.com/gitlab-org/cli)。

团队 Marketplace 不分发 GitHub、GitLab、Figma、Vercel 的第三方替代实现。

## 5. 按需安装官方插件

官方插件是增强层，不替代 `voidtech-core` 的团队默认工作流。建议只按项目需要安装：

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install plugin-dev@claude-plugins-official
claude plugin install security-guidance@claude-plugins-official
claude plugin install pr-review-toolkit@claude-plugins-official
claude plugin install frontend-design@claude-plugins-official
```

安装建议：

- 维护 Claude plugin 时安装 `plugin-dev`。
- 团队希望增加代码安全提醒时安装 `security-guidance`。
- 需要在 `/voidtech-core:ship` 前后做独立 PR/MR 审查时安装 `pr-review-toolkit` 或 `code-review`，二选一。
- 做前端 UI 时安装 `frontend-design`；需要设计稿上下文时再安装 `figma`。
- 已安装 `voidtech-mcp-common` 时，不再重复安装官方 `context7` 或 `chrome-devtools-mcp`。
- 不建议常态安装 `commit-commands`、`feature-dev` 或 `superpowers`，它们和 VoidTech 主工作流职责重叠。

## 6. 验证

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
