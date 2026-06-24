# voidtech-claude-plugins

VoidTech 内部 Claude Code Marketplace。仓库只发布可独立安装、可验证且许可证明确的团队能力；外部运行时和高权限 MCP 必须按需启用。

## 发布结构

```text
.claude-plugin/marketplace.json
plugins/
  voidtech-core/          中文约定与 20 个自包含工程技能
  voidtech-mcp-common/    可选：Context7、Chrome DevTools
  voidtech-mcp-apple/     可选：Apple Docs、XcodeBuildMCP
archive/
  gstack-skills/          等待重写，不参与插件发现
  unlicensed-skills/      缺少再分发许可，不参与发布
scripts/check-portability.sh
templates/project-settings.json
```

## 分发原则

- 核心插件不得依赖插件目录之外的脚本、状态或配置。
- 跨技能调用必须指向同一插件已发布的完整技能名；随附资源使用插件内路径，缺失外部服务时必须有明确降级结果。
- MCP 与核心技能分离，默认禁用，并固定本地执行包的精确版本。
- GitHub 操作优先使用 `gh`；Figma 使用官方插件，不再分发第三方 MCP。
- 第三方技能只有在许可证允许时才能 vendored，并保留来源、上游 commit 与许可证。
- 会提交、推送、合并或部署的工作流只能由用户显式触发。
- `plugin.json` 的版本是发布边界；修改插件内容时必须同步提升对应版本。
- 面向团队的技能命令使用简单、常见且能直接表达动作的英文；成熟技术术语与既有短命令保持稳定。
- 只承担技能编排的内部能力使用 `user-invocable: false`，避免污染用户命令菜单。

## 本地验证

前置条件：Claude Code 2.1.154 或更高版本、`jq`、`rg`。

```bash
scripts/check-portability.sh
scripts/check-portability.sh --install-smoke
```

第一条执行静态检查与 Claude 官方严格校验；第二条额外在隔离配置目录中安装全部三个插件。

## 发布流程

1. 修改插件时提升该插件的语义化版本。
2. 运行完整可移植性检查。
3. 检查 `git diff`，确认没有密钥、浮动依赖或归档技能回流。
4. 推送 Marketplace 仓库后，让成员执行 `claude plugin marketplace update voidtech` 和对应插件更新。
5. 项目仓库只默认启用 `voidtech-core`；MCP 插件由成员按需安装。

成员配置见 [ONBOARDING.md](ONBOARDING.md)，第三方处置依据见 [TRIAGE.md](TRIAGE.md)，逐技能证据见[技能闭环审计](docs/SKILL-CLOSURE-AUDIT.md)和[中文可读性审计](docs/SKILL-LANGUAGE-AUDIT.md)。架构决策见 [ADR-0001](docs/decisions/0001-split-core-and-optional-mcp.md)，技能命名决策见 [ADR-0002](docs/decisions/0002-rename-core-skills.md)。
