#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXPECTED_PLUGINS=$'voidtech-core\nvoidtech-design\nvoidtech-engineering\nvoidtech-loop\nvoidtech-mcp-apple\nvoidtech-mcp-common\nvoidtech-product'
EXPECTED_OMP_PLUGINS=$'voidtech-core\nvoidtech-design\nvoidtech-engineering\nvoidtech-mcp-apple\nvoidtech-mcp-common\nvoidtech-product'
EXPECTED_CORE_SKILLS=$'handoff\nlearn\nplan-review\nplan-review-core\nplan-review-docs\nresearch\ntext-naturalizer\nwrite-skills'
EXPECTED_PRODUCT_SKILLS=$'prd-from-requirements\nprd-maintain\nprd-sync'
EXPECTED_DESIGN_SKILLS=$'create-design-md\nto-design-brief\nui-prototype'
EXPECTED_ENGINEERING_SKILLS=$'architecture-review\ncodebase-design\ndebug\nfeature-context\nfix-conflicts\ngit-safety\nimplement\nlogic-spike\nprepare-issue\nsetup-git-checks\nship\ntdd\nto-issues\nto-prd'
EXPECTED_PRODUCT_AGENTS='product-manager'
EXPECTED_ENGINEERING_AGENTS='architect'
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

actual_omp_plugins=$(jq -r '.plugins[].name' .omp-plugin/marketplace.json 2>/dev/null | sort)
if [[ "$actual_omp_plugins" == "$EXPECTED_OMP_PLUGINS" ]]; then
  pass "OMP Marketplace 仅发布第一、第二阶段兼容插件"
else
  fail "OMP Marketplace 插件集合不符合双宿主范围"
fi
if jq -e '[.plugins[].name] | index("voidtech-loop") == null' \
    .omp-plugin/marketplace.json >/dev/null 2>&1; then
  pass "OMP Marketplace 不误发 Claude-only voidtech-loop"
