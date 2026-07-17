# VoidTech · Claude Code 团队工具上手

## 1. 前置条件

- `voidtech-core`：Claude Code 2.1.154 或更高版本
- `voidtech-loop`：Claude Code 2.1.210 或更高版本；当前 F3 阶段仅支持 macOS arm64，并依赖 Node.js 18+、Git 与 `jq`
- 使用 MCP 插件时需要 Node.js 20.19 或更高版本
- Apple MCP 仅支持安装了 Xcode 的 macOS

```bash
claude --version
node --version
```

## 2. 安装核心插件与工程内循环

项目的 `.claude/settings.json` 应合入 `templates/project-settings.json`（其中已为 `voidtech` marketplace 声明 `"autoUpdate": true`）。手动安装时执行：

```bash
claude plugin marketplace add VoidTechnology/voidtech-claude-plugins
claude plugin install voidtech-core@voidtech
```

`voidtech-loop` 用于完成条件可由命令退出码判定的无人值守工程任务。满足 macOS arm64、Claude Code 2.1.210+、Node.js 18+、Git 与 `jq` 后再安装：

```bash
claude plugin install voidtech-loop@voidtech
```

不满足试点条件时跳过该插件，不影响 `voidtech-core`。loop 不自动 push、merge、创建 PR/MR 或改写用户分支；机器 eval 通过后仍需人工复核。

### 2.1 开启 marketplace 自动更新（必做）

第三方 marketplace 的自动更新默认关闭。不开启的话，插件发版后不会出现 "Plugin updated: … Run /reload-plugins to apply" 提示，只能手动 `claude plugin marketplace update voidtech`。

安装后按顺序确认两件事：

1. **settings 配置**：项目 `.claude/settings.json` 的 `extraKnownMarketplaces.voidtech` 条目包含与 `source` 平级的 `"autoUpdate": true`。缺少时补上：

   ```json
   {
     "extraKnownMarketplaces": {
       "voidtech": {
         "source": { "source": "github", "repo": "VoidTechnology/voidtech-claude-plugins" },
         "autoUpdate": true
       }
     }
   }
   ```

2. **界面确认**：在 Claude Code 内运行 `/plugin` → **Marketplaces** → 选择 `voidtech`，确认显示 auto-update 已启用；若仍为关闭，选择 **Enable auto-update**。这一步是交互界面，需要用户本人操作。

> 给引导安装的 Agent：完成 `marketplace add` 和 `plugin install` 后，必须检查并写入上面的 `autoUpdate` 配置（settings 文件可以直接编辑），然后提醒用户在 `/plugin` 界面做最终确认。没有 CLI 子命令可以切换这个开关，不要凭空编造 `claude plugin marketplace` 参数。
>
> 仓库为私有时，后台自动更新依赖本机 git 凭据：先执行 `gh auth setup-git`（或配置等效 credential helper），否则后台拉取会失败。

从旧版迁移时，先把项目 `.claude/settings.json` 中的 `voidtech-toolkit@voidtech` 替换为 `voidtech-core@voidtech`，再更新 Marketplace 并移除旧插件：

```bash
claude plugin marketplace update voidtech
claude plugin uninstall voidtech-toolkit@voidtech
claude plugin install voidtech-core@voidtech
```

满足上述试点条件、需要工程内循环时，再单独安装 `voidtech-loop@voidtech`。

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
claude plugin install exa@claude-plugins-official
claude plugin install firecrawl@claude-plugins-official
claude plugin install youdotcom-agent-skills@claude-plugins-official
```

安装建议：

- 维护 Claude plugin 时安装 `plugin-dev`。
- 团队希望增加代码安全提醒时安装 `security-guidance`。
- 需要在 `/voidtech-core:ship` 前后做独立 PR/MR 审查时安装 `pr-review-toolkit` 或 `code-review`，二选一。
- 做前端 UI 时安装 `frontend-design`；需要设计稿上下文时再安装 `figma`。
- 需要开放网络调研时安装 `exa`、`firecrawl`、`youdotcom-agent-skills`，配合 `/voidtech-core:research` 做多信源搜索、抓取和带引用研究。
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

预期结果：`voidtech-core` 已启用；试点环境中 `voidtech-loop` 已启用，`/skills` 可看到 `voidtech-loop:goal`、`voidtech-loop:goal-spec` 与 `voidtech-loop:review`；中文约定由 `SessionStart` hook 注入一次；只有主动安装并启用的 MCP 才出现在 `/mcp`；`/plugin` → **Marketplaces** 中 `voidtech` 的 auto-update 为已启用。
