---
name: goal
description: 启动一次 voidtech-loop 工程内循环。给一个可机器判定的任务与一行验收命令，控制器在隔离 worktree 的专属分支上驱动受限 worker 逐轮工作，对指定 commit 执行 eval，全部通过产生 EVALS_PASSED 等待人工复核。仅在用户明确要求“开循环/跑 loop/让 agent 自主推进某个有明确验收命令的任务”时手动调用。
argument-hint: "\"<任务描述>\" --check \"<验收命令>\" --max-iterations N [--base <commit>] [--max-duration <秒>] [--spec <file.yaml>]"
disable-model-invocation: true
---

# goal — 启动工程内循环

把一个**完成条件可机器判定**的任务交给确定性控制器无人值守推进。控制器逐轮驱动受限 worker、生成 checkpoint、对指定 commit 跑 eval；eval 全部通过只产生 `EVALS_PASSED`，合入永远由人执行。

## 何时用 / 何时不用

- **用**：目标能落到一条命令的退出码上——修测试到 `npm test` 退出码 0、消 TS 错误到 `tsc --noEmit` 退出码 0、按契约测试实现接口。
- **不用**：完成条件靠产品 taste / 用户研究 / 主观判断（“让代码更好”）。这类任务先用 `/voidtech-loop:goal-spec` 破题，或根本不适合循环。

## 执行方式

1. 从用户输入解析任务描述与参数。**简单模式**（单一验收命令）直接构造：

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/loop goal "<任务>" --check "<命令>" --max-iterations <N>
   ```

   任务复杂（多 target、invariant、protected paths、自定义 cwd/env）时，先让用户走 `/voidtech-loop:goal-spec` 生成 spec，再用 `--spec <file>` 启动。

2. **不要替用户猜 `--max-iterations`**：它必须由用户显式给出。缺失时停下来问一次。
3. 用 Bash 运行上述脚本。脚本在**前台**完成启动体检（试点 OS、版本、Git、基线 eval）、获取项目锁、创建循环分支与 worktree 并写入初始状态，随后 detach 后台控制器、等其握手回执后返回：成功时直接输出 run ID，失败时输出具体失败阶段与原因（退出码非零）——失败不会假报“已启动”。
4. spec 含 `shell: true` 的 eval 或 `setup` 命令时，脚本会完整展示这些命令并以退出码 2 要求确认；把命令清单转达给用户，得到明确同意后再追加 `--allow-shell` 重新启动，不得替用户默认加上。
5. 把脚本输出的 run ID、循环分支和 `loop status` / `loop cancel` 提示原样转达给用户。**不要**声称任务已完成——完成与否由后续 eval 与人工 `accept` 决定。

## 边界

- 循环不自动 push、merge、建 PR 或改写用户分支。
- 运行期中断走 `${CLAUDE_PLUGIN_ROOT}/scripts/loop cancel <runId>`（幂等）；交互会话的 Ctrl+C 不影响已 detach 的守护进程。
- 查看进度：`${CLAUDE_PLUGIN_ROOT}/scripts/loop status [runId]`。
- `EVALS_PASSED` 后复核接受：`${CLAUDE_PLUGIN_ROOT}/scripts/loop accept <runId>`。
