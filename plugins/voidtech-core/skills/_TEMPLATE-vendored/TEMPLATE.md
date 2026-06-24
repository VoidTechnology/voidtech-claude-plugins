---
name: vendored-skill-template
description: 【模板，勿启用】Tier 2 汉化第三方技能的目录结构与署名规范。复制本目录、改名、填好署名头后再用。
---

# 【这是模板，不是真实技能】

复制本目录为 `skills/<your-skill-name>/`，**把本文件改名为 `SKILL.md`**（TEMPLATE.md 不会被加载，SKILL.md 才会被发现），填好署名头，再放入汉化后的正文。
**只有许可证允许修改 + 再分发时才能 vendored 进来**（厂商专有工具如 figma/vercel 官方禁止 fork，改走"引用上游 + Tier 0 locale"）。

## 必填署名头（保留在汉化技能顶部）
> - **上游来源 (Upstream)**: <git repo / marketplace URL>
> - **许可证 (License)**: <MIT / Apache-2.0 / ...>（须允许修改+再分发；原 LICENSE 文件一并放入本目录）
> - **上游版本 (Version/commit)**: <vX.Y.Z 或 commit hash>
> - **汉化范围 (Changes)**: 仅翻译用户可见文案/输出模板；业务逻辑未改 / 或具体改动列表
> - **同步责任人 (Maintainer)**: <name>，上游更新时负责重新合并+重译

## 汉化正文
（把翻译后的技能内容放这里。保留原结构，只改面向用户的文案与模板。）
