#!/usr/bin/env bash
# voidtech-loop worker PreToolUse 守卫（PRD 5.4 / 技术设计 §3）。
# best-effort 拦截层：git 写命令、越界写路径、Goal Spec 作者目录与 protected paths。
# 硬边界由控制器每轮后置校验（4.2.3）负责；本脚本挡住的是常规路径，不宣称完备。
# 环境：LOOP_ROOT=循环 worktree 绝对路径（必填）；LOOP_PROTECTED_FILE=冻结 protected patterns 文件（可选）。

set -uo pipefail

INPUT=$(cat)
TOOL=$(jq -r '.tool_name // empty' <<<"$INPUT")
ROOT="${LOOP_ROOT:?LOOP_ROOT 未设置}"

deny() {
  printf 'voidtech-loop guard: %s\n' "$1" >&2
  exit 2
}

# 语义对齐 python 的 os.path.realpath：目标路径可以不存在（Write 新文件），
# 解析已存在前缀的符号链接后拼回剩余部分。node 是 preflight 声明的硬依赖。
realpath_norm() {
  node -e '
    const fs = require("fs"), path = require("path");
    let cur = path.resolve(process.argv[1]), suffix = "";
    for (;;) {
      try { console.log(path.join(fs.realpathSync(cur), suffix)); break; }
      catch {
        const parent = path.dirname(cur);
        if (parent === cur) { console.log(path.join(cur, suffix)); break; }
        suffix = path.join(path.basename(cur), suffix);
        cur = parent;
      }
    }
  ' "$1"
}

case "$TOOL" in
  Bash)
    CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
    GIT_WRITE='(add|commit|push|pull|fetch|merge|rebase|reset|branch|checkout|switch|restore|update-ref|update-index|symbolic-ref|worktree|config|tag|stash|cherry-pick|revert|clean|filter-branch|gc|prune|reflog|remote|submodule|am|apply|mv|rm|notes|replace)'
    # 锚点集含 / 以覆盖绝对路径调用（/usr/bin/git ...）；best-effort，硬边界仍在控制器后置校验
    if grep -qE "(^|[;&|[:space:]\(/])git([[:space:]]+-[Cc][[:space:]]*[^[:space:]]+)*([[:space:]]+-[^[:space:]]+)*[[:space:]]+${GIT_WRITE}([[:space:]]|$)" <<<"$CMD"; then
      deny "worker 无 Git 写权限（loop 策略）：${CMD}"
    fi
    ;;
  Write|Edit|NotebookEdit)
    FILE=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$INPUT")
    [ -z "$FILE" ] && exit 0
    case "$FILE" in
      /*) ABS="$FILE" ;;
      *) ABS="$ROOT/$FILE" ;;
    esac
    RES=$(realpath_norm "$ABS")
    ROOTRES=$(realpath_norm "$ROOT")
    case "$RES" in
      "$ROOTRES"/*) ;;
      *) deny "写路径越界循环 worktree：${FILE}" ;;
    esac
    REL="${RES#"$ROOTRES"/}"
    case "$REL" in
      .voidtech-loop/*) deny "worker 不得修改 Goal Spec 作者目录：${REL}" ;;
      .claude/*) deny "worker 不得修改循环 worktree 的 Claude 配置：${REL}" ;;
    esac
    if [ -n "${LOOP_PROTECTED_FILE:-}" ] && [ -f "$LOOP_PROTECTED_FILE" ]; then
      while IFS= read -r pat; do
        [ -z "$pat" ] && continue
        case "$pat" in
          *'/**')
            prefix="${pat%/\*\*}"
            case "$REL" in
              "$prefix"/*|"$prefix") deny "worker 不得修改 protected path：${REL}（规则 ${pat}）" ;;
            esac
            ;;
          *)
            # bash case 的 * 可跨 /，比 gitignore 略宽；宁可多拦（硬边界在后置校验）
            case "$REL" in
              $pat) deny "worker 不得修改 protected path：${REL}（规则 ${pat}）" ;;
            esac
            ;;
        esac
      done < "$LOOP_PROTECTED_FILE"
    fi
    ;;
esac

exit 0
