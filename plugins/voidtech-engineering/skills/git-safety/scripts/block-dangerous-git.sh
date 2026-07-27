#!/usr/bin/env bash

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq is required to inspect Claude Code hook input." >&2
  exit 2
fi

INPUT=$(cat)
if ! COMMAND=$(printf '%s' "$INPUT" | jq -er '.tool_input.command | strings'); then
  echo "BLOCKED: hook input does not contain a Bash command." >&2
  exit 2
fi

DANGEROUS_PATTERNS=(
  "git([[:space:]]+[^[:space:];&|]+)*[[:space:]]+push([[:space:]]|$)"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s' "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

exit 0
