#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

plugin=${1:-}
case "$plugin" in
  voidtech-core)
    resources=(
      hooks/check-update.sh
      hooks/zh-locale.sh
      skills/research/SKILL.md
      runtime/archify/voidtech_archify/archify_bridge.py
    )
    executable=hooks/check-update.sh
    ;;
  voidtech-loop)
    resources=(
      skills/goal/SKILL.md
      skills/goal-spec/SKILL.md
      scripts/loop.mjs
      schemas/goal-spec.schema.json
    )
    executable=scripts/loop
    ;;
  *)
    echo "用法：scripts/check-plugin-compatibility.sh <voidtech-core|voidtech-loop>" >&2
    exit 2
    ;;
esac

for command_name in claude jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

claude plugin validate "plugins/$plugin" --strict >/dev/null

audit_dir=$(mktemp -d "${TMPDIR:-/tmp}/${plugin}-compatibility.XXXXXX")
cleanup() {
  rm -rf -- "$audit_dir"
}
trap cleanup EXIT

CLAUDE_CONFIG_DIR="$audit_dir" claude plugin marketplace add ./ >/dev/null
CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install "$plugin@voidtech" --scope user >/dev/null
installed_json=$(CLAUDE_CONFIG_DIR="$audit_dir" claude plugin list --json)

if ! jq -e --arg id "$plugin@voidtech" '
  length == 1 and
  .[0].id == $id and
  .[0].enabled == true and
  (.[0].installPath | type == "string" and length > 0)
' <<<"$installed_json" >/dev/null; then
  echo "$plugin 隔离安装结果不符合契约" >&2
  exit 1
fi

install_path=$(jq -r '.[0].installPath' <<<"$installed_json")
for relative_path in "${resources[@]}"; do
  if [[ ! -f "$install_path/$relative_path" ]]; then
    echo "$plugin 隔离安装缺少资源：$relative_path" >&2
    exit 1
  fi
done

if [[ ! -x "$install_path/$executable" ]]; then
  echo "$plugin 未保留执行权限：$executable" >&2
  exit 1
fi

echo "$plugin 最低版本兼容性冒烟通过"