else
  fail "OMP Marketplace 不得发布 voidtech-loop"
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

  if [[ -f plugins/voidtech-core/hooks/pre/voidtech-session.mjs ]] && \
      rg -F "pi.on('session_start'" plugins/voidtech-core/hooks/pre/voidtech-session.mjs >/dev/null && \
      rg -F -- "--host', 'omp" plugins/voidtech-core/hooks/pre/voidtech-session.mjs >/dev/null; then
    pass "Core 随附 OMP Session Hook"
  else
    fail "Core 缺少 OMP Session Hook"
  fi

  if [[ -f plugins/voidtech-product/tools/product-runtime.mjs ]] && \
      rg -F "name: 'voidtech_product_runtime'" plugins/voidtech-product/tools/product-runtime.mjs >/dev/null && \
      rg -F "skill://git-safety/scripts/block-dangerous-git-omp.mjs" \
        plugins/voidtech-engineering/skills/git-safety/SKILL.md >/dev/null; then
    pass "Product Runtime 与 Engineering Git Safety 随附 OMP 适配器"
  else
    fail "双宿主运行适配器不完整"
  fi

  for domain in core product design engineering; do
    plugin_name="voidtech-$domain"
    plugin_root="plugins/$plugin_name"
    case "$domain" in
      core)
        expected_skills="$EXPECTED_CORE_SKILLS"
        expected_agents=""
        ;;
      product)
        expected_skills="$EXPECTED_PRODUCT_SKILLS"
        expected_agents="$EXPECTED_PRODUCT_AGENTS"
        ;;
      design)
        expected_skills="$EXPECTED_DESIGN_SKILLS"
        expected_agents=""
        ;;
      engineering)
        expected_skills="$EXPECTED_ENGINEERING_SKILLS"
        expected_agents="$EXPECTED_ENGINEERING_AGENTS"
        ;;
    esac

    actual_skills=$(
      find "$plugin_root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -print0 |
        while IFS= read -r -d '' skill_file; do
          basename "$(dirname "$skill_file")"
        done |
        sort
    )
    if [[ "$actual_skills" == "$expected_skills" ]]; then
      pass "$plugin_name 技能名称符合公共命令契约"
    else
      fail "$plugin_name 技能名称不符合公共命令契约"
    fi

    actual_agents=$(
      if [[ -d "$plugin_root/agents" ]]; then
        find "$plugin_root/agents" -maxdepth 1 -type f -name '*.md' -print0 |
          while IFS= read -r -d '' agent_file; do
            basename "$agent_file" .md
          done |
          sort
      fi
    )
    if [[ "$actual_agents" == "$expected_agents" ]]; then
      pass "$plugin_name subagent 名称符合公共契约"
    else
      fail "$plugin_name subagent 名称不符合公共契约"
    fi

    while IFS= read -r -d '' skill_file; do
      skill_dir=$(basename "$(dirname "$skill_file")")
      declared_name=$(sed -n 's/^name: *//p' "$skill_file" | head -n 1)
      if [[ "$declared_name" == "$skill_dir" ]]; then
        pass "$plugin_name:$skill_dir 的目录名与展示名一致"
      else
        fail "$plugin_name:$skill_dir 的目录名与展示名不一致：$declared_name"
      fi
    done < <(
      find "$plugin_root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -print0
    )
  done

  while IFS= read -r skill_ref; do
    referenced_plugin=${skill_ref%%:*}
    referenced_name=${skill_ref#*:}
    if [[ -f "plugins/$referenced_plugin/skills/$referenced_name/SKILL.md" ]]; then
      pass "跨插件调用指向已发布技能 $skill_ref"
    elif [[ -f "plugins/$referenced_plugin/agents/$referenced_name.md" ]]; then
      pass "跨插件调用指向已发布 subagent $skill_ref"
    else
      fail "跨插件调用指向未发布技能或 subagent $skill_ref"
    fi
  done < <(
    rg -o --no-filename \
      'voidtech-(core|product|design|engineering):[a-z0-9-]+' \
      plugins/voidtech-core plugins/voidtech-product \
      plugins/voidtech-design plugins/voidtech-engineering |
      sort -u
  )

  if rg -n \
    '/setup-matt-pocock-skills|`/(codebase-design|domain-modeling|tdd|review)`|cdn\.tailwindcss\.com|cdn\.jsdelivr\.net' \
    plugins/voidtech-core/skills plugins/voidtech-product/skills \
    plugins/voidtech-design/skills plugins/voidtech-engineering/skills >/dev/null; then
    fail "发布技能仍依赖未分发命令或远程运行时"
  else
    pass "发布技能不依赖未分发命令或远程运行时"
  fi

  if rg -n \
    '不留情面|盘问循环|曳光弹|流畅强度|储存强度|用完即弃|子形态|拧出确定性|三个桶|预重构|垃圾测试|车灯照不到|调试的超能力|参数化的臆测|无情地修剪|脑内草图|不配占位置' \
    plugins/voidtech-core/skills plugins/voidtech-product/skills \
    plugins/voidtech-design/skills plugins/voidtech-engineering/skills >/dev/null; then
    fail "汉化技能重新出现已淘汰的生硬译法"
  else
    pass "汉化技能不包含已淘汰的生硬译法"
  fi

  if rg -n \
    '<script[^>]+src=|<link[^>]+href="https?://|<img[^>]+src="https?://|url\(https?://|import[^;]*https?://' \
    plugins/voidtech-engineering/skills/architecture-review >/dev/null; then
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
  done < <(
    find plugins/voidtech-core/skills plugins/voidtech-product/skills \
      plugins/voidtech-design/skills plugins/voidtech-engineering/skills \
      -type f -name '*.md' -print0
  )

  if [[ -f plugins/voidtech-core/skills/text-naturalizer/LICENSE ]]; then
    pass "text-naturalizer 随附许可证"
  else
    fail "text-naturalizer 声明的 LICENSE 未随插件分发"
  fi

  for vendored_plugin in voidtech-core voidtech-design voidtech-engineering; do
    vendor_license="plugins/$vendored_plugin/skills/_vendor-licenses/mattpocock-LICENSE"
    if [[ -f "$vendor_license" ]]; then
      pass "$vendored_plugin 随附 vendored 技能许可证"
    else
      fail "$vendored_plugin 缺少 vendored 技能许可证"
    fi
  done

  if rg -F '${CLAUDE_PLUGIN_ROOT}/skills/debug/scripts/hitl-loop.template.sh' \
      plugins/voidtech-engineering/skills/debug/SKILL.md >/dev/null && \
    rg -F '${CLAUDE_PLUGIN_ROOT}/skills/git-safety/scripts/block-dangerous-git.sh' \
      plugins/voidtech-engineering/skills/git-safety/SKILL.md >/dev/null; then
    pass "随附脚本通过 CLAUDE_PLUGIN_ROOT 定位"
  else
    fail "随附脚本缺少可移植的 CLAUDE_PLUGIN_ROOT 定位"
  fi

  git_guard=plugins/voidtech-engineering/skills/git-safety/scripts/block-dangerous-git.sh
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

# 已过门的 fixture 模块清单（技术设计 §11：每阶段只需通过本门）。
# 每过一门在此追加该门模块；未过门的红灯 fixture 只接入对应 loop goal 的 target eval。
DELIVERED_GATE_TESTS=(
  test_schemas test_manifest_checks
  test_writer_lock test_operation_engine test_journal_projector test_effective_view
  test_gate2_migration test_gate2_example
  test_gate3_sync test_gate3_rebaseline
  test_gate4_merge test_gate4_sources
  test_gate5_atlas test_gate5_proof_perf
  test_review_fixes
  test_cli test_check_prd_tree test_renderer_env
)
if command -v python3 >/dev/null 2>&1; then
  if (cd plugins/voidtech-product/skills/prd-from-requirements/tests && \
      python3 -m unittest "${DELIVERED_GATE_TESTS[@]}" >/dev/null 2>&1); then
    pass "prd-from-requirements 已过门 unittest 套件"
  else
    fail "prd-from-requirements 已过门 unittest 套件未通过"
  fi
else
  fail "缺少命令 python3（prd-from-requirements 测试需要）"
fi

if [[ "${1:-}" == "--install-smoke" ]] && command -v claude >/dev/null 2>&1; then
  audit_dir=$(mktemp -d "${TMPDIR:-/tmp}/voidtech-plugin-audit.XXXXXX")
  if CLAUDE_CONFIG_DIR="$audit_dir" claude plugin marketplace add ./ >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-core@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-product@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-design@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-engineering@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-loop@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-mcp-common@voidtech --scope user >/dev/null && \
    CLAUDE_CONFIG_DIR="$audit_dir" claude plugin install voidtech-mcp-apple@voidtech --scope user >/dev/null; then
    installed_json=$(CLAUDE_CONFIG_DIR="$audit_dir" claude plugin list --json)
    installed_count=$(jq 'length' <<<"$installed_json")
    if [[ "$installed_count" == "7" ]]; then
      pass "隔离安装七个插件"
    else
      fail "隔离环境安装数量异常：$installed_count"
    fi

    if jq -e '
      (map(select(.id == "voidtech-core@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-product@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-design@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-engineering@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-loop@voidtech" and .enabled == true)) | length == 1) and
      (map(select(.id == "voidtech-mcp-common@voidtech" and .enabled == false)) | length == 1) and
      (map(select(.id == "voidtech-mcp-apple@voidtech" and .enabled == false)) | length == 1)
    ' <<<"$installed_json" >/dev/null; then
      pass "隔离安装后的启用状态正确"
    else
      fail "隔离安装后的启用状态错误"
    fi

    installed_resources=(
      "voidtech-core|hooks/check-update.sh"
      "voidtech-core|hooks/zh-locale.sh"
      "voidtech-core|hooks/pre/voidtech-session.mjs"
      "voidtech-core|skills/research/SKILL.md"
      "voidtech-core|skills/text-naturalizer/LICENSE"
      "voidtech-core|runtime/archify/voidtech_archify/archify_bridge.py"
      "voidtech-core|runtime/archify/voidtech_archify/architecture_ir.py"
      "voidtech-core|runtime/archify/voidtech_archify/lifecycle_ir.py"
      "voidtech-core|vendor/archify/bin/archify.mjs"
      "voidtech-product|agents/product-manager.md"
      "voidtech-product|tools/product-runtime.mjs"
      "voidtech-product|skills/_shared/HOST-RUNTIME.md"
      "voidtech-product|skills/prd-from-requirements/SKILL.md"
      "voidtech-product|skills/prd-from-requirements/scripts/xlsx-to-markdown.py"
      "voidtech-product|skills/prd-from-requirements/scripts/check-prd-tree.py"
      "voidtech-product|skills/prd-from-requirements/scripts/generate-dashboard.py"
      "voidtech-product|skills/prd-from-requirements/scripts/prd-sync.py"
      "voidtech-product|skills/prd-from-requirements/scripts/prdsync/core_archify.py"
      "voidtech-product|skills/prd-from-requirements/templates/product-overview.md"
      "voidtech-product|skills/prd-from-requirements/templates/domain-spec.md"
      "voidtech-product|skills/prd-from-requirements/templates/feature-gating-matrix.md"
      "voidtech-product|skills/prd-from-requirements/templates/deepening-backlog.md"
      "voidtech-product|skills/prd-from-requirements/assets/renderer-validation-proof.json"
      "voidtech-product|skills/prd-maintain/SKILL.md"
      "voidtech-product|skills/prd-sync/SKILL.md"
      "voidtech-design|skills/create-design-md/SKILL.md"
      "voidtech-design|skills/create-design-md/assets/DESIGN.template.md"
      "voidtech-design|skills/create-design-md/references/design-md-contract.md"
      "voidtech-design|skills/create-design-md/scripts/validate-design-md.sh"
      "voidtech-design|skills/create-design-md/validator/package.json"
      "voidtech-design|skills/create-design-md/validator/package-lock.json"
      "voidtech-design|skills/to-design-brief/SKILL.md"
      "voidtech-design|skills/ui-prototype/SKILL.md"
      "voidtech-engineering|agents/architect.md"
      "voidtech-engineering|skills/_shared/ISSUE-TRACKER.md"
      "voidtech-engineering|skills/architecture-review/HTML-REPORT.md"
      "voidtech-engineering|skills/debug/scripts/hitl-loop.template.sh"
      "voidtech-engineering|skills/git-safety/scripts/block-dangerous-git.sh"
      "voidtech-engineering|skills/git-safety/scripts/block-dangerous-git-omp.mjs"
      "voidtech-engineering|skills/logic-spike/SKILL.md"
      "voidtech-engineering|skills/ship/SKILL.md"
    )
    missing_installed_resource=0
    for installed_resource in "${installed_resources[@]}"; do
      resource_plugin=${installed_resource%%|*}
      relative_path=${installed_resource#*|}
      install_path=$(
        jq -r --arg id "$resource_plugin@voidtech" \
          '.[] | select(.id == $id) | .installPath' <<<"$installed_json"
      )
      if [[ -f "$install_path/$relative_path" ]]; then
        pass "隔离安装包含 $resource_plugin/$relative_path"
      else
        fail "隔离安装缺少 $resource_plugin/$relative_path"
        missing_installed_resource=1
      fi
    done

    core_install_path=$(
      jq -r '.[] | select(.id == "voidtech-core@voidtech") | .installPath' <<<"$installed_json"
    )
    engineering_install_path=$(
      jq -r '.[] | select(.id == "voidtech-engineering@voidtech") | .installPath' <<<"$installed_json"
    )
    design_install_path=$(
      jq -r '.[] | select(.id == "voidtech-design@voidtech") | .installPath' <<<"$installed_json"
    )
    if ((missing_installed_resource == 0)) && \
      [[ -x "$core_install_path/hooks/check-update.sh" ]] && \
      [[ -x "$design_install_path/skills/create-design-md/scripts/validate-design-md.sh" ]] && \
      [[ -x "$engineering_install_path/skills/git-safety/scripts/block-dangerous-git.sh" ]]; then
      pass "隔离安装保留随附脚本执行权限"
    else
      fail "隔离安装未保留随附脚本执行权限"
    fi

    product_install_path=$(
      jq -r '.[] | select(.id == "voidtech-product@voidtech") | .installPath' <<<"$installed_json"
    )
    if CLAUDE_CONFIG_DIR="$audit_dir" \
      PYTHONPATH="$product_install_path/skills/prd-from-requirements/scripts" \
      python3 -c 'from prdsync.core_archify import archify_bridge; print(archify_bridge.vendor_digest())' \
      >/dev/null 2>&1; then
      pass "隔离安装后的 Product 可解析 Core Archify Runtime"
    else
      fail "隔离安装后的 Product 无法解析 Core Archify Runtime"
    fi

    if CLAUDE_CONFIG_DIR="$audit_dir" \
      python3 "$product_install_path/skills/prd-from-requirements/scripts/prd-sync.py" \
      --help >/dev/null 2>&1; then
      pass "隔离安装后的 Product PRD CLI 可真实启动"
    else
      fail "隔离安装后的 Product PRD CLI 启动失败"
    fi
  else
    fail "隔离安装失败"
  fi
  rm -r -- "$audit_dir"
fi

if [[ "${1:-}" == "--install-smoke" ]]; then
  if command -v omp >/dev/null 2>&1; then
    omp_audit_dir=$(mktemp -d "${TMPDIR:-/tmp}/voidtech-omp-plugin-audit.XXXXXX")
    if HOME="$omp_audit_dir" omp plugin marketplace add ./ >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-core@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-product@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-design@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-engineering@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-mcp-common@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin install voidtech-mcp-apple@voidtech >/dev/null && \
      HOME="$omp_audit_dir" omp plugin list >/dev/null; then
      omp_registry="$omp_audit_dir/.omp/plugins/installed_plugins.json"
      if jq -e '.version == 2 and (.plugins | keys | length) == 6 and
        (.plugins | has("voidtech-loop@voidtech") | not)' "$omp_registry" >/dev/null; then
        pass "OMP 隔离安装六个兼容插件且排除 voidtech-loop"
      else
        fail "OMP 隔离安装注册表不符合双宿主范围"
      fi

      omp_installed_resources=(
        "voidtech-core|hooks/pre/voidtech-session.mjs"
        "voidtech-product|tools/product-runtime.mjs"
        "voidtech-product|skills/_shared/HOST-RUNTIME.md"
        "voidtech-product|agents/product-manager.md"
        "voidtech-design|skills/create-design-md/SKILL.md"
        "voidtech-design|skills/create-design-md/scripts/validate-design-md.sh"
        "voidtech-design|skills/create-design-md/validator/package.json"
        "voidtech-design|skills/create-design-md/validator/package-lock.json"
        "voidtech-design|skills/to-design-brief/SKILL.md"
        "voidtech-engineering|agents/architect.md"
        "voidtech-engineering|skills/git-safety/scripts/block-dangerous-git-omp.mjs"
        "voidtech-mcp-common|.mcp.json"
        "voidtech-mcp-apple|.mcp.json"
      )
      omp_missing_resource=0
      for installed_resource in "${omp_installed_resources[@]}"; do
        resource_plugin=${installed_resource%%|*}
        relative_path=${installed_resource#*|}
        install_path=$(
          jq -r --arg id "$resource_plugin@voidtech" \
            '.plugins[$id][0].installPath // empty' "$omp_registry"
        )
        if [[ -f "$install_path/$relative_path" ]]; then
          pass "OMP 隔离安装包含 $resource_plugin/$relative_path"
        else
          fail "OMP 隔离安装缺少 $resource_plugin/$relative_path"
          omp_missing_resource=1
        fi
      done

      omp_product_path=$(
        jq -r '.plugins["voidtech-product@voidtech"][0].installPath' "$omp_registry"
      )
      omp_design_path=$(
        jq -r '.plugins["voidtech-design@voidtech"][0].installPath' "$omp_registry"
      )
      if ((omp_missing_resource == 0)) && \
        [[ -x "$omp_design_path/skills/create-design-md/scripts/validate-design-md.sh" ]] && \
        HOME="$omp_audit_dir" node \
          -e "import('${omp_product_path}/tools/product-runtime.mjs')" >/dev/null 2>&1 && \
        HOME="$omp_audit_dir" python3 \
          "$omp_product_path/skills/prd-from-requirements/scripts/prd-sync.py" \
          --help >/dev/null 2>&1; then
        pass "OMP 隔离安装后的 Product Tool 与 PRD CLI 可真实加载"
      else
        fail "OMP 隔离安装后的 Product Runtime 加载失败"
      fi
    else
      fail "OMP 隔离安装失败"
    fi
    rm -r -- "$omp_audit_dir"
  else
    fail "install smoke 需要 omp 命令"
  fi
fi

if ((failures > 0)); then
  printf '\n可移植性检查失败：%d 项\n' "$failures" >&2
  exit 1
fi

printf '\n可移植性检查通过\n'
