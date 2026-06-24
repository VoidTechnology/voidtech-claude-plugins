---
name: git-guardrails-claude-code
description: 配置 Claude Code 钩子，在危险 git 命令（push、reset --hard、clean、branch -D 等）执行前将其拦截。当用户希望阻止破坏性 git 操作、添加 git 安全钩子，或在 Claude Code 中拦截 git push/reset 时使用。
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 配置 Git 防护栏

配置一个 PreToolUse 钩子，在 Claude 执行危险 git 命令之前将其拦截并阻止。

## 会被拦截的命令

- `git push`（所有变体，包括 `--force`）
- `git reset --hard`
- `git clean -f` / `git clean -fd`
- `git branch -D`
- `git checkout .` / `git restore .`

被拦截时，Claude 会看到一条消息，告知它无权访问这些命令。

## 步骤

### 1. 询问作用范围

询问用户：仅为 **当前项目** 安装（`.claude/settings.json`），还是为 **所有项目** 安装（`~/.claude/settings.json`）？

### 2. 复制钩子脚本

随附的脚本位于：[scripts/block-dangerous-git.sh](scripts/block-dangerous-git.sh)

根据作用范围将其复制到目标位置：

- **项目级**：`.claude/hooks/block-dangerous-git.sh`
- **全局级**：`~/.claude/hooks/block-dangerous-git.sh`

用 `chmod +x` 赋予其可执行权限。

### 3. 将钩子添加到 settings

添加到相应的 settings 文件：

**项目级**（`.claude/settings.json`）：

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

**全局级**（`~/.claude/settings.json`）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/block-dangerous-git.sh"
          }
        ]
      }
    ]
  }
}
```

如果 settings 文件已存在，将钩子合并进现有的 `hooks.PreToolUse` 数组——不要覆盖其他设置。

### 4. 询问是否定制

询问用户是否想从拦截列表中添加或移除某些模式。据此编辑复制后的脚本。

### 5. 验证

运行一个快速测试：

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | <path-to-script>
```

应当以退出码 2 退出，并在 stderr 打印一条 BLOCKED 消息。
