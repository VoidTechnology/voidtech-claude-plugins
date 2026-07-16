// P0-3：spec.setup 真实接入生命周期——基线 worktree、循环 worktree（warm）与每次 eval 的
// 一次性 worktree 都先执行 setup；环境失败按 infra/setup_failed 上报，不得混入“目标未满足”。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { startLoop } from '../scripts/lib/lifecycle.mjs';

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

// setup 产物（setup-marker.txt）入 .gitignore：真实项目的依赖目录（node_modules）同样被忽略，
// warm setup 的产物才不会被当作 worker 变更进入 checkpoint。
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'setup-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  writeFileSync(join(repo, '.gitignore'), 'setup-marker.txt\n');
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\n[ -f setup-marker.txt ] && [ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', { mode: 0o755 });
  writeFileSync(join(repo, 'progress.txt'), 'todo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

function fixingStub() {
  const dir = mkdtempSync(join(tmpdir(), 'setup-stub-'));
  const path = join(dir, 's.sh');
  writeFileSync(path, '#!/bin/bash\necho done > progress.txt\n', { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

function specWithSetup(sha, setup) {
  return {
    schema_version: 1,
    goal_id: 'setup-wire',
    task: 'make done（依赖 setup 产物）',
    base_commit: sha,
    budgets: { max_iterations: 5 },
    setup,
    evals: [
      // invariant 依赖 setup 产物：若基线 worktree 没跑 setup，基线会以 invariant_broken 拒绝启动
      { id: 'marker-exists', role: 'invariant', command: ['test', '-f', 'setup-marker.txt'], timeout_seconds: 60 },
      { id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 60 },
    ],
  };
}

test('P0-3：setup 在基线、循环 worktree 与 eval worktree 三处都生效，循环可走到 EVALS_PASSED', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = fixingStub();
    try {
      const res = await startLoop({ repo, rawSpec: specWithSetup(sha, ['echo ok > setup-marker.txt']), overrideArgv: stub.argv, skipPreflight: true });
      // 基线：setup 产出 marker → invariant 成立、target 未满足 → startable；
      // eval worktree：干净检出后 setup 再次产出 marker → 全部通过
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.final.status, 'EVALS_PASSED');
      // warm setup：循环 worktree 内产物存在（且因 .gitignore 未进 checkpoint）
      assert.equal(existsSync(join(res.worktree, 'setup-marker.txt')), true, '循环 worktree 应有 warm setup 产物');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('P0-3：setup 命令失败按环境错误上报（infra_error），不误判为目标未满足', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    try {
      const res = await startLoop({ repo, rawSpec: specWithSetup(sha, ['exit 7']), overrideArgv: ['bash', '-c', 'true'], skipPreflight: true });
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'baseline');
      assert.equal(res.verdict, 'infra_error');
      assert.match(res.message, /setup/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
