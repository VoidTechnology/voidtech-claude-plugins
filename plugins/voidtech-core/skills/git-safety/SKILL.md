---
name: git-safety
description: 配置 Claude Code 钩子，在危险 git 命令（push、reset --hard、clean、branch -D 等）执行前将其拦截。当用户希望阻止破坏性 git 操作、添加 git 安全钩子，或在 Claude Code 中拦截 git push/reset 时使用。
---

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

# 配置 Git 安全钩子

配置一个 PreToolUse 钩子，在 Claude 执行危险 git 命令之前将其拦截并阻止。

## 会被拦截的命令

- `git push`（所有变体，包括 `--force`）
- `git reset --hard`
- `git clean -f` / `git clean -fd`
- `git branch -D`
- `git checkout .` / `git restore .`

命令被拦截时，Claude 会收到一条消息，说明该操作不在授权范围内。

## 步骤

### 1. 询问作用范围

询问用户：仅为 **当前项目** 安装（`.claude/settings.json`），还是为 **所有项目** 安装（`~/.claude/settings.json`）？

### 2. 复制钩子脚本

随附的脚本位于：[scripts/block-dangerous-git.sh](scripts/block-dangerous-git.sh)。执行复制时使用 `${CLAUDE_PLUGIN_ROOT}/skills/git-safety/scripts/block-dangerous-git.sh` 作为源路径；该变量由 Claude Code 在插件技能内容中展开。不要从当前工作目录猜测源路径，也不要修改插件安装目录。

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
            "command": "\"$HOME\"/.claude/hooks/block-dangerous-git.sh"
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

先确认 `jq` 可用；它是随附脚本解析 Claude Code hook 输入所需的唯一外部命令。缺少时停止安装并告诉用户如何通过团队环境管理方式安装，不要留下一个无法执行的 hook。

然后运行一个快速测试：

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | <path-to-script>
```

应当以退出码 2 退出，并在 stderr 打印一条 BLOCKED 消息。
