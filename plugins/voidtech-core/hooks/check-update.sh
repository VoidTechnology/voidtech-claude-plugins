#!/usr/bin/env bash
# SessionStart 钩子：每天最多检查一次 voidtech-core 更新。
# 只提示用户可执行命令，不自动修改本地插件或 Marketplace。

set -uo pipefail

PLUGIN_NAME="voidtech-core"
MARKETPLACE_NAME="voidtech"
DEFAULT_MANIFEST_URL="https://raw.githubusercontent.com/VoidTechnology/voidtech-claude-plugins/main/plugins/voidtech-core/.claude-plugin/plugin.json"

if [[ "${VOIDTECH_DISABLE_UPDATE_CHECK:-}" == "1" ]]; then
  exit 0
fi

plugin_root=${CLAUDE_PLUGIN_ROOT:-}
if [[ -z "$plugin_root" ]]; then
  plugin_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)
fi

manifest="$plugin_root/.claude-plugin/plugin.json"
if [[ ! -f "$manifest" ]]; then
  exit 0
fi

extract_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$1" | head -n 1
}

semver_gt() {
  local left="$1" right="$2"
  local left_major left_minor left_patch right_major right_minor right_patch

  if [[ ! "$left" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$right" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 1
  fi

  IFS=. read -r left_major left_minor left_patch <<<"$left"
  IFS=. read -r right_major right_minor right_patch <<<"$right"

  if ((10#$left_major != 10#$right_major)); then
    ((10#$left_major > 10#$right_major))
    return
  fi
  if ((10#$left_minor != 10#$right_minor)); then
    ((10#$left_minor > 10#$right_minor))
    return
  fi
  ((10#$left_patch > 10#$right_patch))
}

current_version=$(extract_version "$manifest")
if [[ -z "$current_version" ]]; then
  exit 0
fi

now=$(date +%s 2>/dev/null)
if [[ -z "$now" ]]; then
  exit 0
fi

ttl_seconds=${VOIDTECH_UPDATE_CHECK_TTL_SECONDS:-86400}
if [[ ! "$ttl_seconds" =~ ^[0-9]+$ ]]; then
  ttl_seconds=86400
fi

if [[ -n "${VOIDTECH_UPDATE_CACHE_DIR:-}" ]]; then
  cache_dir="$VOIDTECH_UPDATE_CACHE_DIR"
elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
  cache_dir="$XDG_CACHE_HOME/voidtech-claude-plugins"
else
  cache_dir="$HOME/.cache/voidtech-claude-plugins"
fi
cache_file="$cache_dir/$PLUGIN_NAME-update-check"

if [[ -f "$cache_file" ]]; then
  last_checked=$(sed -n '1p' "$cache_file" 2>/dev/null)
  if [[ "$last_checked" =~ ^[0-9]+$ ]] && ((now >= last_checked)) && ((now - last_checked < ttl_seconds)); then
    exit 0
  fi
fi

mkdir -p "$cache_dir" 2>/dev/null || exit 0
printf '%s\n' "$now" >"$cache_file" 2>/dev/null || exit 0

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

manifest_url=${VOIDTECH_UPDATE_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}
remote_manifest=$(mktemp "${TMPDIR:-/tmp}/voidtech-update.XXXXXX") || exit 0
trap 'rm -f "$remote_manifest"' EXIT

if ! curl -fsSL --connect-timeout 2 --max-time 4 "$manifest_url" -o "$remote_manifest" >/dev/null 2>&1; then
  exit 0
fi

latest_version=$(extract_version "$remote_manifest")
if ! semver_gt "$latest_version" "$current_version"; then
  exit 0
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"【VoidTech update】%s 有可用更新：%s -> %s。建议运行：claude plugin marketplace update %s && claude plugin update %s@%s"}}\n' \
  "$PLUGIN_NAME" \
  "$current_version" \
  "$latest_version" \
  "$MARKETPLACE_NAME" \
  "$PLUGIN_NAME" \
  "$MARKETPLACE_NAME"
