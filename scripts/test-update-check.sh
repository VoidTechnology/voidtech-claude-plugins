#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT_DIR/plugins/voidtech-core/hooks/check-update.sh"
failures=0

fail() {
  printf '失败：%s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf '通过：%s\n' "$1"
}

make_plugin_root() {
  local version="$1" root="$2"
  mkdir -p "$root/.claude-plugin"
  printf '{ "name": "voidtech-core", "version": "%s" }\n' "$version" >"$root/.claude-plugin/plugin.json"
}

make_remote_manifest() {
  local version="$1" manifest="$2"
  printf '{ "name": "voidtech-core", "version": "%s" }\n' "$version" >"$manifest"
}

run_check() {
  local plugin_root="$1" remote_manifest="$2" cache_dir="$3"
  CLAUDE_PLUGIN_ROOT="$plugin_root" \
    VOIDTECH_UPDATE_MANIFEST_URL="file://$remote_manifest" \
    VOIDTECH_UPDATE_CACHE_DIR="$cache_dir" \
    VOIDTECH_UPDATE_CHECK_TTL_SECONDS=86400 \
    "$SCRIPT"
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/voidtech-update-check-test.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

if [[ ! -x "$SCRIPT" ]]; then
  fail "更新检查脚本不存在或不可执行"
  exit 1
fi

same_root="$tmp_dir/same/plugin"
same_remote="$tmp_dir/same/remote.json"
same_cache="$tmp_dir/same/cache"
mkdir -p "$(dirname "$same_remote")"
make_plugin_root "0.5.0" "$same_root"
make_remote_manifest "0.5.0" "$same_remote"
same_output=$(run_check "$same_root" "$same_remote" "$same_cache")
if [[ -z "$same_output" && -f "$same_cache/voidtech-core-update-check" ]]; then
  pass "版本相同时静默并写入检查缓存"
else
  fail "版本相同时不应输出更新提示"
fi

new_root="$tmp_dir/new/plugin"
new_remote="$tmp_dir/new/remote.json"
new_cache="$tmp_dir/new/cache"
mkdir -p "$(dirname "$new_remote")"
make_plugin_root "0.5.0" "$new_root"
make_remote_manifest "0.5.1" "$new_remote"
new_output=$(run_check "$new_root" "$new_remote" "$new_cache")
if [[ "$new_output" == *"0.5.0 -> 0.5.1"* && "$new_output" == *"claude plugin marketplace update voidtech"* ]]; then
  pass "发现新版本时输出更新提示"
else
  fail "发现新版本时缺少可执行更新提示"
fi

ttl_root="$tmp_dir/ttl/plugin"
ttl_remote="$tmp_dir/ttl/remote.json"
ttl_cache="$tmp_dir/ttl/cache"
mkdir -p "$(dirname "$ttl_remote")" "$ttl_cache"
make_plugin_root "0.5.0" "$ttl_root"
make_remote_manifest "0.5.1" "$ttl_remote"
date +%s >"$ttl_cache/voidtech-core-update-check"
ttl_output=$(run_check "$ttl_root" "$ttl_remote" "$ttl_cache")
if [[ -z "$ttl_output" ]]; then
  pass "缓存有效期内不重复检查"
else
  fail "缓存有效期内不应重复提示更新"
fi

offline_root="$tmp_dir/offline/plugin"
offline_remote="$tmp_dir/offline/missing.json"
offline_cache="$tmp_dir/offline/cache"
make_plugin_root "0.5.0" "$offline_root"
offline_output=$(run_check "$offline_root" "$offline_remote" "$offline_cache")
if [[ -z "$offline_output" && -f "$offline_cache/voidtech-core-update-check" ]]; then
  pass "离线或远端失败时静默并写入检查缓存"
else
  fail "离线或远端失败时应静默降级"
fi

if ((failures > 0)); then
  printf '\n更新检查测试失败：%d 项\n' "$failures" >&2
  exit 1
fi

printf '\n更新检查测试通过\n'
