# VoidTech Claude Plugins：Agent 工作入口

> 本文件是维护本仓库时的 Agent 规则正本。`CLAUDE.md` 只引用本文件，不重复维护规则。

## 仓库边界

- 本仓库发布 Claude Code Marketplace、插件、仓库维护自动化和相关文档。
- 不修改 Claude Code 本体、外部 MCP 源码或使用本仓插件的下游项目。
- 开始前检查当前分支、worktree 和工作区状态；不覆盖、不回退已有改动。
- 未经用户明确授权，不 push、merge、发布、修改远端分支保护或删除数据。

## 规则索引

- 首次定位代码、判断文件归属前，读 `docs/dev-rules/repo-map.md`。
- 修改任何插件、Skill、Agent、Hook、MCP 或 Marketplace 清单前，读
  `docs/dev-rules/plugin-authoring-and-portability.md`。
- 修改 `voidtech-loop`、Shell 执行、Git refs、worktree、protected paths、凭据或权限边界前，读
  `docs/dev-rules/loop-security-boundaries.md`。
- 准备提交、PR、Review 或处理并行工作区前，读
  `docs/dev-rules/development-workflow.md`。
- 修改插件版本、README 版本表、CHANGELOG 或 GitHub Release 前，读
  `docs/dev-rules/release-and-versioning.md`。
- 修改产品能力归属、用户工作流或公开命令前，先读 `README.md`、`docs/USAGE.md` 和相关 ADR。

## 通用工作流程

1. 明确用户、问题、成功标准和明确不做的范围。
2. 先读实际实现、测试和专项规则，不依赖文档猜测现状。
3. 采用独立短期分支或 worktree，保护用户已有改动。
4. 先写能暴露风险的测试，再做最小实现。
5. 能由代码、schema、状态机或 guard 保证的行为，不交给 Prompt 自由判断。
6. 按路径运行定向检查，再运行仓库质量门。
7. Review 完整 diff，如实报告已验证、未验证、风险和回滚方式。

## 最低验证

```bash
node scripts/run-quality.mjs --tier contract
node scripts/run-quality.mjs --tier unit
scripts/check-portability.sh
```

Renderer 变化追加：

```bash
node scripts/run-quality.mjs --tier browser
```

准备发布追加：

```bash
node scripts/run-quality.mjs --all
scripts/check-portability.sh --install-smoke
```

禁止通过删除测试、缩小发现范围、skip、放宽 schema 或把失败改成 warning 来制造通过。

## 插件与安全底线

- 会提交、推送、合并、发布或部署的 Skill 必须只能由用户显式触发。
- MCP 独立发布、默认禁用、固定精确版本；首次启用必须让用户审查权限。
- Hook 必须 fail closed，但不能拦截只读 Git 命令。
- Plugin Runtime 不依赖仓库 checkout、用户私有目录或未分发命令。
- 跨插件调用只指向 Marketplace 已发布的完整命名空间。
- 第三方内容必须保留来源、固定版本或 commit、许可证和修改说明。
- 不提交凭据、Token、授权文件、用户路径、用户数据或可识别个人的信息。

## Git 与发布

- 默认 PR-first，`main` 始终可安装。
- 一个 PR 只解决一个目标；重构、行为变化和发布基础设施尽量分开。
- 插件安装内容变化必须提升对应 `plugin.json` 版本，并同步 README 和 CHANGELOG。
- 自动化可以验证和准备 Release，但不得自行决定版本或触发发布。
- `EVALS_PASSED` 只表示指定 commit 通过约定 eval，不替代人工接受和合入。

## 事实来源

- 插件集合：`.claude-plugin/marketplace.json`
- 插件版本：`plugins/*/.claude-plugin/plugin.json`
- 公开 Skill / Agent：各插件的 `skills/` 与 `agents/`
- 测试覆盖清单：`scripts/quality-manifest.mjs`
- 发布历史：`CHANGELOG.md`
- 用户用法：`docs/USAGE.md`

文档与实现冲突时，以代码和 manifest 为当前事实；必须在同一改动中修正文档和契约测试。
