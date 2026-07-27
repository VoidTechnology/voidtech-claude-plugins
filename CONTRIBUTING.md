# 贡献指南

- 日期：2026-07-27
- 状态：Current
- 摘要：说明如何为 VoidTech Claude Plugins 提交可复核、可安装、可回滚的贡献。

感谢你参与改进 VoidTech Claude Plugins。仓库接受文档、Skill、Agent、Hook、MCP 配置、运行时和测试贡献。

## 开始之前

需要以下工具：

- Git
- Node.js 22.22.0 或更高版本
- Python 3
- `jq`
- `rg`
- Claude Code 2.1.211 或更高版本

克隆仓库后先运行：

```bash
scripts/check-portability.sh
node scripts/run-quality.mjs --tier contract
```

完整安装冒烟需要本机可执行 `claude`：

```bash
scripts/check-portability.sh --install-smoke
```

## 选择改动位置

- 公共能力放在 `plugins/voidtech-core`。
- 产品、设计、工程工作流分别放在对应领域插件。
- 确定性工程循环只放在 `plugins/voidtech-loop`。
- MCP 必须放在独立、默认禁用的 MCP 插件。
- 仓库维护自动化放在根 `.claude/`，不随 Marketplace 分发。

目录说明与风险入口见 `AGENTS.md` 和 `docs/dev-rules/repo-map.md`。

## 开发流程

1. 从最新 `main` 创建短期分支或独立 worktree。
2. 修改前读取相关实现、测试和 `docs/dev-rules/` 专项规则。
3. 保持单一目标，不混入无关重构。
4. 新行为先写能失败的测试，再实现最小改动。
5. 运行与改动路径匹配的检查。
6. 如果发布插件内容变化，提升该插件的语义化版本并更新 `CHANGELOG.md`。
7. Review 完整 diff，确认没有凭据、浮动依赖或未授权的第三方内容。
8. 通过 Pull Request 合入，不直接推送 `main`。

## 验证命令

```bash
# 文档、版本、测试覆盖清单
node scripts/run-quality.mjs --tier contract

# Product 与 Loop 行为测试
node scripts/run-quality.mjs --tier unit

# Renderer 浏览器验证
node scripts/run-quality.mjs --tier browser

# 全部本地门禁
node scripts/run-quality.mjs --all

# 七个插件隔离安装
scripts/check-portability.sh --install-smoke
```

PR 只填写实际执行过的命令。没有执行的验证必须写明原因。

## 插件版本规则

任何会进入插件安装目录的内容发生变化，都必须提升对应 `plugin.json` 版本。纯仓库治理、CI、根文档和 `.claude/` 维护自动化不触发插件发版。

版本采用语义化版本：

- `patch`：兼容的修复或文案修正；
- `minor`：向后兼容的新 Skill、Agent、能力或行为；
- `major`：删除、改名、权限扩大或不兼容契约变化。

版本更新必须同步：

- `plugins/<name>/.claude-plugin/plugin.json`
- `README.md` 插件表
- `CHANGELOG.md`

## Pull Request 要求

PR 必须说明：

- 用户或维护者遇到的问题；
- 本次包含与明确不包含的范围；
- 用户可见变化；
- 自动验证与手工验证；
- 未执行验证；
- 权限、安全、兼容和发布风险；
- 回滚方式。

Hook、MCP、`voidtech-loop`、发布工作流和第三方 vendored 内容属于高风险路径，需要维护者 Review。

### `main` 保护要求

仓库维护者应在 GitHub Ruleset / Branch Protection 中启用：

- 只允许 Pull Request 合入，至少 1 位 reviewer 批准；
- 命中 `CODEOWNERS` 的高风险路径必须由 code owner 批准；
- 新 commit 到达后撤销过期批准，并要求所有 review conversation 已解决；
- 必须通过 `Quality contract`、`Portability`，以及路径命中的 `Product behavior`、`Renderer validation`、`voidtech-loop` 和 `Claude Code compatibility`；
- 禁止 force-push 和删除 `main`；管理员只在安全事故恢复时临时绕过并留记录。

这些远端规则无法由仓库文件自动开启；新 fork 或迁移仓库时必须单独配置。

## 第三方内容

不得复制来源或许可证不明的 Skill、代码、模板和文档。Vendored 内容必须保留：

- 上游来源；
- 固定 commit 或版本；
- 原许可证；
- 本地修改说明；
- 升级与验证方式。

## 行为规范与安全问题

参与项目即表示同意 `CODE_OF_CONDUCT.md`。安全漏洞不要提交公开 Issue，按 `SECURITY.md` 私下报告。
