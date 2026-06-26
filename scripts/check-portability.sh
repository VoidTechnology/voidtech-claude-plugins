#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXPECTED_PLUGINS=$'voidtech-core\nvoidtech-mcp-apple\nvoidtech-mcp-common'
EXPECTED_CORE_SKILLS=$'architecture-review\ncodebase-design\ndebug\ndomain-modeling\nfix-conflicts\ngit-safety\nhandoff\nimplement\nlearn\nplan-review\nplan-review-core\nplan-review-docs\nprepare-issue\nprototype\nresearch\nsetup-git-checks\nship\ntdd\ntext-naturalizer\nto-issues\nto-prd\nwrite-skills'
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

  if jq -e '
    [.hooks.SessionStart[].hooks[].command] |
    index("${CLAUDE_PLUGIN_ROOT}/hooks/zh-locale.sh") != null and
    index("${CLAUDE_PLUGIN_ROOT}/hooks/check-update.sh") != null
  ' plugins/voidtech-core/hooks/hooks.json >/dev/null 2>&1; then
    pass "SessionStart 同时注入中文约定与更新检查"
  else
    fail "SessionStart 缺少中文约定或更新检查"
  fi

  update_check=plugins/voidtech-core/hooks/check-update.sh
  if [[ -x "$update_check" ]]; then
    pass "更新检查脚本可执行"
  else
    fail "更新检查脚本缺少执行权限"
  fi

  if bash scripts/test-update-check.sh >/dev/null; then
    pass "更新检查脚本行为测试"
  else
    fail "更新检查脚本行为测试未通过"
  fi

  core_skill_count=$(find plugins/voidtech-core/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
  if [[ "$core_skill_count" == "22" ]]; then
    pass "voidtech-core 发布 22 个技能"
  else
    fail "voidtech-core 技能数量异常：$core_skill_count"
  fi

  actual_core_skills=$(
    find plugins/voidtech-core/skills -mindepth 2 -maxdepth 2 -name SKILL.md -print0 |
      while IFS= read -r -d '' skill_file; do
        basename "$(dirname "$skill_file")"
      done |
      sort
  )
  if [[ "$actual_core_skills" == "$EXPECTED_CORE_SKILLS" ]]; then
    pass "voidtech-core 技能名称符合公共命令契约"
  else
    fail "voidtech-core 技能名称不符合公共命令契约"
  fi

  while IFS= read -r -d '' skill_file; do
    skill_dir=$(basename "$(dirname "$skill_file")")
    declared_name=$(sed -n 's/^name: *//p' "$skill_file" | head -n 1)
    if [[ "$declared_name" == "$skill_dir" ]]; then
      pass "$skill_dir 的目录名与展示名一致"
    else
      fail "$skill_dir 的目录名与展示名不一致：$declared_name"
    fi
  done < <(find plugins/voidtech-core/skills -mindepth 2 -maxdepth 2 -name SKILL.md -print0)

  while IFS= read -r skill_ref; do
    referenced_skill=${skill_ref#voidtech-core:}
    if grep -Fxq "$referenced_skill" <<<"$EXPECTED_CORE_SKILLS"; then
      pass "跨技能调用指向已发布技能 $skill_ref"
    else
      fail "跨技能调用指向未发布技能 $skill_ref"
    fi
  done < <(
    rg -o --no-filename 'voidtech-core:[a-z0-9-]+' plugins/voidtech-core/skills |
      sort -u
  )

  if rg -n \
    '/setup-matt-pocock-skills|`/(codebase-design|domain-modeling|tdd|review)`|cdn\.tailwindcss\.com|cdn\.jsdelivr\.net' \
    plugins/voidtech-core/skills >/dev/null; then
    fail "发布技能仍依赖未分发命令或远程运行时"
  else
    pass "发布技能不依赖未分发命令或远程运行时"
  fi

  if rg -n \
    '不留情面|盘问循环|曳光弹|流畅强度|储存强度|用完即弃|子形态|拧出确定性|三个桶|预重构|垃圾测试|车灯照不到|调试的超能力|参数化的臆测|无情地修剪|脑内草图|不配占位置' \
    plugins/voidtech-core/skills >/dev/null; then
    fail "汉化技能重新出现已淘汰的生硬译法"
  else
    pass "汉化技能不包含已淘汰的生硬译法"
  fi

  if rg -n \
    '<script[^>]+src=|<link[^>]+href="https?://|<img[^>]+src="https?://|url\(https?://|import[^;]*https?://' \
    plugins/voidtech-core/skills/architecture-review >/dev/null; then
    fail "架构审查仍包含远程 HTML 运行时"
  else
    pass "架构审查 HTML 完全离线"
  fi

  while IFS= read -r -d '' resource_file; do
    while IFS= read -r markdown_link; do
      link_target=${markdown_link#](}
      link_target=${link_target%)}
      link_target=${link_target%%#*}
      case "$link_target" in
        '' | http://* | https://* | mailto:*) continue ;;
      esac

      if [[ -e "$(dirname "$resource_file")/$link_target" ]]; then
        pass "$resource_file 的本地引用存在：$link_target"
      else
        fail "$resource_file 的本地引用缺失：$link_target"
      fi
    done < <(
      awk '
        /^```/ { in_fence = !in_fence; next }
        !in_fence { print }
      ' "$resource_file" |
        rg -o --no-filename '\]\([^)]+\)' || true
    )
  done < <(find plugins/voidtech-core/skills -type f -name '*.md' -print0)

  if [[ -f plugins/voidtech-core/skills/text-naturalizer/LICENSE ]]; then
    pass "text-naturalizer 随附许可证"
  else
    fail "text-naturalizer 声明的 LICENSE 未随插件分发"
  fi

  if rg -F '${CLAUDE_PLUGIN_ROOT}/skills/debug/scripts/hitl-loop.template.sh' \
      plugins/voidtech-core/skills/debug/SKILL.md >/dev/null && \
    rg -F '${CLAUDE_PLUGIN_ROOT}/skills/git-safety/scripts/block-dangerous-git.sh' \
      plugins/voidtech-core/skills/git-safety/SKILL.md >/dev/null; then
    pass "随附脚本通过 CLAUDE_PLUGIN_ROOT 定位"
  else
    fail "随附脚本缺少可移植的 CLAUDE_PLUGIN_ROOT 定位"
  fi

  git_guard=plugins/voidtech-core/skills/git-safety/scripts/block-dangerous-git.sh
  if printf '%s\n' '{"tool_input":{"command":"git status"}}' | "$git_guard" >/dev/null 2>&1; then
    pass "Git 防护脚本允许只读命令"
  else
    fail "Git 防护脚本错误拦截只读命令"
  fi

  dangerous_git_commands=(
    "git -C repo push origin main"
    "git reset --hard HEAD~1"
    "git clean -fd"
    "git branch -D feature"
    "git checkout ."
    "git restore ."
  )
  for dangerous_git_command in "${dangerous_git_commands[@]}"; do
    if jq -nc --arg command "$dangerous_git_command" \
        '{tool_input: {command: $command}}' | "$git_guard" >/dev/null 2>&1; then
      fail "Git 防护脚本未拦截危险命令：$dangerous_git_command"
    elif [[ "$?" == "2" ]]; then
      pass "Git 防护脚本拦截危险命令：$dangerous_git_command"
    else
      fail "Git 防护脚本以错误状态处理：$dangerous_git_command"
    fi
  done

  if printf '%s\n' '{}' | "$git_guard" >/dev/null 2>&1; then
    fail "Git 防护脚本对异常输入没有采用安全默认值"
  elif [[ "$?" == "2" ]]; then
    pass "Git 防护脚本对异常输入采用安全默认值"
  else
    fail "Git 防护脚本以错误状态处理异常输入"
  fi
else
  fail "缺少 plugins/voidtech-core"
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

    core_install_path=$(
      jq -r '.[] | select(.id == "voidtech-core@voidtech") | .installPath' <<<"$installed_json"
    )
    installed_resources=(
      "hooks/check-update.sh"
      "hooks/zh-locale.sh"
      "skills/_shared/ISSUE-TRACKER.md"
      "skills/architecture-review/HTML-REPORT.md"
      "skills/debug/scripts/hitl-loop.template.sh"
      "skills/git-safety/scripts/block-dangerous-git.sh"
      "skills/research/SKILL.md"
      "skills/ship/SKILL.md"
      "skills/text-naturalizer/LICENSE"
    )
    missing_installed_resource=0
    for installed_resource in "${installed_resources[@]}"; do
      if [[ -f "$core_install_path/$installed_resource" ]]; then
        pass "隔离安装包含 $installed_resource"
      else
        fail "隔离安装缺少 $installed_resource"
        missing_installed_resource=1
      fi
    done

    if ((missing_installed_resource == 0)) && \
      [[ -x "$core_install_path/hooks/check-update.sh" ]] && \
      [[ -x "$core_install_path/skills/git-safety/scripts/block-dangerous-git.sh" ]]; then
      pass "隔离安装保留随附脚本执行权限"
    else
      fail "隔离安装未保留随附脚本执行权限"
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
