// P0-2：取消信号与墙钟 deadline 贯穿 eval 全链路。
// 之前 runEvalPack 不接收取消信号，cancel 在 VERIFYING 阶段只能等当前 Eval Pack 自然结束；
// 墙钟预算只在轮次间检查，长 eval 可显著超过 max_duration_seconds。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runEvalPack } from '../scripts/lib/evalrunner.mjs';
import { startLoop } from '../scripts/lib/lifecycle.mjs';

function withDataRoot(fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  const root = mkdtempSync(join(tmpdir(), 'loop-data-'));
  process.env.CLAUDE_PLUGIN_DATA = root;
  return Promise.resolve(fn(root)).finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(root, { recursive: true, force: true });
  });
}

function makeRepo(checkScript) {
  const repo = mkdtempSync(join(tmpdir(), 'cancel-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  writeFileSync(join(repo, 'check.sh'), checkScript, { mode: 0o755 });
  writeFileSync(join(repo, 'progress.txt'), 'todo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

function slowEvalSpec(sha) {
  return {
    goal_id: 'slow',
    base_commit: sha,
    protected_paths: [],
    evals: [{ id: 'slow', role: 'target', command: ['sleep', '47'], shell: false, cwd: '.', expected_exit: 0, repeat: 1, timeout_seconds: 120 }],
  };
}

test('P0-2：deadline 截断 in-flight eval，墙钟成为硬上限', async () => {
  const { repo, sha } = makeRepo('#!/bin/bash\ntrue\n');
  try {
    const t0 = Date.now();
    const verdict = await runEvalPack(slowEvalSpec(sha), {
      repo, candidateSha: sha, goalHash: 'x', evidenceDir: null,
      deadlineAt: Date.now() + 1000,
    });
    const elapsed = Date.now() - t0;
    assert.equal(verdict.passed, false);
    assert.equal(verdict.results[0].timed_out, true, JSON.stringify(verdict.results[0]));
    assert.equal(verdict.results[0].runs[0].deadline_exceeded, true, 'deadline 截断应与 eval 自身超时可区分');
    assert.ok(elapsed < 10_000, `deadline+1s 应在数秒内截断，实际 ${elapsed}ms`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0-2：deadline 已过时不再启动后续 eval', async () => {
  const { repo, sha } = makeRepo('#!/bin/bash\ntrue\n');
  try {
    const verdict = await runEvalPack(slowEvalSpec(sha), {
      repo, candidateSha: sha, goalHash: 'x', evidenceDir: null,
      deadlineAt: Date.now() - 1,
    });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.results[0].runs[0].duration_ms, 0, '不应实际派生子进程');
    assert.equal(verdict.results[0].runs[0].deadline_exceeded, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0-2：取消信号在 eval 运行中到达时，in-flight 子进程组被及时终止', async () => {
  const { repo, sha } = makeRepo('#!/bin/bash\ntrue\n');
  try {
    const t0 = Date.now();
    const verdict = await runEvalPack(slowEvalSpec(sha), {
      repo, candidateSha: sha, goalHash: 'x', evidenceDir: null,
      shouldStop: () => Date.now() - t0 > 500,
    });
    const elapsed = Date.now() - t0;
    assert.equal(verdict.passed, false);
    assert.equal(verdict.results[0].runs[0].canceled, true, JSON.stringify(verdict.results[0]));
    assert.ok(elapsed < 10_000, `取消应在数秒内生效，实际 ${elapsed}ms`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0-2：cancel 在 VERIFYING 阶段生效，run 收尾为 STOPPED(canceled)', async () => {
  await withDataRoot(async () => {
    // 基线时 progress=todo 快速失败（startable）；worker 写 done 后 eval 进入长 sleep，取消在此期间到达
    // sleep 时长刻意避开 30：l2 测试用全局 pgrep -f "sleep 30" 断言进程组清理，并发撞名会误报残留
    const { repo, sha } = makeRepo('#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ] || exit 1\nsleep 47\n');
    const stubDir = mkdtempSync(join(tmpdir(), 'cancel-stub-'));
    const stub = join(stubDir, 's.sh');
    writeFileSync(stub, '#!/bin/bash\necho done > progress.txt\n', { mode: 0o755 });
    try {
      const spec = {
        schema_version: 1,
        goal_id: 'cancel-verify',
        task: 'cancel during verifying',
        base_commit: sha,
        budgets: { max_iterations: 3 },
        evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 120 }],
      };
      const t0 = Date.now();
      const res = await startLoop({
        repo, rawSpec: spec, overrideArgv: ['bash', stub], skipPreflight: true,
        shouldStop: () => Date.now() - t0 > 2000,
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.final.status, 'STOPPED');
      assert.equal(res.final.stop_reason, 'canceled');
      assert.ok(elapsed < 20_000, `VERIFYING 期取消应及时收尾，实际 ${elapsed}ms`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
