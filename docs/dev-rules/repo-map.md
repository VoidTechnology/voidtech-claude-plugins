# 仓库地图

- 日期：2026-07-27
- 状态：Current
- 摘要：说明代码、规则、测试和发布资产的归属，避免新增能力落错模块。

## 顶层结构

| 路径 | 责任 |
|---|---|
| `.claude-plugin/marketplace.json` | Marketplace 发布插件集合的唯一事实源 |
| `.claude/` | 只服务本仓维护者的 Skill 与 Agent，不随 Marketplace 分发 |
| `.github/` | Issue、PR、CODEOWNERS、CI 和显式发布工作流 |
| `plugins/` | 七个可安装插件及其全部运行时资源 |
| `scripts/` | 仓库级验证、安装冒烟、测试调度和 Renderer 浏览器 harness |
| `templates/` | 下游项目可复制的 Claude Code 配置样板 |
| `docs/` | 用法、ADR、设计与历史审计；`docs/dev-rules/` 是维护规则 |
| `archive/` | 不发布的历史或许可证不允许分发的内容；禁止回流发布区 |

## 插件归属

| 插件 | 责任 | 主要风险 |
|---|---|---|
| `voidtech-core` | 中文约定、跨领域公共 Skill、共享 Archify Runtime | SessionStart Hook、跨插件 Runtime |
| `voidtech-product` | PRD 生成、同步、维护、Logic Atlas | schema、持久化、Renderer、跨插件 Runtime |
| `voidtech-design` | 标准 DESIGN.md、设计 brief、一次性 UI 原型 | 产品事实与设计推导边界；原型与生产实现边界 |
| `voidtech-engineering` | 架构、实现、调试、测试、Git、Issue、发布 Skill | Git 副作用、Shell、发布权限 |
| `voidtech-loop` | Goal Spec、确定性控制器、隔离 worktree、指定 commit eval | 命令执行、Git refs、权限、状态完整性 |
| `voidtech-mcp-common` | Context7、Chrome DevTools | 网络、浏览器、外部服务权限 |
| `voidtech-mcp-apple` | Apple Docs、XcodeBuildMCP | 本机 Xcode 与外部工具权限 |

## 能力归属规则

- 多个领域共同使用、无需领域上下文的工作方法进入 Core。
- 产品、设计、工程特有流程进入对应领域插件。
- 只有完成条件能被命令退出码或 schema 判定的无人值守循环进入 Loop。
- 外部服务连接进入独立 MCP 插件，不得捆绑进 Core。
- 只维护本仓库的工具进入根 `.claude/`，不增加用户命令面。

## 测试位置

- Loop：`plugins/voidtech-loop/tests/**/*.test.mjs`
- Product：`plugins/voidtech-product/skills/prd-from-requirements/tests/test_*.py`
- 仓库契约：`scripts/__tests__/*.test.mjs`
- Renderer：`scripts/validate-renderer.mjs` + 已提交 proof
- 更新 Hook：`scripts/test-update-check.sh`

新增插件或测试文件必须登记到 `scripts/quality-manifest.mjs`，未登记视为错误。
