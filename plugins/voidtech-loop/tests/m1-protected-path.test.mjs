// M1 回归测试（QA 发现）：控制器为 worker 注入的 .claude/settings.json 不得被 protected-path 检查误判。
// 缺陷：checkpointGate/checkpoint 对 ['.claude'] 做了 exclude，唯独 protectedPathsHits 没传 exclude，
// 于是当用户 protected_paths 能匹配到 .claude/settings.json（如 *.json）时，控制器第 1 轮就
// 误报 STOPPED(blocked, protected_path)，且命中的是循环自身的基础设施文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runControllerLoop } from '../scripts/lib/controller.mjs';
import { createLoopWorktree } from '../scripts/lib/gitops.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'm1-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  // target：marker.txt 内容为 done 才通过；worker 改 marker.txt（非 *.json）
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\n[ "$(cat marker.txt 2>/dev/null)" = "done" ]\n', { mode: 0o755 });
  writeFileSync(join(repo, 'marker.txt'), 'todo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

test('M1: protected_paths 含 *.json 时，控制器不因自身注入的 .claude/settings.json 误停', async () => {
  const { repo, sha } = makeRepo();
  const stubDir = mkdtempSync(join(tmpdir(), 'm1-stub-'));
  const stub = join(stubDir, 's.sh');
  writeFileSync(stub, '#!/bin/bash\necho done > marker.txt\n', { mode: 0o755 });
  const stateDir = mkdtempSync(join(tmpdir(), 'm1-state-'));

  const v = validateSpecObject({
    schema_version: 1,
    goal_id: 'm1',
    task: 'make marker done',
    base_commit: sha,
    budgets: { max_iterations: 3 },
    protected_paths: ['*.json'], // 能匹配到控制器注入的 .claude/settings.json
    evals: [{ id: 'the-target', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 30 }],
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const wt = createLoopWorktree(repo, 'm1', sha, {});

  try {
    const final = await runControllerLoop({
      repo, spec: v.normalized, goalHash: v.goal_hash, runId: 'run-m1',
      branch: wt.branch, worktree: wt.path, baseCommit: sha,
      stateDir, evidenceDir: join(stateDir, 'ev'),
      overrideArgv: ['bash', stub],
    });
    assert.notEqual(
      final.stop_detail?.kind, 'protected_path',
      `不得因 .claude/settings.json 误报 protected_path；实际 stop_detail=${JSON.stringify(final.stop_detail)}`,
    );
    assert.equal(final.status, 'EVALS_PASSED', `应正常完成；实际 ${final.status}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('M1: 用户真实 protected path 仍被正确拦截（不回归）', async () => {
  const { repo, sha } = makeRepo();
  const stubDir = mkdtempSync(join(tmpdir(), 'm1-stub-'));
  const stub = join(stubDir, 's.sh');
  // worker 改动真正受保护的 fixtures/ 资产
  writeFileSync(stub, '#!/bin/bash\nmkdir -p fixtures\necho tampered > fixtures/frozen.txt\necho done > marker.txt\n', { mode: 0o755 });
  const stateDir = mkdtempSync(join(tmpdir(), 'm1-state-'));

  const v = validateSpecObject({
    schema_version: 1,
    goal_id: 'm1b',
    task: 'x',
    base_commit: sha,
    budgets: { max_iterations: 3 },
    protected_paths: ['fixtures/**'],
    evals: [{ id: 't', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 30 }],
  });
  const wt = createLoopWorktree(repo, 'm1b', sha, {});
  try {
    const final = await runControllerLoop({
      repo, spec: v.normalized, goalHash: v.goal_hash, runId: 'run-m1b',
      branch: wt.branch, worktree: wt.path, baseCommit: sha,
      stateDir, evidenceDir: join(stateDir, 'ev'),
      overrideArgv: ['bash', stub],
    });
    assert.equal(final.stop_detail?.kind, 'protected_path', '改动真实 protected path 必须被拦截');
    assert.deepEqual(final.stop_detail.hits, ['fixtures/frozen.txt']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
