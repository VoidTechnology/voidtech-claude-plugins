# 不予实现的需求记录

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

仓库中的 `.out-of-scope/` 目录存放被拒绝功能请求的持久记录。它有两个用途：

1. **保留团队决策** —— 记录某项功能为何被拒绝，避免 issue 关闭后丢失理由
2. **避免重复讨论** —— 新 issue 与既往拒绝相似时，先提示已有决策

## 目录结构

```
.out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

一个**概念**一个文件，而非一个 issue 一个文件。请求同一件事的多个 issue 归在一个文件下。

## 文件格式

文件应清楚、易读，形式接近简短的设计文档，而不是数据库记录。用段落和必要示例解释理由，确保第一次接触该决策的人也能理解。

```markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in
`ThemeConfig`. Supporting multiple themes would require:

- A theme context provider wrapping the entire component tree
- Per-component theme-aware style resolution
- A persistence layer for user theme preferences

This is a significant architectural change that doesn't align with the
project's focus on content authoring. Theming is a concern for downstream
consumers who embed or redistribute the output.

```ts
// The current ThemeConfig interface is not designed for runtime switching:
interface ThemeConfig {
  colors: ColorPalette; // single palette, resolved at build time
  fonts: FontStack;
}
```

## Prior requests

- #42 — "Add dark mode support"
- #87 — "Night theme for accessibility"
- #134 — "Dark theme option"
```

### 给文件命名

为概念使用一个简短、描述性的 kebab-case 名称：`dark-mode.md`、`plugin-system.md`、`graphql-api.md`。这个名字应当足够可辨识，让浏览目录的人不打开文件也能理解被拒绝的是什么。

### 写好理由

理由应当言之有物——不是“我们不想要这个”，而是为什么。好的理由会引用：

- 项目范围或哲学（"This project focuses on X; theming is a downstream concern"）
- 技术约束（"Supporting this would require Y, which conflicts with our Z architecture"）
- 战略决策（"We chose to use A instead of B because..."）

理由应长期有效。不要使用“我们现在太忙了”等临时原因；这类情况属于延期，而不是明确拒绝。

## 何时检查 `.out-of-scope/`

整理 issue 时，在步骤 1“收集上下文”中阅读 `.out-of-scope/` 下的所有文件。评估新 issue 时：

- 检查该请求是否匹配某个既有的 out-of-scope 概念
- 匹配按概念相似度，而非关键字——"night theme" 匹配 `dark-mode.md`
- 若有匹配，向维护者提示已有记录："This is similar to `.out-of-scope/dark-mode.md` — we rejected this before because [reason]. Do you still feel the same way?"

维护者可以：

- **确认** —— 新 issue 被追加到既有文件的 "Prior requests" 列表，然后关闭
- **重新考虑** —— 删除或更新 out-of-scope 文件，issue 进入正常整理流程
- **不同意** —— 两个 issue 相关但不相同，按正常整理流程处理

## 何时写入 `.out-of-scope/`

仅当一个 **enhancement**（不是 bug）被*拒绝*为 `wontfix` 时。这条规则对 enhancement PR 与对 issue 完全一样适用——一个被拒绝的 PR 会被记录在此，以免同一请求又作为新代码回来。

当某个请求因为**已实现**而被关闭为 `wontfix` 时，**不要**写入这里。那是一个已经存在的功能，不是被拒绝的需求；记录它会用虚假的拒绝污染去重检查。关闭评论应指向该功能已经存在的位置。

流程：

1. 维护者判定某个功能请求超出范围
2. 检查是否已存在匹配的 `.out-of-scope/` 文件
3. 若有：把新 issue 追加到 "Prior requests" 列表
4. 若无：用概念名、决策、理由和第一条 prior request 创建一个新文件
5. 在 issue 上发布一条评论，解释该决策并提及 `.out-of-scope/` 文件
6. 用 `wontfix` 标签关闭该 issue

## 更新或移除 out-of-scope 文件

如果维护者改变了对先前被拒绝概念的看法：

- 删除该 `.out-of-scope/` 文件
- 技能无需重新打开旧 issue——它们是历史记录
- 触发本次重新考虑的新 issue 进入正常整理流程
