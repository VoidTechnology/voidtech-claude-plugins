# 可移植性审计

## 审计基线

- 日期：2026-06-24
- Claude Code：2.1.187
- 本地平台：macOS arm64
- 目标最低版本：Claude Code 2.1.154
- 规范来源：[Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)、[Skills](https://code.claude.com/docs/en/skills.md)、[Hooks](https://code.claude.com/docs/en/hooks.md)、[MCP](https://code.claude.com/docs/en/mcp.md)

## 初始结论

原仓库可以通过 manifest 严格校验并完成本地 Marketplace 安装，但不能作为稳定团队发行版：被发现不等于可运行，插件边界也没有表达平台、权限和依赖差异。

## 初始发现

| 级别 | 发现 | 处理结果 |
|---|---|---|
| 阻塞 | 8 个 gstack 技能共 11,274 行，依赖未分发运行时 | 已从仓库移除 |
| 阻塞 | 发布、合并、部署技能可被模型自动触发 | 已随 gstack 技能退出发布区；重写时必须仅允许手动调用 |
| 阻塞 | GitHub npm MCP 已废弃 | 已移除，默认使用 `gh` |
| 阻塞 | 所有本地 MCP 使用浮动版本 | 保留的三个本地 MCP 已锁定精确版本 |
| 阻塞 | `karpathy-guidelines` 的 MIT 声明无法从上游证明 | 正文已从工作树删除，只保留审计记录 |
| 高 | 核心插件默认启动 8 个 MCP | 已拆成两个默认禁用的可选插件 |
| 高 | Context7 与 Figma 密钥通过命令行参数传递 | Context7 改用 HTTPS 请求头；Figma 改用官方 OAuth 插件 |
| 高 | Figma 第三方 MCP 与既有处置规则冲突 | 已移除 |
| 高 | 中文 hook 每轮注入静态规则 | 已改为 `SessionStart` 注入一次 |
| 高 | 没有自动化质量门 | 已增加可移植性脚本与 GitHub Actions |
| 中 | README、上手指南和实际结构漂移 | 已同步更新 |

## 已验证

- Marketplace 与三个插件均通过 `claude plugin validate --strict`。
- `voidtech-core` 不包含 MCP，发布技能不引用 gstack 外部运行时。
- `voidtech-core` 恰好发布约定的 20 个技能命令；目录名、frontmatter 展示名和内部引用已经同步。
- 内部编排技能 `plan-review-core` 不在用户命令菜单中展示，但仍可由模型调用。
- 20 个核心技能已逐项完成逻辑闭环审计；本地引用、跨技能调用、随附脚本定位和许可证由自动检查约束。
- 20 个核心技能及其参考文件已完成中文可读性审查；已淘汰的生硬译法由自动检查约束。
- issue 跟踪器等任务固有的外部系统均先做适配器与认证检查，无法写入时交付完整草稿，不依赖上游初始化技能。
- 架构审查 HTML 不加载 CDN 或其他远程运行时。
- 发布区所有 `SKILL.md` 均不超过 500 行。
- 本地 MCP 包均固定精确版本。
- Chrome DevTools MCP 默认关闭使用统计与 CrUX URL 查询。
- 常见密钥格式扫描未发现明文。
- 隔离配置目录可以添加 Marketplace 并安装全部三个插件。
- Context7 在不提供 API key 时完成 MCP `initialize` 握手并返回 HTTP 200；匿名模式可建立连接。

## 尚需真实环境验证

- 使用有效 `CONTEXT7_API_KEY` 验证请求计入团队账户，而不是匿名限额。
- 在团队最低 Node.js 版本上连接 Chrome DevTools MCP。
- 在至少一台干净 macOS 开发机上连接 Apple Docs 与 XcodeBuildMCP，并执行一次只读 Xcode 查询。
- 仓库发布到真实 GitHub 地址后，从远端而非本地路径完成安装与更新验证。

这些检查需要真实凭据、浏览器或 Xcode 环境，不放进无密钥 CI。

Apple Docs MCP `1.0.26` 的传递依赖 `whatwg-encoding@3.1.1` 已弃用，但当前 `npm audit --audit-level=high` 结果为 0 个漏洞；此项不阻塞发布，但升级时必须复查。

## 已完成合规处理

仓库已从完成审计的干净工作树重新初始化，当前历史起点为根提交 `29d8d37`，不继承曾包含无许可证 `karpathy-guidelines` 原文的旧历史。旧 `.git` 仅保存在仓库外的本机临时备份中，不属于交付内容。
