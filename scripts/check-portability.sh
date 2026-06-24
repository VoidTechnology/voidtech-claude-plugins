#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXPECTED_PLUGINS=$'voidtech-core\nvoidtech-mcp-apple\nvoidtech-mcp-common'
failures=0

pass() {
  printf '通过：%s\n' "$1"
}

fail() {
  printf '失败：%s\n' "$1" >&2
  failures=$((failures + 1))
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "找到命令 $1"
  else
    fail "缺少命令 $1"
  fi
}

cd "$ROOT_DIR" || exit 1

require_command claude
require_command jq
require_command rg

if ((failures > 0)); then
  printf '\n缺少必要验证工具，停止检查\n' >&2
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  if claude plugin validate . --strict >/dev/null; then
    pass "Marketplace 严格校验"
  else
    fail "Marketplace 严格校验未通过"
  fi
fi

actual_plugins=$(jq -r '.plugins[].name' .claude-plugin/marketplace.json 2>/dev/null | sort)
if [[ "$actual_plugins" == "$EXPECTED_PLUGINS" ]]; then
  pass "Marketplace 仅发布目标插件"
else
  fail "Marketplace 插件集合不符合目标架构"
fi

if jq -e 'has("//") | not' templates/project-settings.json >/dev/null; then
  pass "项目设置模板不包含伪注释键"
else
  fail "项目设置模板包含无效的伪注释键"
fi

for plugin_dir in plugins/*; do
  [[ -d "$plugin_dir" ]] || continue
  manifest="$plugin_dir/.claude-plugin/plugin.json"
  if [[ ! -f "$manifest" ]]; then
    fail "$plugin_dir 缺少 plugin.json"
    continue
  fi

  if command -v claude >/dev/null 2>&1 && claude plugin validate "$plugin_dir" --strict >/dev/null; then
    pass "$plugin_dir 严格校验"
  else
    fail "$plugin_dir 严格校验未通过"
  fi

  version=$(jq -r '.version // empty' "$manifest")
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    pass "$plugin_dir 使用语义化版本 $version"
  else
    fail "$plugin_dir 缺少有效语义化版本"
  fi
done

if [[ -d plugins/voidtech-core ]]; then
  if [[ -f plugins/voidtech-core/.mcp.json ]]; then
    fail "voidtech-core 不应捆绑 MCP"
  else
    pass "voidtech-core 不捆绑 MCP"
  fi

  if jq -e '.hooks.SessionStart and (.hooks.UserPromptSubmit | not)' \
    plugins/voidtech-core/hooks/hooks.json >/dev/null 2>&1; then
    pass "中文约定仅在 SessionStart 注入"
  else
    fail "中文 hook 应从 UserPromptSubmit 改为 SessionStart"
  fi

  core_skill_count=$(find plugins/voidtech-core/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
  if [[ "$core_skill_count" == "20" ]]; then
    pass "voidtech-core 发布 20 个技能"
  else
    fail "voidtech-core 技能数量异常：$core_skill_count"
  fi
else
  fail "缺少 plugins/voidtech-core"
fi

archived_gstack_count=$(find archive/gstack-skills -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
if [[ "$archived_gstack_count" == "8" ]]; then
  pass "8 个 gstack 技能位于归档区"
else
  fail "gstack 归档数量异常：$archived_gstack_count"
fi

for optional_plugin in plugins/voidtech-mcp-common plugins/voidtech-mcp-apple; do
  manifest="$optional_plugin/.claude-plugin/plugin.json"
  if [[ -f "$manifest" ]] && jq -e '.defaultEnabled == false' "$manifest" >/dev/null; then
    pass "$optional_plugin 默认禁用"
  else
    fail "$optional_plugin 必须默认禁用"
  fi
done

if jq -e '
  (.mcpServers["chrome-devtools"].args | index("--no-usage-statistics")) != null and
  (.mcpServers["chrome-devtools"].args | index("--no-performance-crux")) != null
' plugins/voidtech-mcp-common/.mcp.json >/dev/null; then
  pass "Chrome DevTools 默认关闭外部统计"
else
  fail "Chrome DevTools 必须关闭使用统计与 CrUX URL 查询"
fi

while IFS= read -r -d '' mcp_config; do
  while IFS=$'\t' read -r server package_spec; do
    [[ -n "$server" ]] || continue
    if [[ "$package_spec" =~ @[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      pass "$server 锁定为 $package_spec"
    else
      fail "$server 的 npx 包未锁定精确版本：$package_spec"
    fi
  done < <(
    jq -r '.mcpServers | to_entries[] |
      select(.value.command == "npx") |
      [.key, ([.value.args[] | select(startswith("-") | not)][0] // "")] |
      @tsv' "$mcp_config"
  )
done < <(find plugins -name .mcp.json -print0)

if rg --hidden -n '~/.gstack|\.claude/skills/gstack|gstack/bin' plugins >/dev/null; then
  fail "发布插件仍依赖 gstack 外部运行时"
else
  pass "发布插件不依赖 gstack 外部运行时"
fi

if rg --hidden -n '@latest|@modelcontextprotocol/server-github|figma-developer-mcp' plugins >/dev/null; then
  fail "发布插件仍包含浮动或已淘汰的 MCP 依赖"
else
  pass "发布插件不包含浮动或已淘汰的 MCP 依赖"
fi

if find . -path './.git' -prune -o -path '*/karpathy-guidelines/SKILL.md' -print -quit | grep -q .; then
  fail "工作树仍包含未获明确再分发许可的 karpathy-guidelines 原文"
