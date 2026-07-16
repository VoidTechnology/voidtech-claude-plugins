// M5 回归测试（QA 发现）：worker-guard.sh 不得依赖未声明的 python3。
// 缺陷：守卫用 python3 做 realpath 规范化，但 preflight 只查 git/jq/claude/node。python3 缺失时
// realpath 返回空串 → 所有 Write/Edit 一律被拒（连合法的 worktree 内写入也拒），路径限制被架空。
// node 已是硬依赖，守卫应改用 node 或纯 shell 做路径规范化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/hooks/worker-guard.sh', import.meta.url));

// 用一个必然失败的 python3 遮蔽真实 python3，模拟“python3 不可用”
function makeBrokenPythonPath() {
  const dir = mkdtempSync(join(tmpdir(), 'm5-nopy-'));
  writeFileSync(join(dir, 'python3'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  return { dir, PATH: `${dir}:${process.env.PATH}` };
}

function runGuard(toolName, toolInput, { root, PATH }) {
  return spawnSync('bash', [GUARD], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, PATH, LOOP_ROOT: root, LOOP_PROTECTED_FILE: '' },
  });
}

test('M5: python3 不可用时，合法的 worktree 内写入仍被放行', () => {
  const root = mkdtempSync(join(tmpdir(), 'm5-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const py = makeBrokenPythonPath();
  try {
    const r = runGuard('Write', { file_path: join(root, 'src/app.js') }, { root, PATH: py.PATH });
    assert.equal(r.status, 0, `python3 缺失时不应误拒合法写入；stderr=${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(py.dir, { recursive: true, force: true });
  }
});

test('M5: python3 不可用时，越界写入仍被正确拦截（路径逻辑不依赖 python3）', () => {
  const root = mkdtempSync(join(tmpdir(), 'm5-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const py = makeBrokenPythonPath();
  try {
    const r = runGuard('Write', { file_path: '/etc/passwd' }, { root, PATH: py.PATH });
    assert.equal(r.status, 2, `越界写入必须被拦截；stderr=${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(py.dir, { recursive: true, force: true });
  }
});
