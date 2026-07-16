// L5 回归测试（QA 发现）：控制器在终态清理每 run 的 guardDir 临时目录，避免累积泄漏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runControllerLoop } from '../scripts/lib/controller.mjs';
import { createLoopWorktree } from '../scripts/lib/gitops.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'l5-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\n[ "$(cat p.txt 2>/dev/null)" = done ]\n', { mode: 0o755 });
  writeFileSync(join(repo, 'p.txt'), 'todo\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

test('L5: 循环到达终态后清理 guardDir 临时目录', async () => {
  const { repo, sha } = makeRepo();
  const stubDir = mkdtempSync(join(tmpdir(), 'l5-stub-'));
  const stub = join(stubDir, 's.sh');
  writeFileSync(stub, '#!/bin/bash\necho done > p.txt\n', { mode: 0o755 });
  const stateDir = mkdtempSync(join(tmpdir(), 'l5-state-'));
  const v = validateSpecObject({
    schema_version: 1, goal_id: 'l5', task: 't', base_commit: sha,
    budgets: { max_iterations: 3 },
    evals: [{ id: 't', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 30 }],
  });
  const wt = createLoopWorktree(repo, 'l5', sha, {});
  try {
    const final = await runControllerLoop({
      repo, spec: v.normalized, goalHash: v.goal_hash, runId: 'run-l5',
      branch: wt.branch, worktree: wt.path, baseCommit: sha,
      stateDir, evidenceDir: join(stateDir, 'ev'), overrideArgv: ['bash', stub],
    });
    assert.equal(final.status, 'EVALS_PASSED');
    assert.ok(final.guard_dir, 'state 应记录 guard_dir');
    assert.equal(existsSync(final.guard_dir), false, 'guardDir 应在终态被清理');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
