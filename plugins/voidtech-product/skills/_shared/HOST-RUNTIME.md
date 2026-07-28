# Product Host Runtime

所有 Product Skill 共用这一处宿主接缝。业务流程、参数、退出码和产物不因宿主变化；只替换脚本的调用入口。

## 选择入口

- **OMP**：工具列表存在 `voidtech_product_runtime` 时，必须调用该工具。传入 `script` 与原 CLI 参数组成的 `args` 数组；不要通过 `bash` 拼接命令，也不要猜测 OMP 插件缓存路径。
- **Claude Code**：没有上述工具时，使用 `${CLAUDE_PLUGIN_ROOT}/skills/prd-from-requirements/scripts/<script>.py` 调用随插件分发的脚本；不要从仓库 checkout 或用户私有目录猜路径。
- 两个入口都不可用时停止机械步骤，明确报告缺失的宿主能力，不得伪装已经生成、同步或校验。

## 脚本映射

| `script` | Claude Code 脚本 | 覆盖能力 |
|---|---|---|
| `xlsx-to-markdown` | `xlsx-to-markdown.py` | 原始 Excel 转 Markdown |
| `check-prd-tree` | `check-prd-tree.py` | PRD 机械检查与读取栅栏 |
| `generate-dashboard` | `generate-dashboard.py` | Markdown/HTML Dashboard |
| `prd-sync` | `prd-sync.py` | migrate、sync、propose、confirm、recover、lifecycle、Logic Atlas |

## 退出码

OMP 工具在 `details.exitCode` 中原样返回脚本退出码，并把 stdout/stderr 放入同名字段；Claude Code 直接读取进程退出码。Skill 必须继续遵守各脚本已有语义，尤其不能把 `prd-sync` 的退出码 3/4 当成成功，也不能绕过人工裁决或读取栅栏。
