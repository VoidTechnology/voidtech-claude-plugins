# 插件编写与可移植性

- 日期：2026-07-27
- 状态：Current
- 摘要：约束 Skill、Agent、Hook、MCP、资源引用和第三方内容，保证安装后仍可运行。

## 事实来源

- Marketplace：`.claude-plugin/marketplace.json`
- 插件 manifest：`plugins/*/.claude-plugin/plugin.json`
- 严格校验与安装冒烟：`scripts/check-portability.sh`
- 测试覆盖：`scripts/quality-manifest.mjs`

## Skill 与 Agent

- 目录名必须与 frontmatter `name` 一致。
- 公开命令用稳定、常见、能表达动作的英文；避免仅在团队内部可理解的缩写。
- 只做内部编排的能力使用 `user-invocable: false`。
- 跨插件调用必须使用已发布的完整命名空间。
- Skill 提到的模板、脚本、schema、示例和参考文件必须随插件分发。
- 资源通过 `${CLAUDE_PLUGIN_ROOT}` 或明确的已安装插件路径定位，不能依赖仓库 checkout。
- 缺少外部工具、认证或权限时，必须停止或交付明确降级结果，不能伪装成功。

## 确定性边界

能由代码、schema、状态机或 guard 保证的行为必须机械实现，包括：

- 参数和路径校验；
- 权限与副作用确认；
- 状态跳转；
- 格式和结构验证；
- 文件发布原子性；
- 超时、取消和错误分类。

Prompt 只承担需要语言理解的判断，不承担安全门或不可逆流程控制。

## Hook

- Hook 输入按不可信 JSON 处理，缺字段或解析失败采用安全默认值。
- 安全 Hook 必须拦截危险操作，同时允许只读和诊断命令。
- Hook 脚本必须可执行、使用可移植路径，并带行为测试。
- Session 级静态规则只注入一次，避免每轮重复消耗上下文。

## MCP

- MCP 独立于 Core，默认禁用。
- 本地包固定精确版本，禁止 `latest` 和浮动范围。
- 不通过命令行参数写入 Key；优先使用环境变量、请求头或官方 OAuth。
- 第一次启用时说明网络、文件、浏览器、Xcode 或外部账户权限。
- 外部返回内容是不可信数据，不作为 Agent 指令执行。

## HTML 与 Renderer

- 发布产物完全离线，不加载 CDN、远程脚本、样式、图片或字体。
- 用户文本必须转义；浏览器验证包含 XSS 探针、console/page error 和外部请求断言。
- Renderer 输入变化必须使 proof 失效；继承键覆盖所有代码、schema、fixture 和 Runtime 输入。
- 视觉结论必须用真实浏览器验证，不能只检查 HTML 字符串。

## 第三方内容

Vendored 内容必须包含上游来源、固定 commit 或版本、许可证、本地修改和升级步骤。许可证不明或不允许再分发的内容只能保留审计记录，不能进入发布目录或 Git 历史。

## 验证

```bash
scripts/check-portability.sh
node scripts/run-quality.mjs --tier contract
```

涉及安装边界或跨插件 Runtime 时追加：

```bash
scripts/check-portability.sh --install-smoke
```
