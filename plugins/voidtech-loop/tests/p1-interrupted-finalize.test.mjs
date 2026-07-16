// P1-5：任何终止路径都有交接物。
// 陈旧锁接管：旧 run 非终态时落为 STOPPED(interrupted) 并补报告；
// 控制器崩溃：未处理异常也保证写出终态与报告，锁照常释放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLoop, prepareRun, runPreparedLoop, getStatus, finalizeInterruptedRun, failPreparedRun } from '../scripts/lib/lifecycle.mjs';
import { buildInitialState } from '../scripts/lib/controller.mjs';
import { projectDataDir, writeState, readState, acquireLock, inspectLock } from '../scripts/lib/statestore.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { makeTestRepo, withDataRoot } from './helpers.mjs';

function makeRepo() {
  return makeTestRepo({
    prefix: 'finalize-fixture-',
    files: {
      'check.sh': { content: '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', mode: 0o755 },
      'progress.txt': 'todo\n',
    },
  });
}

function fixingStub() {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-stub-'));
  const path = join(dir, 's.sh');
  writeFileSync(path, '#!/bin/bash\necho done > progress.txt\n', { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

function simpleSpec(sha, goalId = 'make-done') {
  return {
    schema_version: 1,
    goal_id: goalId,
    task: 'make done',
    base_commit: sha,
    budgets: { max_iterations: 5 },
    evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 60 }],
  };
}

test('P1-5：陈旧锁接管时旧 run 落为 STOPPED(interrupted) 并生成报告，新 run 正常启动', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = fixingStub();
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      // 模拟崩溃残留：RUNNING 状态的旧 run + 持有者进程已不存在的锁
      const oldRunId = 'old-run-dead';
      const oldStateDir = join(projectDir, 'runs', oldRunId);
      mkdirSync(oldStateDir, { recursive: true });
      writeState(oldStateDir, buildInitialState({
        repo, spec: simpleSpec(sha), goalHash: 'deadbeef', runId: oldRunId,
        branch: 'loop/old', worktree: '/nonexistent', baseCommit: sha,
      }));
      acquireLock(projectDir, { run_id: oldRunId, pid: 2 ** 30, pid_start: 'gone', pid_comm: 'gone' });
      assert.equal(inspectLock(projectDir).status, 'stale', '前置：锁必须呈陈旧');

      const res = await startLoop({ repo, rawSpec: simpleSpec(sha), overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.final.status, 'EVALS_PASSED');

      // 旧 run 被终态化并有交接报告
      const old = readState(oldStateDir);
      assert.equal(old.ok, true);
      assert.equal(old.state.status, 'STOPPED');
      assert.equal(old.state.stop_reason, 'interrupted');
      assert.equal(old.state.stop_detail.kind, 'stale_lock_takeover');
      assert.equal(existsSync(join(oldStateDir, 'report.md')), true, '终态化必须补交接报告');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('P1-5：控制器崩溃时 run 落为 STOPPED(interrupted, controller_crash)，锁释放', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    try {
      const prep = await prepareRun({ repo, rawSpec: simpleSpec(sha, 'crash-run'), skipPreflight: true });
      assert.equal(prep.ok, true, JSON.stringify(prep));
      // 初始状态在 prepare 阶段即落盘，status <runId> 立即可用
      assert.equal(getStatus({ repo, runId: prep.runId }).state.status, 'RUNNING');

      // 注入崩溃：worktree 只读使控制器写入守卫配置时抛出未处理异常
      chmodSync(prep.worktree, 0o555);
      try {
        const res = await runPreparedLoop(prep, { overrideArgv: ['bash', '-c', 'true'] });
        assert.equal(res.ok, false);
        assert.equal(res.stage, 'controller');
      } finally {
        chmodSync(prep.worktree, 0o755);
      }

      const st = readState(prep.stateDir);
      assert.equal(st.ok, true);
      assert.equal(st.state.status, 'STOPPED');
      assert.equal(st.state.stop_reason, 'interrupted');
      assert.equal(st.state.stop_detail.kind, 'controller_crash');
      assert.equal(existsSync(join(prep.stateDir, 'report.md')), true, '崩溃路径必须留下交接报告');
      assert.equal(inspectLock(prep.projectDir).status, 'free', '崩溃后锁必须释放');

      // 终态化幂等：不覆盖已有终态
      const again = finalizeInterruptedRun(prep.stateDir, { kind: 'noop' });
      assert.equal(again.already, true);
      assert.equal(readState(prep.stateDir).state.stop_detail.kind, 'controller_crash');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('P1-5：循环 setup 失败时已落初始状态，并统一终态化且保留排查现场', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const once = join(mkdtempSync(join(tmpdir(), 'setup-once-')), 'ran');
    try {
      const spec = {
        ...simpleSpec(sha, 'setup-fails-warm'),
        setup: [`if [ -e "${once}" ]; then exit 9; else touch "${once}"; fi`],
      };
      const res = await prepareRun({ repo, rawSpec: spec, skipPreflight: true });
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'setup');
      assert.ok(res.runId && res.stateDir && res.worktree, JSON.stringify(res));

      const st = readState(res.stateDir);
      assert.equal(st.ok, true);
      assert.equal(st.state.status, 'STOPPED');
      assert.equal(st.state.stop_reason, 'interrupted');
      assert.equal(st.state.stop_detail.kind, 'setup_failed');
      assert.equal(existsSync(join(res.stateDir, 'report.md')), true);
      assert.equal(existsSync(res.worktree), true, '失败现场 worktree 应保留供排查');
      assert.equal(inspectLock(res.projectDir).status, 'free');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(join(once, '..'), { recursive: true, force: true });
    }
  });
});

test('P1-5：握手失败统一终态化 prepared run 并释放锁', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    try {
      const prep = await prepareRun({ repo, rawSpec: simpleSpec(sha, 'handshake-fails'), skipPreflight: true });
      assert.equal(prep.ok, true, JSON.stringify(prep));

      const failed = failPreparedRun(prep, { kind: 'handshake_failed', reason: 'timeout' });
      assert.equal(failed.ok, true);
      const st = readState(prep.stateDir);
      assert.equal(st.state.status, 'STOPPED');
      assert.equal(st.state.stop_detail.kind, 'handshake_failed');
      assert.equal(existsSync(join(prep.stateDir, 'report.md')), true);
      assert.equal(inspectLock(prep.projectDir).status, 'free');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
