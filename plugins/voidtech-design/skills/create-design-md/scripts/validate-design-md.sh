#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: validate-design-md.sh path/to/DESIGN.md" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "create-design-md: Node.js and npm are required for official validation" >&2
  exit 2
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 18)); then
  echo "create-design-md: Node.js 18 or newer is required" >&2
  exit 2
fi

target=$1
if [[ ! -f "$target" ]]; then
  echo "create-design-md: target is not a file: $target" >&2
  exit 2
fi

target_dir=$(cd "$(dirname "$target")" && pwd -P)
target_path="$target_dir/$(basename "$target")"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
validator_package_dir="$script_dir/../validator"
if [[ ! -f "$validator_package_dir/package.json" || ! -f "$validator_package_dir/package-lock.json" ]]; then
  echo "create-design-md: bundled validator package metadata is missing" >&2
  exit 2
fi

result_file=$(mktemp "${TMPDIR:-/tmp}/voidtech-design-md-lint.XXXXXX")
install_dir=$(mktemp -d "${TMPDIR:-/tmp}/voidtech-design-md-validator.XXXXXX")
trap 'rm -f "$result_file"; rm -rf "$install_dir"' EXIT

cp "$validator_package_dir/package.json" "$validator_package_dir/package-lock.json" "$install_dir/"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$install_dir" >/dev/null

set +e
"$install_dir/node_modules/.bin/designmd" lint "$target_path" >"$result_file"
lint_status=$?
set -e

cat "$result_file"
if [[ $lint_status -ne 0 ]]; then
  exit "$lint_status"
fi

node - "$result_file" "$target_path" <<'NODE'
const fs = require('node:fs');

const resultPath = process.argv[2];
const targetPath = process.argv[3];
let result;
try {
  result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
} catch (error) {
  console.error(`create-design-md: official lint did not return valid JSON: ${error.message}`);
  process.exit(2);
}

if (!result?.summary || !Number.isInteger(result.summary.errors) ||
    !Number.isInteger(result.summary.warnings)) {
  console.error('create-design-md: official lint JSON is missing integer summary counts');
  process.exit(2);
}

const errors = result.summary.errors;
const warnings = result.summary.warnings;
if (errors !== 0 || warnings !== 0) {
  console.error(`create-design-md: strict lint failed with ${errors} error(s) and ${warnings} warning(s)`);
  process.exit(1);
}

const expectedSections = [
  'Overview',
  'Colors',
  'Typography',
  'Layout',
  'Elevation & Depth',
  'Shapes',
  'Components',
  "Do's and Don'ts",
];
const lines = fs.readFileSync(targetPath, 'utf8').split(/\r?\n/);
const sections = [];
let fence = null;
let inFrontmatter = lines[0] === '---';
for (const [index, line] of lines.entries()) {
  if (index === 0 && inFrontmatter) continue;
  if (inFrontmatter) {
    if (line === '---') inFrontmatter = false;
    continue;
  }

  const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (fenceMatch) {
    const marker = fenceMatch[1];
    if (fence === null) {
      fence = { character: marker[0], length: marker.length };
    } else if (marker[0] === fence.character && marker.length >= fence.length) {
      fence = null;
    }
    continue;
  }
  if (fence !== null) continue;

  const heading = line.match(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
  if (heading) sections.push(heading[1]);
}

if (JSON.stringify(sections) !== JSON.stringify(expectedSections)) {
  console.error(`create-design-md: expected exactly these level-2 sections in order: ${expectedSections.join(' | ')}`);
  console.error(`create-design-md: found: ${sections.join(' | ') || '(none)'}`);
  process.exit(1);
}
NODE
