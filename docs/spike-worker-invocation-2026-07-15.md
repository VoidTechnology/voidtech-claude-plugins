# Spike 报告：voidtech-loop worker invocation 运行时验证

- **日期**：2026-07-15
- **状态**：Final
- **摘要**：对 PRD §8.1 的五项实测清单在本机（macOS arm64，Claude Code 2.1.210）逐项验证，结论 **GO**：非 bare `claude -p` 满足确定性控制器驱动有界 worker 的全部前置条件——凭据复用、项目级 hooks/权限在 headless 下生效且可硬 deny、信号语义可区分、连续 10 轮稳定。Agent SDK（0.3.210，可钉版本）保留为备选路径，一期不需要。第二轮（§8.11 宿主模型与 §8.1 会话连续性）同样 **GO**：detach 守护进程模型可行，`--resume` 可用但定案为每轮全新调用。

## 1. 结论

| # | 验证项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 凭据复用 | ✅ 通过 | 环境无 `ANTHROPIC_API_KEY`，非 bare `claude -p` 直接复用本机登录凭据（OAuth/keychain），单次调用 17s 退出码 0 |
| 2 | 项目 hooks 在 headless 生效 | ✅ 通过 | 项目 `.claude/settings.json` 的 PreToolUse hook 在 `claude -p` 下触发，marker 文件记录到被检查命令 |
| 3 | PreToolUse 硬拦截（deny） | ✅ 通过 | hook `exit 2` 成功阻止 `git add && git commit`，仓库零提交，worker 收到拦截反馈并停止尝试 → PRD 5.4 拦截层成立 |
| 4 | 信号语义 | ✅ 通过 | SIGTERM → 退出码 143；SIGINT → 退出码 0；两者均无孤儿子进程残留 |
| 5 | 连续 10 轮有界调用 | ✅ 通过 | 10/10 成功，单轮 10–20s，无速率限制、无退化 |
| 6 | headless 默认权限 | ✅ 通过 | 未授予 `--allowedTools` 时 Write 被自动拒绝（default-deny），文件未创建 |

## 2. 定案建议（回填 PRD §8.1 / §8.10）

- **worker invocation 选型**：非 bare `claude -p` + `--allowedTools` 白名单 + 项目级 PreToolUse hooks。不使用 `--bare`（跳过 hooks/plugins 且不读 OAuth/keychain，文档确认）。不使用 `/goal`（evaluator 为模型判定且不执行命令，文档确认）。
- **Agent SDK**：`@anthropic-ai/claude-agent-sdk` 0.3.210 存在且可钉版本，作为文档化备选；`claude -p` 全项通过，一期不引入该依赖。
- **版本下限候选**：2.1.210（本次实测版本）。

## 3. 实现笔记（进技术设计）

- **stdin**：headless 调用必须显式 `< /dev/null`，否则 CLI 等待 stdin 3 秒并打印警告。
- **终止信号用 SIGTERM**：SIGINT 退出码为 0，与正常完成不可区分；控制器终止 worker 必须用 SIGTERM（退出码 143 可判定）。
- **启动开销**：每次 invocation 约 10–13s 固定开销；25 轮循环仅启动开销约 4–8 分钟，可接受，但 worker prompt 应鼓励单轮完成一个完整差距，避免碎轮次。
- **后台任务等待上限**：v2.1.182+ 后台任务等待默认上限 10 分钟（文档确认，未实测）；控制器已有单轮超时兜底,worker prompt 应禁止派生后台任务。

## 4. 测试方法

所有测试在隔离 scratchpad 目录执行，避免继承仓库配置：

```bash
# 1/2/3: hooks 与 deny（项目 .claude/settings.json，PreToolUse matcher=Bash）
#   hook 记录命令到 marker 文件；命中 git add/commit/push 时 exit 2
claude -p "Run: git add file.txt && git commit -m test" --allowedTools "Bash" --max-turns 4

# 4: 信号
claude -p "<long bash task>" --allowedTools "Bash" & kill -TERM $!  # => 143
claude -p "<long bash task>" --allowedTools "Bash" & kill -INT $!   # => 0

# 5: 连续调用
for i in $(seq 1 10); do claude -p "Reply with exactly: ROUND-$i" --max-turns 1; done

# 6: 默认权限
claude -p "Create a file ... using the Write tool" --max-turns 2  # => WRITE-DENIED
```

## 5. 第二轮：控制器宿主与会话连续性

| # | 验证项 | 结果 | 证据 |
|---|--------|------|------|
| 7 | detach 守护进程调用 `claude -p` | ✅ 通过 | `nohup + disown` 后启动 shell 退出，进程被 launchd 收养（ppid=1）、无 TTY，两次 `claude -p` 均成功返回——凭据在完全脱离宿主会话后仍可用 |
| 8 | 信号送达 detach 进程 | ✅ 通过 | 经记录的 PID 发 SIGTERM，bash trap 触发并干净退出——`cancel` 经锁文件 PID 发信号的路径成立 |
| 9 | `--resume` 会话连续性 | ✅ 通过 | `--output-format json` 返回 `session_id`；`--resume <sid>` 正确回出上一次会话的 codeword；缓存命中使续会话更便宜（$0.045 vs 首次 $0.51）且更快（7.3s vs 14.8s） |

**定案**：

- **宿主模型（§8.11）**：detach 守护进程。`goal` 完成启动体检后派生脱离会话的控制器并立即返回；宿主会话关闭不影响循环。设计后果：交互会话 Ctrl+C 不达守护进程，运行期中断统一走 `cancel`（SIGTERM → 锁文件 PID）。
- **会话连续性（§8.1）**：每轮全新 `claude -p` 为默认——有界、无跨轮上下文污染，且 25 轮持续 `--resume` 会让上下文单调增长直至压缩/溢出。`--resume` 记录为二期优化选项，凭一期资源画像数据再议。
- **成本数据点**：空仓库试验轮单次 $0.05–0.51、7–17s；真实 worker 轮次成本待资源画像。

## 6. 遗留项（不阻塞）

- 后台任务 10 分钟上限的实际行为未实测（依赖构造长时后台任务，成本高收益低；有单轮超时兜底）。
- 本次在嵌套会话（Claude Code 内调用 `claude -p`）下测试；正式实现后应在干净终端复跑一遍测试 4/5 作确认。
- SIGKILL 路径未测（PRD 5.1 已按「无法收尾、下次启动终态化」设计，不依赖收尾行为）。
