# 开发工作流

- 日期：2026-07-27
- 状态：Current
- 摘要：定义 worktree、测试、Review、PR 和远端副作用的统一交付流程。

## 1. 隔离工作

- 开始前运行 `git status --short --branch`。
- 发现已有改动时，不覆盖、不 stash、不切走用户分支；创建独立 worktree。
- worktree 从用户当前已提交的 HEAD 或明确 base 创建，不包含未提交改动。
- 分支保持短期、单一目标，可独立 Review 和回滚。

## 2. 实现顺序

1. 写清目标、验收标准与不做范围。
2. 读取命中路径的实现、测试和专项规则。
3. 对行为变化先写失败测试。
4. 实现最小改动并运行定向测试。
5. 运行 `node scripts/run-quality.mjs --tier contract`。
6. 按风险追加 unit、browser、install smoke。
7. Review 完整 diff，确认没有无关重构。

## 3. 验证分层

| 改动 | 最低验证 |
|---|---|
| 根文档、治理、CI | `node scripts/run-quality.mjs --tier contract` |
| Skill、Agent、Hook、MCP | contract + `scripts/check-portability.sh` |
| Product Runtime / schema | contract + unit |
| Loop | contract + unit（macOS arm64 CI） |
| Renderer | contract + unit + browser |
| 发布 | `run-quality --all` + `check-portability.sh --install-smoke` |

PR 必须列出实际执行结果和未执行验证。未运行不能写“通过”。

## 4. Review 严重度

- **P0**：安全边界绕过、凭据泄漏、数据或 Git 历史破坏、任意命令执行、发布错误。阻断合入。
- **P1**：行为错误、契约漂移、测试漏跑、版本未提升、安装后资源缺失。必须在本次修复。
- **P2**：不影响正确性的可读性或风格建议。可选，不制造 Review 噪音。

高风险路径由 CODEOWNERS 指派维护者 Review。CI 通过不替代内容 Review。

## 5. PR 与远端操作

- 默认通过 Pull Request 合入 `main`。
- commit、push、创建 PR、修改分支保护和发布都需要用户明确授权或显式触发的维护工作流。
- 自动化不得 force-push、自动 merge 或绕过 required checks。
- 发布工作流只接受维护者提供的插件名和已写入 manifest 的版本。

## 6. 完成标准

完成不是“文件已生成”，而是：

- 用户路径或维护目标端到端成立；
- 新行为有可失败的测试；
- 所有受影响测试和质量门通过；
- 文档、版本、CHANGELOG 与实现一致；
- 风险、回滚和未验证项已记录；
- 工作区只包含本任务改动。
