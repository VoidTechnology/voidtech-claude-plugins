# voidtech-mcp-common

默认禁用的通用 MCP 插件。

## 前置条件

- Claude Code 2.1.154 或更高版本
- Node.js `^20.19.0 || ^22.12.0 || >=23`
- 可选环境变量 `CONTEXT7_API_KEY`

Context7 使用官方远端 HTTP 服务，密钥通过请求头传递；Chrome DevTools MCP 固定为 `1.4.0`，并默认关闭使用统计与 CrUX URL 查询。
