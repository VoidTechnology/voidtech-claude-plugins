# 第三方能力 Triage

第三方内容进入 Marketplace 前，必须同时通过来源、许可证、运行时依赖和维护成本审查。

## 处置规则

1. 厂商官方插件或 OAuth 服务：引用上游，不 fork。
2. 无明确许可证：不发布；只能归档或独立重写。
3. 允许再分发但依赖完整上游运行时：先归档，完成自包含重写后再发布。
4. 本地执行的 MCP 包必须固定精确版本；远端 MCP 必须使用 HTTPS。
5. 密钥只通过环境变量、请求头、OAuth 或 Claude 安全配置传递，不写入仓库或命令行参数。

## 当前发布内容

| 能力 | 来源 | 处置 |
|---|---|---|
| matt-pocock/skills | MIT © 2026 Matt Pocock | 汉化后 vendored 到 `voidtech-core`，保留许可证与逐技能署名 |
| text-naturalizer | VoidTech 原创 | 发布到 `voidtech-core` |
| Context7 | Upstash 官方远端 MCP | 放入默认禁用的 `voidtech-mcp-common`，API key 走请求头 |
| Chrome DevTools MCP | ChromeDevTools 官方仓库，Apache-2.0 | `chrome-devtools-mcp@1.4.0`，默认关闭使用统计与 CrUX URL 查询 |
| Apple Docs MCP | MIT | `@kimsungwhee/apple-docs-mcp@1.0.26`，放入 Apple 插件 |
| XcodeBuildMCP | MIT | `xcodebuildmcp@2.6.2`，放入 Apple 插件 |
| archify | MIT © tt-a1i(fork 自 Cocoon-AI architecture-diagram-generator) | v2.12.0 @ eb847fa vendored 到 `voidtech-core` prd-from-requirements,零 npm 运行时依赖,保留 LICENSE 与署名;裁剪与升级见 `vendor/archify/VENDOR.md` |

## 不随 Marketplace 发布

| 能力 | 原因 | 处置 |
|---|---|---|
| 8 个 gstack 技能 | 依赖缺失的 `~/.gstack`、`gstack/bin`、遥测与已删除技能 | 未纳入仓库；如需重写，从上游 gstack 重新获取后逐个独立适配 |
| karpathy-guidelines | 上游 `multica-ai/andrej-karpathy-skills` 没有 LICENSE | 未纳入仓库（无再分发许可） |
| GitHub npm MCP | `@modelcontextprotocol/server-github` 已废弃 | 团队默认使用 `gh`；需要 MCP 时使用 GitHub 官方实现 |
| Figma Context MCP | 第三方实现且厂商已有官方插件 | 使用 Figma 官方插件与 OAuth |
| Desktop Commander | 权限面过大，核心能力已有文件与命令工具 | 不分发 |
| Fetch MCP | 与 Claude Code 内置抓取能力重复，并增加 Python/uv 依赖 | 不分发 |

Apple Docs MCP `1.0.26` 当前包含已弃用的传递依赖 `whatwg-encoding@3.1.1`，`npm audit` 未发现漏洞；升级版本时继续复查。

## gstack 重新进入发布区的门槛

- 删除遥测、自动升级、安装器和 `~/.gstack` 状态协议。
- 不引用未发布技能。
- `SKILL.md` 不超过 500 行，细节拆到同目录参考文件。
- 发布、提交、合并、部署技能设置 `disable-model-invocation: true`。
- 记录上游 commit、汉化范围和 MIT 许可证。
- 通过 `scripts/check-portability.sh --install-smoke`。
