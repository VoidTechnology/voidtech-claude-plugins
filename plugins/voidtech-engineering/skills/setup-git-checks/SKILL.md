---
name: setup-git-checks
description: 在当前仓库中配置 Husky 预提交钩子，搭配 lint-staged（Prettier）、类型检查与测试。当用户希望添加预提交钩子、配置 Husky、设置 lint-staged，或加入提交时的格式化/类型检查/测试时使用。
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 配置预提交钩子

## 本技能会配置什么

- **Husky** 预提交钩子
- **lint-staged** 对所有暂存文件运行 Prettier
- **Prettier** 配置（如缺失）
- 预提交钩子中的 **typecheck** 与 **test** 脚本

## 步骤

### 1. 检测包管理器

先确认仓库根目录存在 `package.json`；不存在就停止，并说明本技能只适用于 Node.js 项目，不要擅自引入 Node 工具链。

优先读取 `package.json` 的 `packageManager` 字段；否则检查 `package-lock.json`（npm）、`pnpm-lock.yaml`（pnpm）、`yarn.lock`（yarn）、`bun.lock` 或 `bun.lockb`（bun）。多个信号冲突时询问用户，只有完全没有信号时才默认 npm。

### 2. 安装依赖

若依赖尚未存在，使用选定的包管理器安装 `husky`、`lint-staged` 与 `prettier`。沿用 lockfile 解析出的版本，不安装全局命令：

| 包管理器 | 安装 | 执行本地二进制 | 运行脚本 |
|---|---|---|---|
| npm | `npm install --save-dev husky lint-staged prettier` | `npx --no-install` | `npm run` |
| pnpm | `pnpm add --save-dev husky lint-staged prettier` | `pnpm exec` | `pnpm run` |
| yarn | `yarn add --dev husky lint-staged prettier` | `yarn exec` | `yarn` |
| bun | `bun add --dev husky lint-staged prettier` | `bunx --bun` | `bun run` |

### 3. 初始化 Husky

使用上表的“执行本地二进制”命令运行 `husky init`。例如 npm 项目使用：

```bash
npx --no-install husky init
```

这会创建 `.husky/` 目录，并将 `prepare: "husky"` 添加到 `package.json`。若仓库已有 Husky 配置，先读取并在原结构上修改，不要重复初始化。

### 4. 创建 `.husky/pre-commit`

在这个文件中加入以下三类命令（Husky v9+ 无需 shebang），把占位符替换为上表对应命令：

```
<local-exec> lint-staged
<run-script> typecheck
<run-script> test
```

如果仓库已有 `.husky/pre-commit`，保留原有检查并合并缺失命令，不得覆盖。若 `package.json` 没有 `typecheck` 或 `test` 脚本，省略相应行并告知用户；不要凭空创建无法工作的脚本。

### 5. 配置 lint-staged

若项目已有任何 lint-staged 配置，保留其格式和规则，只确认它能覆盖需要格式化的文件。只有完全缺失时才创建 `.lintstagedrc`：

```json
{
  "*": "prettier --ignore-unknown --write"
}
```

### 6. 创建 `.prettierrc`（如缺失）

仅在没有任何 Prettier 配置时创建。已有配置保持不变。使用以下默认值：

```json
{
  "useTabs": false,
  "tabWidth": 2,
  "printWidth": 80,
  "singleQuote": false,
  "trailingComma": "es5",
  "semi": true,
  "arrowParens": "always"
}
```

### 7. 验证

- [ ] `.husky/pre-commit` 存在且可执行
- [ ] `.lintstagedrc` 存在
- [ ] package.json 中的 `prepare` 脚本为 `"husky"`
- [ ] `prettier` 配置存在
- [ ] 使用选定包管理器执行本地 `lint-staged`，验证配置可以加载
- [ ] 手动运行 `.husky/pre-commit`，确认存在的 typecheck 与 test 脚本通过

验证失败时修复根因；不得为了通过验证而删除既有检查。

### 8. 交付

列出新增或修改的文件、实际选择的包管理器和验证命令。只有用户明确要求提交时才暂存并提交；否则保留未提交改动。

## 备注

- Husky v9+ 的钩子文件不需要 shebang
- `prettier --ignore-unknown` 会跳过 Prettier 无法解析的文件（图片等）
- 预提交先运行 lint-staged（快，仅针对暂存文件），再运行完整的 typecheck 与测试
