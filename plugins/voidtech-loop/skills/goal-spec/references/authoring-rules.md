# Goal Spec 作者规则

本文件解释 `schemas/goal-spec.schema.json` 的字段语义。字段的硬规则以 schema 与 `scripts/goal-spec validate` 为唯一权威；本文件只做人类可读的说明，不复制、不放宽校验。

## 顶层字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `schema_version` | 是 | 固定为 `1` |
| `goal_id` | 是 | kebab-case，≤64 字符 |
| `task` | 是 | 一句话任务描述 |
| `base_commit` | 是 | 7–40 位十六进制 commit；启动时若未显式 `--base` 则取当前 HEAD |
| `budgets.max_iterations` | 是 | 1–200，必须由用户显式给出 |
| `budgets.max_duration_seconds` | 否 | 60–86400，缺省规范化为 3600 |
| `setup` | 否 | warm 安装命令 argv 数组（如 `[npm, ci]`）；进入 goal_hash |
| `protected_paths` | 否 | gitignore 语法（按 `git check-ignore` 语义匹配）；不支持 `!` 否定模式 |
| `evals` | 是 | 至少一个，且至少一个 `role: target` |
| `manual_review` | 否 | 人工复核项，进报告不进 eval |
| `out_of_scope` | 否 | 明确不做项 |

## eval 条目

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | kebab-case 稳定标识 |
| `role` | 是 | `target` 或 `invariant` |
| `command` | 是 | 默认 argv 数组（不经 shell）；数字/布尔参数必须加引号成字符串 |
| `shell` | 否 | 声明为 `true` 时 `command` 必须是单个字符串，启动时需显式确认 |
| `cwd` | 否 | 相对仓库根；不允许绝对路径或 `..` 逃逸；缺省为 `.` |
| `expected_exit` | 否 | 0–255，缺省 0 |
| `timeout_seconds` | 是 | 1–7200 |
| `repeat` | 否 | 1–10，缺省 1 |

## 角色语义

- **target**：本轮必须达成的变化。只支持绝对判定（命令退出码 == `expected_exit`）。一期不支持“candidate 优于 baseline”类相对比较器——validator 会拒绝，相对指标归入 `out_of_scope`。
- **invariant**：不得退化的守护条件，且必须在 base commit 上已经成立。基线不成立的条件必须改为 target 或先修复基线。
- `EVALS_PASSED` 要求所有 target 与 invariant 在 candidate commit 上同时成立。

## 基线裁定

| 情形 | 结论 |
|------|------|
| 至少一个 target 未满足 且 全部 invariant 成立 | 可启动 |
| 全部 target 在基线已满足 | 拒绝：目标已达成，直接检查现状 |
| 任一 invariant 在基线不成立 | 拒绝：改角色或先修基线 |
| 任一 eval 超时 | 拒绝：不得交付可启动结论 |

## 安全默认（简单模式与 goal-spec 补齐）

- 网络与外部服务：一期不开放；需要则不属于一期范围。
- 单 eval 超时 600s，总时限 3600s。
- secret 只允许引用环境变量名；spec 中出现疑似凭据字面量会被拒绝。