else
  pass "工作树不包含缺少许可证的 karpathy-guidelines 原文"
fi

while IFS= read -r -d '' skill_file; do
  line_count=$(wc -l < "$skill_file" | tr -d ' ')
  if ((line_count > 500)); then
    fail "$skill_file 超过 500 行：$line_count"
  fi
done < <(find plugins -path '*/skills/*/SKILL.md' -print0)

if rg --hidden -n \
  '(ghp_[[:alnum:]]{30,}|ctx7sk-[[:alnum:]_-]{20,}|figd_[[:alnum:]_-]{20,}|sk-[[:alnum:]_-]{20,})' \
  . -g '!.git/**' -g '!scripts/check-portability.sh' >/dev/null; then
  fail "仓库疑似包含明文密钥"
else
  pass "未发现常见明文密钥"
fi

if [[ "${1:-}" == "--install-smoke" ]] && command -v claude >/dev/null 2>&1; then
  audit_dir=$(mktemp -d "${TMPDIR:-/tmp}/voidtech-plugin-audit.XXXXXX")
  if CLAUDE_CONFIG_DIR="$audit_dir" claude plugin marketplace add ./ >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-core@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-mcp-common@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-mcp-apple@voidtech --scope user >/dev/null; then
    installed_json=$(CLAUDE_CONFIG_DIR="$audit_dir" claude plugin list --json)
    installed_count=$(jq 'length' <<<"$installed_json")
    if [[ "$installed_count" == "3" ]]; then
      pass "隔离安装三个插件"
    else
      fail "隔离环境安装数量异常：$installed_count"
    fi

    if jq -e '
      (map(select(.id == "voidtech-core@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-mcp-common@voidtech" and .enabled == false)) | length == 1) and
      (map(select(.id == "voidtech-mcp-apple@voidtech" and .enabled == false)) | length == 1)
    ' <<<"$installed_json" >/dev/null; then
      pass "隔离安装后的启用状态正确"
    else
      fail "隔离安装后的启用状态错误"
    fi
  else
    fail "隔离安装失败"
  fi
  rm -r -- "$audit_dir"
fi

if ((failures > 0)); then
  printf '\n可移植性检查失败：%d 项\n' "$failures" >&2
  exit 1
fi

printf '\n可移植性检查通过\n'
