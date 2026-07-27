---
name: release-plugin
description: 验证并显式触发单个 VoidTech 插件的 GitHub Release；不会自行决定或修改版本。
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash
---

# 发布插件

只在用户明确要求发布并给出插件名与目标版本时使用。不得自动决定版本、修改 manifest、push、重写 tag 或绕过失败门禁。

## 输入

必须有：

- 插件名：Marketplace 中七个插件之一；
- 版本：对应 `plugin.json` 已存在的精确 semver；
- 用户明确的发布意图。

缺任一项则停止，不猜测。

## 1. 本地预检

1. 读取 `AGENTS.md` 与 `docs/dev-rules/release-and-versioning.md`。
2. 确认当前工作区无未提交改动，当前发布内容已在 `main`；否则停止。
3. 验证选择：

```bash
node scripts/check-plugin-version-bumps.mjs --release <plugin> <version>
```

4. 确认 tag `<plugin>-v<version>` 尚不存在。

## 2. 质量门

```bash
node scripts/run-quality.mjs --all
node scripts/run-quality.mjs --tier install-smoke
```

任一步失败都停止，不发布。

## 3. 显式触发

向用户复述插件、版本、将创建的 tag 和已通过验证。用户的发布请求仍有效时，执行：

```bash
gh workflow run release-plugin.yml -f plugin=<plugin> -f version=<version> --ref main
```

然后观察该 workflow 到完成。不得直接运行 `gh release create`，不得用本地 tag 绕过工作流。

## 4. 完成证明

报告：

- workflow run URL；
- 被验证的 commit SHA；
- Release tag 与 URL；
- Marketplace 更新命令；
- 如失败，报告失败 job 和日志，不重试发布副作用。
