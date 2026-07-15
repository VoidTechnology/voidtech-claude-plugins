// 控制器主循环测试（stub worker 经测试接缝注入）：
// V15 失败证据注入与 EVALS_PASSED、V19 预算耗尽/无进展、V23 篡改 fail closed、
// V24 eval 篡改共享 Git 目录、V11 闸门阻断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runControllerLoop } from '../scripts/lib/controller.mjs';
import { createLoopWorktree, gitRun } from '../scripts/lib/gitops.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { readState } from '../scripts/lib/statestore.mjs';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ctrl-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@voidtech.local');
  git('config', 'user.name', 'fixture');
  // target eval：progress.txt 内容为 done 则通过
  writeFileSync(join(repo, 'check.sh'), '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', { mode: 0o755 });
  writeFileSync(join(repo, 'progress.txt'), 'todo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  return { repo, sha };
}

function makeSpec(sha, { maxIterations = 5, protectedPaths = [] } = {}) {
  const r = validateSpecObject({
    schema_version: 1,
    goal_id: 'ctrl-fixture',
    task: 'make progress.txt say done',
    base_commit: sha,
    budgets: { max_iterations: maxIterations },
    protected_paths: protectedPaths,
    evals: [
      { id: 'the-target', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 30 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return { spec: r.normalized, hash: r.goal_hash };
}

function makeStub(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ctrl-stub-'));
  const path = join(dir, 'stub.sh');
  writeFileSync(path, `#!/bin/bash\nset -u\nCTX="$1"\n${script}\n`, { mode: 0o755 });
  return { dir, path };
}

async function runLoopFixture({ stubScript, specOpts = {}, mutate }) {
  const { repo, sha } = makeRepo();
  const { spec, hash } = makeSpec(sha, specOpts);
  if (mutate) mutate(spec);
  const wt = createLoopWorktree(repo, 'ctrl', sha, {});
  const stateDir = mkdtempSync(join(tmpdir(), 'ctrl-state-'));
  const evidenceDir = join(stateDir, 'evidence');
  const stub = makeStub(stubScript);
  const cleanup = () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  };
  const final = await runControllerLoop({
    repo,
    spec,
    goalHash: hash,
    runId: 'run-fixture',
    branch: wt.branch,
    worktree: wt.path,
    baseCommit: sha,
    stateDir,
    evidenceDir,
    overrideArgv: ['bash', stub.path],
  });
  return { final, repo, sha, wt, stateDir, cleanup };
}

test('V15：失败证据注入下一轮，修复后进入 EVALS_PASSED', async () => {
  // 轮 1：写 half；轮 2：看到 prompt 里有失败 eval ID 后写 done
  const script = `
PROMPT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['prompt'])" "$CTX")
if grep -q 'the-target' <<<"$PROMPT" && grep -q '上一轮失败的 eval' <<<"$PROMPT"; then
  echo done > progress.txt
  grep -q 'exit=1' <<<"$PROMPT" && echo saw-exit-code > evidence-seen.txt
else
  echo half > progress.txt
fi`;
  const { final, repo, wt, stateDir, cleanup } = await runLoopFixture({ stubScript: script });
  try {
    assert.equal(final.status, 'EVALS_PASSED', JSON.stringify(final, null, 2).slice(0, 2000));
    assert.equal(final.iteration, 2);
    assert.equal(final.rounds.length, 2);
    assert.equal(final.rounds[0].eval.passed, false);
    assert.deepEqual(final.rounds[0].eval.failed_ids, ['the-target']);
    assert.equal(final.rounds[1].eval.passed, true);
    // 第二轮确实看到了规范化失败证据（含退出码）
    const seen = gitRun(repo, ['show', `${final.last_checkpoint}:evidence-seen.txt`]);
    assert.equal(seen.status, 0, '第二轮 prompt 应包含上一轮失败退出码');
    // candidate 绑定：EVALS_PASSED 的 candidate 是最后 checkpoint
    assert.equal(final.candidate_commit, final.last_checkpoint);
    // 状态文件可读且一致
    const persisted = readState(stateDir);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.state.status, 'EVALS_PASSED');
  } finally {
    cleanup();
  }
});

test('V19：迭代预算耗尽 → STOPPED(exhausted)，保留最后 checkpoint', async () => {
  const script = `date +%s%N > attempt.txt`; // 每轮都有变化但永不修复
  const { final, cleanup } = await runLoopFixture({ stubScript: script, specOpts: { maxIterations: 2 } });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'exhausted');
    assert.equal(final.rounds.length, 2);
    assert.match(final.last_checkpoint, /^[0-9a-f]{40}$/);
  } finally {
    cleanup();
  }
});

