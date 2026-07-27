---
name: repo-check
description: 检查 VoidTech Claude Plugins 仓库的文档、版本、测试覆盖、可移植性和发布准备状态。
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash
---

# 仓库质量检查

用于 PR 前、发布前或怀疑文档与实现漂移时。只检查和报告；不得自动修改版本、放宽门禁、push、merge 或发布。

## 1. 确认范围

1. 读取根 `AGENTS.md` 和命中路径的专项规则。
2. 运行 `git status --short --branch`，记录分支、worktree 和已有改动。
3. 读取完整变更列表，按插件、根治理、CI、Renderer、Loop 分类。

## 2. 快速契约

```bash
node scripts/run-quality.mjs --tier contract
```

失败时报告具体事实源和漂移：README 数量或版本、失效链接、历史审计状态、未登记测试、插件未提升版本、缺少 CHANGELOG。

## 3. 风险触发验证

| 命中范围 | 追加命令 |
|---|---|
| 任意 Skill、Agent、Hook、MCP、manifest | `node scripts/run-quality.mjs --tier portability` |
| Product Runtime / schema | `node scripts/run-quality.mjs --tier unit` |
| Loop | `node scripts/run-quality.mjs --tier unit`，并请求 `loop-security-reviewer` |
| Renderer 输入或 harness | `node scripts/run-quality.mjs --tier browser` |
| Release | `node scripts/run-quality.mjs --all` 与 `node scripts/run-quality.mjs --tier install-smoke` |

不要把未命中平台或未执行命令写成已验证。

## 4. Review

需要内容 Review 时调用：

- `plugin-contract-reviewer`：Skill、Agent、Hook、MCP、Marketplace、版本与可移植性。
- `loop-security-reviewer`：Loop 的 shell、Git、路径、状态、锁、审批和 eval 边界。

CI 通过不能替代 Review。

## 5. 输出

按以下顺序报告：

1. **结论**：可合入 / 不可合入 / 可发布 / 不可发布。
2. **P0/P1 问题**：文件、行为、证据、修复条件；无则明确写“无”。
3. **验证**：实际命令和结果。
4. **未验证与风险**：平台、权限、外部服务和手工步骤。
5. **下一步**：唯一的具体动作。
