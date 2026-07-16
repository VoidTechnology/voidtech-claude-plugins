// L3 回归测试（QA 发现）：守卫的 git 写检测应覆盖绝对路径调用与更多写子命令。
// best-effort 层；硬边界仍在控制器后置校验，但这些高频绕过应尽量在守卫层拦下。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/hooks/worker-guard.sh', import.meta.url));

function runGuard(command, root) {
  return spawnSync('bash', [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, LOOP_ROOT: root, LOOP_PROTECTED_FILE: '' },
  });
}

test('L3: 之前绕过的 git 写命令现被拦截', () => {
  const root = mkdtempSync(join(tmpdir(), 'l3-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  try {
    for (const cmd of [
      '/usr/bin/git commit -m x',
      'git restore --staged foo',
      'git update-index --add foo',
      'git am < patch.mbox',
      'git apply patch.diff',
    ]) {
      const r = runGuard(cmd, root);
      assert.equal(r.status, 2, `应拦截：${cmd}\nstderr=${r.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L3: 只读 git 与普通命令仍放行（不回归）', () => {
  const root = mkdtempSync(join(tmpdir(), 'l3-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  try {
    for (const cmd of ['git status', 'git log --oneline', 'git diff HEAD', 'npm test', 'ls -la']) {
      const r = runGuard(cmd, root);
      assert.equal(r.status, 0, `不应拦截：${cmd}\nstderr=${r.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