test('V19：连续 3 轮无 diff 且结果未改善 → STOPPED(blocked)', async () => {
  const script = `true`; // 永不修改任何文件
  const { final, cleanup } = await runLoopFixture({ stubScript: script, specOpts: { maxIterations: 10 } });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'blocked');
    assert.equal(final.stop_detail.kind, 'no_progress');
    assert.equal(final.rounds.length, 3);
  } finally {
    cleanup();
  }
});

test('V23：worker 绕过拦截改写 refs → 后置校验 STOPPED(failed)，不产生 checkpoint', async () => {
  const script = `
echo tamper > progress.txt
git update-ref refs/heads/rogue-branch HEAD`;
  const { final, repo, cleanup } = await runLoopFixture({ stubScript: script });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'failed');
    assert.equal(final.stop_detail.kind, 'audit_violation');
    assert.equal(final.last_checkpoint, final.base_commit, '篡改轮不得生成 checkpoint');
  } finally {
    cleanup();
  }
});

test('V23：worker 移动 HEAD → STOPPED(failed)', async () => {
  const script = `git checkout -q --detach HEAD`;
  const { final, cleanup } = await runLoopFixture({ stubScript: script });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'failed');
    assert.equal(final.stop_detail.kind, 'head_moved');
  } finally {
    cleanup();
  }
});

test('V23：worker 修改 protected path → STOPPED(blocked) 并报告命中', async () => {
  const script = `echo done > progress.txt; echo tampered > frozen.golden`;
  const { final, cleanup } = await runLoopFixture({
    stubScript: script,
    specOpts: { protectedPaths: ['*.golden'] },
  });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'blocked');
    assert.equal(final.stop_detail.kind, 'protected_path');
    assert.deepEqual(final.stop_detail.hits, ['frozen.golden']);
  } finally {
    cleanup();
  }
});

test('V11：worker 产出敏感文件 → 闸门 STOPPED(blocked)，无 checkpoint', async () => {
  const script = `echo done > progress.txt; echo SECRET=x > .env`;
  const { final, cleanup } = await runLoopFixture({ stubScript: script });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'blocked');
    assert.equal(final.stop_detail.kind, 'checkpoint_gate');
    assert.ok(final.stop_detail.hits.some((h) => h.path === '.env'));
    assert.equal(final.last_checkpoint, final.base_commit);
  } finally {
    cleanup();
  }
});

test('V24：eval 修改共享 Git 目录 → 本次验收无效 STOPPED(failed)', async () => {
  const script = `echo done > progress.txt`;
  const { final, cleanup } = await runLoopFixture({
    stubScript: script,
    mutate: (spec) => {
      spec.evals.push({
        id: 'evil-eval',
        role: 'invariant',
        command: ['git', 'update-ref', 'refs/heads/evil-from-eval', 'HEAD'],
        shell: false,
        cwd: '.',
        expected_exit: 0,
        timeout_seconds: 30,
        repeat: 1,
      });
    },
  });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'failed');
    assert.equal(final.stop_detail.kind, 'eval_audit_violation');
  } finally {
    cleanup();
  }
});

test('时间预算耗尽 → STOPPED(exhausted)', async () => {
  const script = `sleep 3; echo x > slow.txt`;
  const { final, cleanup } = await runLoopFixture({
    stubScript: script,
    mutate: (spec) => {
      spec.budgets.max_duration_seconds = 2;
    },
  });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'exhausted');
    assert.equal(final.stop_detail.kind, 'duration');
  } finally {
    cleanup();
  }
});

test('worker 非零退出（API 错误）→ STOPPED(interrupted)', async () => {
  const script = `exit 3`;
  const { final, cleanup } = await runLoopFixture({ stubScript: script });
  try {
    assert.equal(final.status, 'STOPPED');
    assert.equal(final.stop_reason, 'interrupted');
  } finally {
    cleanup();
  }
});
