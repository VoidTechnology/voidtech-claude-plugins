# VoidTech Loop 安全边界

- 日期：2026-07-27
- 状态：Current
- 摘要：定义无人值守工程循环不可弱化的执行、Git、状态和人工接受边界。

## 核心不变量

- Loop 只处理有明确、可机器判定完成条件的工程任务。
- Goal Spec 规范化后不可变；eval、protected paths、预算和权限进入稳定 hash。
- Worker、baseline 和 eval 在隔离 worktree 中执行，不在用户工作区产生副作用。
- 只验收指定 commit；工作树未提交内容不能被冒充为已验收结果。
- `EVALS_PASSED` 不等于接受、合入或发布，最终决定仍由人类作出。
- Loop 不自动 push、merge、创建 PR 或修改用户分支。

## 命令执行

- argv 与 shell 都是高权限执行面；shell 必须有单独、精确的用户确认。
- 命令有硬超时、取消和总预算；超时必须终止整个子进程组。
- setup、baseline、worker 和 eval 的执行语义都进入 Execution Plan hash。
- 命令输出有有界证据、完整流 hash 和明确截断标记，不能静默丢失失败尾部。

## Git 与路径

- Worker 不得改写 refs、移动 HEAD、修改共享 Git 目录或绕过临时 index。
- protected paths 使用单一、确定的匹配语义；不接受否定模式和路径逃逸。
- `.voidtech-loop`、`.claude`、凭据文件和敏感文件名默认受保护。
- checkpoint 必须使用 CAS，分支并发移动时拒绝覆盖。
- 临时 worktree、guard 和 lock 在成功、失败、超时和取消路径都要清理。

## 状态与恢复

- schema 拒绝未知字段和未知版本，默认 fail closed。
- 状态文件、approval、decision、bundle 和 operation journal 使用内容 hash 验证。
- 发布必须是原子的：失败时不产生半完成的 committed 状态，并允许精确重试。
- 锁处理必须防 PID 复用、陈旧接管竞争和非持有者释放。
- manual review 只能由本地用户确认，Agent 不得伪造人工通过。

## 改动门禁

修改以下路径时必须带回归测试和维护者 Review：

- controller、worker、eval runner；
- GitOps、worktree、refs、checkpoint；
- shell gate、路径 guard、secret 扫描；
- state、lock、operation、approval、decision；
- Goal Spec schema、canonical hash、Execution Plan；
- Accept、Revise、Abandon 和 supplemental verification。

最低验证：

```bash
node --test "plugins/voidtech-loop/tests/**/*.test.mjs"
node scripts/run-quality.mjs --tier contract
```

Loop 当前试点平台为 macOS arm64；CI 必须在同架构 runner 上运行行为测试。
