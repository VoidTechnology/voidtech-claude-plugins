---
name: setup-pre-commit
description: 在当前仓库中配置 Husky 预提交钩子，搭配 lint-staged（Prettier）、类型检查与测试。当用户希望添加预提交钩子、配置 Husky、设置 lint-staged，或加入提交时的格式化/类型检查/测试时使用。
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 配置预提交钩子

## 本技能会配置什么

- **Husky** 预提交钩子
- **lint-staged** 对所有暂存文件运行 Prettier
- **Prettier** 配置（如缺失）
- 预提交钩子中的 **typecheck** 与 **test** 脚本

## 步骤

### 1. 检测包管理器

检查 `package-lock.json`（npm）、`pnpm-lock.yaml`（pnpm）、`yarn.lock`（yarn）、`bun.lockb`（bun）。使用存在的那个。无法确定时默认 npm。

### 2. 安装依赖

作为 devDependencies 安装：

```
husky lint-staged prettier
```

### 3. 初始化 Husky

```bash
npx husky init
```

这会创建 `.husky/` 目录，并将 `prepare: "husky"` 添加到 package.json。

### 4. 创建 `.husky/pre-commit`

写入这个文件（Husky v9+ 无需 shebang）：

```
npx lint-staged
npm run typecheck
npm run test
```

**适配**：将 `npm` 替换为检测到的包管理器。如果仓库的 package.json 中没有 `typecheck` 或 `test` 脚本，省略相应行并告知用户。

### 5. 创建 `.lintstagedrc`

```json
{
  "*": "prettier --ignore-unknown --write"
}
```

### 6. 创建 `.prettierrc`（如缺失）

仅在没有任何 Prettier 配置时创建。使用以下默认值：

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
- [ ] 运行 `npx lint-staged` 验证其可正常工作

### 8. 提交

暂存所有改动/新建的文件，并以此消息提交：`Add pre-commit hooks (husky + lint-staged + prettier)`

这会跑一遍新的预提交钩子——是一次很好的冒烟测试，验证一切正常。

## 备注

- Husky v9+ 的钩子文件不需要 shebang
- `prettier --ignore-unknown` 会跳过 Prettier 无法解析的文件（图片等）
- 预提交先运行 lint-staged（快，仅针对暂存文件），再运行完整的 typecheck 与测试
