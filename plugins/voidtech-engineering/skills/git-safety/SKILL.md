---
name: git-safety
description: 为 Claude Code 或 OMP 配置 Git 安全钩子，在危险 git 命令（push、reset --hard、clean、branch -D 等）执行前拦截。仅在用户明确要求安装或调整 Git 安全钩子时使用。
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 配置 Git 安全钩子

为当前宿主配置执行前钩子，拦截并阻止危险 Git 命令。只安装用户选择的作用范围，不默认写入全局配置。

## 会被拦截的命令

- `git push`（所有变体，包括 `--force`）
- `git reset --hard`
- `git clean -f` / `git clean -fd`
- `git branch -D`
- `git checkout .` / `git restore .`

命令被拦截时，agent 会收到一条消息，说明该操作不在授权范围内。

## 步骤

### 1. 询问作用范围

询问用户仅为**当前项目**安装，还是为**所有项目**安装。目标位置取决于宿主：

| 宿主 | 项目级 | 全局级 |
|---|---|---|
| Claude Code | `.claude/settings.json` + `.claude/hooks/` | `~/.claude/settings.json` + `~/.claude/hooks/` |
| OMP | `.omp/hooks/pre/block-dangerous-git.mjs` | `~/.omp/agent/hooks/pre/block-dangerous-git.mjs` |

### 2. 安装当前宿主的钩子

#### Claude Code

随附脚本位于 [scripts/block-dangerous-git.sh](scripts/block-dangerous-git.sh)。使用 `${CLAUDE_PLUGIN_ROOT}/skills/git-safety/scripts/block-dangerous-git.sh` 作为源路径，复制到所选范围的 `hooks/`，并执行 `chmod +x`。

把 command hook 合并进所选 `settings.json` 的 `hooks.PreToolUse` 数组，不得覆盖已有设置：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-dangerous-git.sh"
          }
        ]
      }
    ]
  }
}
```

全局级只把 command 改为 `"\"$HOME\"/.claude/hooks/block-dangerous-git.sh"`。

#### OMP

通过 `skill://git-safety/scripts/block-dangerous-git-omp.mjs` 读取随附的 OMP Extension Hook，并把内容原样写入用户选择的目标文件。不要从 OMP 插件缓存猜路径，不要修改插件安装目录。OMP 按约定自动发现 `hooks/pre/*.mjs`，无需额外 settings 项；新钩子从下次会话开始生效。

### 3. 询问是否定制

询问用户是否要添加或移除拦截模式；只编辑复制后的文件，不修改插件随附模板。

### 4. 验证

Claude Code 先确认 `jq` 可用，再用危险命令 fixture 验证退出码 2：

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | <path-to-script>
```

OMP 直接导入复制后的模块并验证危险命令被识别、只读命令被允许：

```bash
node --input-type=module -e "import { isDangerousGitCommand as blocked } from '<path-to-hook>'; if (!blocked('git push origin main') || blocked('git status')) process.exit(1)"
```

任一验证失败都视为未安装成功；修复后重跑，不把失败改成 warning。
