// L2 回归测试（QA 发现）：cancel 必须及时终止 in-flight worker，而非等到 worker 超时（可长达整个预算）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runWorker } from '../scripts/lib/workerio.mjs';
import { runControllerLoop } from '../scripts/lib/controller.mjs';
import { createLoopWorktree } from '../scripts/lib/gitops.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';

function sleeperStub(seconds) {
  const dir = mkdtempSync(join(tmpdir(), 'l2-stub-'));
  const stub = join(dir, 's.sh');
  const pidFile = join(dir, 'pid');
  writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$$" > "${pidFile}"\nexec sleep ${seconds}\n`, { mode: 0o755 });
  return { dir, pidFile, argv: ['bash', stub] };
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return true;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('L2: shouldStop 期间 runWorker 及时终止 worker（不等超时）', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'l2-wt-'));
  const stub = sleeperStub(30);
  try {
    const start = Date.now();
    const r = await runWorker({ worktree: wt, prompt: 'x', timeoutSeconds: 30, overrideArgv: stub.argv, shouldStop: () => true });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `cancel 应在数秒内生效，实际 ${elapsed}ms`);
    assert.equal(r.ok, false);
    assert.equal(r.canceled, true);
    assert.equal(existsSync(stub.pidFile), true, 'stub 应记录自身 PID');
    const pid = Number(readFileSync(stub.pidFile, 'utf8').trim());
    assert.equal(await waitForProcessExit(pid), true, `worker 进程 ${pid} 应被清理`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('L2: worker 运行期间收到 cancel → 控制器及时 STOPPED(canceled)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'l2-repo-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'x');
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  const stub = sleeperStub(30);
  const stateDir = mkdtempSync(join(tmpdir(), 'l2-state-'));
  const v = validateSpecObject({
    schema_version: 1, goal_id: 'l2', task: 't', base_commit: sha,
    budgets: { max_iterations: 3, max_duration_seconds: 300 },
    evals: [{ id: 't', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 60 }],
  });
  const wt = createLoopWorktree(repo, 'l2', sha, {});
  // 首次（loop 顶部）返回 false，之后（worker 轮询期间）返回 true → 触发 in-flight cancel
  let calls = 0;
  try {
    const start = Date.now();
    const final = await runControllerLoop({
      repo, spec: v.normalized, goalHash: v.goal_hash, runId: 'run-l2',
      branch: wt.branch, worktree: wt.path, baseCommit: sha,
      stateDir, evidenceDir: join(stateDir, 'ev'), overrideArgv: stub.argv,
      shouldStop: () => (++calls > 1),
    });
    const elapsed = Date.now() - start;
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'canceled');
    assert.ok(elapsed < 8000, `应在数秒内收尾，实际 ${elapsed}ms`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
