// baseline 集成测试：真实 git fixture 仓库，覆盖 PRD V4 三类裁定与超时进程组清理（V16 的 eval 部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { runBaseline } from '../scripts/lib/baseline.mjs';
import { makeTestRepo } from './helpers.mjs';

function makeFixtureRepo({ targetExit, invariantExit }) {
  return makeTestRepo({
    prefix: 'goal-spec-fixture-',
    files: {
      'target.sh': { content: `#!/bin/bash\nexit ${targetExit}\n`, mode: 0o755 },
      'invariant.sh': { content: `#!/bin/bash\nexit ${invariantExit}\n`, mode: 0o755 },
    },
  });
}

function makeSpec(sha) {
  const result = validateSpecObject({
    schema_version: 1,
    goal_id: 'fixture',
    task: 'baseline fixture',
    base_commit: sha,
    budgets: { max_iterations: 5 },
    evals: [
      { id: 'the-target', role: 'target', command: ['bash', 'target.sh'], timeout_seconds: 30 },
      { id: 'the-invariant', role: 'invariant', command: ['bash', 'invariant.sh'], timeout_seconds: 30 },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.normalized;
}

test('V4：target 未满足且 invariant 成立 → startable', async () => {
  const { repo, sha } = makeFixtureRepo({ targetExit: 1, invariantExit: 0 });
  try {
    const report = await runBaseline(makeSpec(sha), { repo });
    assert.equal(report.verdict, 'startable', report.message);
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('V4：全部 target 已满足 → all_targets_met（拒绝启动）', async () => {
  const { repo, sha } = makeFixtureRepo({ targetExit: 0, invariantExit: 0 });
  try {
    const report = await runBaseline(makeSpec(sha), { repo });
    assert.equal(report.verdict, 'all_targets_met', report.message);
    assert.equal(report.exitCode, 3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('V4：invariant 基线不成立 → invariant_broken（拒绝启动）', async () => {
  const { repo, sha } = makeFixtureRepo({ targetExit: 1, invariantExit: 1 });
  try {
    const report = await runBaseline(makeSpec(sha), { repo });
    assert.equal(report.verdict, 'invariant_broken', report.message);
    assert.equal(report.exitCode, 4);
    assert.ok(report.message.includes('the-invariant'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('eval 在一次性 worktree 运行，不落在用户工作区', async () => {
  const { repo, sha } = makeFixtureRepo({ targetExit: 1, invariantExit: 0 });
  try {
    const spec = makeSpec(sha);
    spec.evals[1].command = ['bash', '-c', 'touch verify-side-effect.txt'];
    spec.evals[1].expected_exit = 0;
    const report = await runBaseline(spec, { repo });
    assert.equal(report.verdict, 'startable');
    const check = spawnSync('ls', [join(repo, 'verify-side-effect.txt')], { encoding: 'utf8' });
    assert.notEqual(check.status, 0, 'eval 副作用不应出现在原仓库工作区');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('超时：eval 超时进入 timeout 裁定，且派生子进程被进程组清理', async () => {
  const { repo, sha } = makeFixtureRepo({ targetExit: 1, invariantExit: 0 });
  try {
    const spec = makeSpec(sha);
    const marker = `goal-spec-timeout-${process.pid}`;
    spec.evals[0].command = ['bash', '-c', `sleep 300 & echo ${marker}; wait`];
    spec.evals[0].timeout_seconds = 1;
    const started = Date.now();
    const report = await runBaseline(spec, { repo });
    const elapsed = Date.now() - started;
    assert.equal(report.verdict, 'timeout', report.message);
    assert.equal(report.exitCode, 5);
    assert.ok(elapsed < 20000, `超时处理耗时异常：${elapsed}ms`);
    await new Promise((r) => setTimeout(r, 2500));
    const leftover = spawnSync('pgrep', ['-f', 'sleep 300'], { encoding: 'utf8' });
    assert.notEqual(leftover.status, 0, '进程组内的 sleep 应被清理');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('base_commit 无法解析 → exit 1', async () => {
  const { repo } = makeFixtureRepo({ targetExit: 1, invariantExit: 0 });
  try {
    const report = await runBaseline(makeSpec('deadbeefdeadbeef'), { repo });
    assert.equal(report.verdict, 'invalid_base');
    assert.equal(report.exitCode, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
