# 核心技能逻辑闭环审计

## 审计口径

日期：2026-06-24  
范围：`voidtech-core` 发布的 20 个技能及其随附脚本、模板和参考文件。

判定为闭环必须同时满足：

1. 不要求安装上游技能、读取上游目录或调用未发布命令。
2. 跨技能调用只指向 `voidtech-core` 中实际发布的技能。
3. 声明要读取、复制或执行的静态资源随插件分发，并使用可移植路径定位。
4. 任务固有的外部系统先检查工具、认证和权限；不可用时有明确停止条件或可交付降级结果。
5. 不依赖 CDN、浮动脚本或未声明的远程运行时完成核心输出。
6. 有可验证的完成判据，不把缺失上下文伪装成成功。

第三方来源链接仅用于归属与维护，不属于运行时依赖。项目代码、Git 历史、用户指定的 issue 跟踪器和学习资料属于任务输入，不要求被复制进插件；技能必须说明这些输入缺失时如何处理。

## 逐技能结果

| 技能 | 闭环证据 | 结果 |
|---|---|---|
| `architecture-review` | 使用插件内 `codebase-design`、`plan-review-core`、`domain-modeling`；报告为离线 HTML/CSS/SVG；无 Agent 工具时本地探查 | 通过 |
| `codebase-design` | `DEEPENING.md`、`DESIGN-IT-TWICE.md` 均随包；无并行 Agent 时可顺序生成独立方案 | 通过 |
| `debug` | HITL 模板随包并通过 `${CLAUDE_PLUGIN_ROOT}` 定位；架构复盘指向插件内技能 | 通过 |
| `domain-modeling` | `CONTEXT-FORMAT.md` 与 `ADR-FORMAT.md` 随包；项目文件按需惰性创建 | 通过 |
| `fix-conflicts` | 以本地 Git 历史和冲突 hunk 为最低输入；PR/issue 不可访问时明确记录证据缺口 | 通过 |
| `git-safety` | hook 脚本随包并通过 `${CLAUDE_PLUGIN_ROOT}` 定位；安装前检查 `jq`；危险与安全命令均有行为测试 | 通过 |
| `handoff` | 明确跨平台临时目录、文件名、必备章节和回读验证；只推荐当前可发现技能 | 通过 |
| `implement` | TDD 指向插件内技能；评审清单内联；提交改为用户显式授权 | 通过 |
| `learn` | mission、glossary、resources、learning record 四类模板随包；无可靠来源时停止事实型课程并记录缺口 | 通过 |
| `plan-review-core` | 访谈循环与完成条件全部内联；作为仅模型调用的内部技能 | 通过 |
| `plan-review-docs` | 只编排插件内 `plan-review-core` 与 `domain-modeling` | 通过 |
| `plan-review` | 只编排插件内 `plan-review-core` | 通过 |
| `prepare-issue` | 使用插件内跟踪器适配契约、agent brief 与 out-of-scope 规则；无认证时明确降级 | 通过 |
| `prototype` | 逻辑与 UI 两个分支文档随包；只复用宿主项目已有运行时 | 通过 |
| `setup-git-checks` | 检测 Node 前提与包管理器；只执行本地依赖；保留既有配置；提交需显式授权 | 通过 |
| `tdd` | 测试、mock、重构参考随包；架构词汇指向插件内 `codebase-design` | 通过 |
| `text-naturalizer` | 中英文规则与 MIT 许可证随包，无外部文件读取 | 通过 |
| `to-issues` | 使用插件内跟踪器适配契约；认证不可用时交付完整 issue 草稿 | 通过 |
| `to-prd` | 使用插件内跟踪器适配契约；未确认 seam 标为 proposed；认证不可用时交付 PRD 草稿 | 通过 |
| `write-skills` | 术语表随包；调用可见性与当前 Claude Code 字段语义一致 | 通过 |

## 自动化约束

`scripts/check-portability.sh` 持续验证：

- 20 个技能目录名与 frontmatter 名称完全一致。
- 所有 `voidtech-core:<name>` 调用都指向已发布技能。
- 不出现已删除的上游命令或远程 CDN 运行时。
- Markdown 中代码块外的本地链接全部存在。
- 随附脚本通过 `${CLAUDE_PLUGIN_ROOT}` 定位。
- Git 防护脚本允许安全命令，拦截全部声明的危险命令，并对异常输入采用安全默认值。
- `text-naturalizer` 许可证随插件分发。
- 隔离安装后的实际插件缓存包含共享契约、许可证、HTML 模板和随附脚本，并保留脚本执行权限。
