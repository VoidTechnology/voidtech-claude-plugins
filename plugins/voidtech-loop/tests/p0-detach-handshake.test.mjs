// P0-1：两阶段启动。阶段一（prepare）在前台完成全部会失败的准备并回显 run ID；
// 阶段二（__run）经 IPC 握手接管：先移交锁所有权再回执 ready，父进程退出不产生陈旧锁窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { prepareRun } from '../scripts/lib/lifecycle.mjs';
import { readState, inspectLock, releaseLock } from '../scripts/lib/statestore.mjs';
import { preflight } from '../scripts/lib/preflight.mjs';

const LOOP_CLI = fileURLToPath(new URL('../scripts/loop.mjs', import.meta.url));
const PF_OK = preflight().ok;

function withDataRoot(fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  const root = join(mkdtempSync(join(tmpdir(), 'loop-data-')), 'voidtech-loop');
  process.env.CLAUDE_PLUGIN_DATA = root;
  return Promise.resolve(fn(root)).finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(join(root, '..'), { recursive: true, force: true });
  });
}

function makeRepo(progress = 'todo') {
  const repo = mkdtempSync(join(tmpdir(), 'handshake-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', { mode: 0o755 });
  writeFileSync(join(repo, 'progress.txt'), `${progress}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

function simpleSpec(sha) {
  return {
    schema_version: 1,
    goal_id: 'handshake',
    task: 'make done',
    base_commit: sha,
    budgets: { max_iterations: 5 },
    evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 60 }],
  };
}

function spawnController(prep, extraConfig, dataRoot) {
  const child = spawn(process.execPath, [LOOP_CLI, '__run'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataRoot,
      LOOP_RUN_CONFIG: JSON.stringify({ ...prep, ...extraConfig }),
    },
  });
  const handshake = new Promise((res) => {
    const timer = setTimeout(() => res({ ok: false, reason: 'timeout' }), 15_000);
    child.once('message', (m) => { clearTimeout(timer); res(m); });
    child.once('error', (e) => { clearTimeout(timer); res({ ok: false, reason: String(e) }); });
  });
  const exited = new Promise((res) => child.once('exit', (code) => res(code)));
  return { child, handshake, exited };
}

test('P0-1：__run 接管——移交锁所有权、回执 ready、跑到终态并释放锁', async () => {
  await withDataRoot(async (root) => {
    const { repo, sha } = makeRepo();
    const stubDir = mkdtempSync(join(tmpdir(), 'handshake-stub-'));
    const stub = join(stubDir, 's.sh');
    writeFileSync(stub, '#!/bin/bash\necho done > progress.txt\n', { mode: 0o755 });
    try {
      const prep = await prepareRun({ repo, rawSpec: simpleSpec(sha), skipPreflight: true });
      assert.equal(prep.ok, true, JSON.stringify(prep));
      assert.match(prep.runId, /^handshake-/, '阶段一必须产出 run ID');

      const { child, handshake, exited } = spawnController(prep, { overrideArgv: ['bash', stub] }, root);
      const hs = await handshake;
      assert.equal(hs.ok, true, JSON.stringify(hs));
      assert.equal(hs.runId, prep.runId);
      // ready 回执前锁所有权已移交给控制器进程
      const lock = inspectLock(prep.projectDir);
      assert.equal(lock.meta?.pid, child.pid, '锁判活身份应为控制器进程');
      assert.equal(lock.meta?.run_id, prep.runId);

      const code = await exited;
      assert.equal(code, 0);
      const st = readState(prep.stateDir);
      assert.equal(st.state.status, 'EVALS_PASSED');
      assert.equal(inspectLock(prep.projectDir).status, 'free', '终态后锁释放');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

test('P0-1：锁未持有（接管失败）时 __run 回执 error 并以非零退出，不运行控制器', async () => {
  await withDataRoot(async (root) => {
    const { repo, sha } = makeRepo();
    try {
      const prep = await prepareRun({ repo, rawSpec: simpleSpec(sha), skipPreflight: true });
      assert.equal(prep.ok, true);
      releaseLock(prep.projectDir, prep.runId); // 模拟锁在接管前丢失

      const { handshake, exited } = spawnController(prep, { overrideArgv: ['bash', '-c', 'true'] }, root);
      const hs = await handshake;
      assert.equal(hs.ok, false);
      assert.match(hs.reason, /锁接管失败/);
      assert.notEqual(await exited, 0);
      // 接管失败也必须终态化，不能留下永远不推进的 RUNNING
      assert.equal(readState(prep.stateDir).state.status, 'STOPPED');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('P0-1（CLI）：准备阶段失败在前台回显真实错误，退出码非零', { skip: !PF_OK && '环境不满足 preflight，跳过 CLI 集成测试' }, async () => {
  await withDataRoot(async (root) => {
    // progress 已是 done → 基线 all_targets_met → 必须拒绝启动并说明原因，而不是谎报“已启动”
    const { repo } = makeRepo('done');
    try {
      const r = spawnSync(process.execPath, [LOOP_CLI, 'goal', 'noop', '--check', 'bash check.sh', '--max-iterations', '3'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
      });
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /启动失败（baseline）/);
      assert.doesNotMatch(r.stdout, /已在后台启动/, '失败时不得报告“已启动”');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
