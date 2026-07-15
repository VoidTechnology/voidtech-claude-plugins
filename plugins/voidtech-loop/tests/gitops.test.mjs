// gitops 测试：V11（checkpoint 闸门）、V12（临时 index checkpoint 不执行 hooks/无空 commit）、
// 审计集快照比对（V23 机制）、protected paths 匹配与循环分支碰撞处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  gitRun,
  createLoopWorktree,
  removeWorktree,
  auditSnapshot,
  compareAudit,
  headIdentity,
  checkpointGate,
  checkpoint,
  protectedPathsHits,
} from '../scripts/lib/gitops.mjs';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'gitops-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@voidtech.local');
  git('config', 'user.name', 'fixture');
  writeFileSync(join(repo, 'app.txt'), 'v1\n');
  mkdirSync(join(repo, 'tests/acceptance'), { recursive: true });
  writeFileSync(join(repo, 'tests/acceptance/contract.txt'), 'frozen\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  return { repo, sha, git };
}

test('createLoopWorktree：唯一分支 + detach worktree；分支碰撞时重新生成', () => {
  const { repo, sha, git } = makeRepo();
  try {
    git('branch', 'loop/demo-fixed');
    const wt = createLoopWorktree(repo, 'demo', sha, { shortId: () => 'fixed' });
    assert.notEqual(wt.branch, 'loop/demo-fixed', '碰撞时必须重新生成 short-id');
    assert.ok(wt.branch.startsWith('loop/demo-'));
    assert.ok(existsSync(join(wt.path, 'app.txt')));
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('V12：checkpoint 使用临时 index——工作树为准、不执行仓库 hooks、无变更不产生空 commit', () => {
  const { repo, sha } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    // 安装会留痕的 hooks（若被执行则写 marker）
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    for (const h of ['pre-commit', 'post-commit', 'commit-msg']) {
      writeFileSync(join(hooksDir, h), `#!/bin/bash\ntouch ${join(repo, `hook-ran-${h}`)}\n`, { mode: 0o755 });
    }
    // worker 毒化 per-worktree index：把 app.txt 暂存为假内容，但工作树是真内容
    writeFileSync(join(wt.path, 'app.txt'), 'poisoned-staged\n');
    spawnSync('git', ['-C', wt.path, 'add', 'app.txt'], { encoding: 'utf8' });
    writeFileSync(join(wt.path, 'app.txt'), 'working-tree-truth\n');

    const r1 = checkpoint(repo, wt.path, wt.branch, sha, 'loop: iteration 1');
    assert.equal(r1.no_change, undefined);
    assert.match(r1.sha, /^[0-9a-f]{40}$/);
    const content = gitRun(repo, ['show', `${r1.sha}:app.txt`]).stdout;
    assert.equal(content, 'working-tree-truth\n', 'checkpoint 必须以工作树为准，不信任 worker 留下的 index');
    for (const h of ['pre-commit', 'post-commit', 'commit-msg']) {
      assert.ok(!existsSync(join(repo, `hook-ran-${h}`)), `checkpoint 不得执行仓库 hook：${h}`);
    }
    const parent = gitRun(repo, ['rev-parse', `${r1.sha}^`]).stdout.trim();
    assert.equal(parent, sha);

    // 无变更轮次：no_change，分支不动
    const r2 = checkpoint(repo, wt.path, wt.branch, r1.sha, 'loop: iteration 2');
    assert.equal(r2.no_change, true);
    const tip = gitRun(repo, ['rev-parse', wt.branch]).stdout.trim();
    assert.equal(tip, r1.sha, '无变更不得产生空 commit');
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkpoint CAS：分支被并发移动时拒绝而不是覆盖', () => {
  const { repo, sha, git } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    // 模拟并发篡改：分支被直接指到另一个 commit
    writeFileSync(join(repo, 'app.txt'), 'v2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'external');
    const external = git('rev-parse', 'HEAD').stdout.trim();
    gitRun(repo, ['update-ref', `refs/heads/${wt.branch}`, external]);

    writeFileSync(join(wt.path, 'app.txt'), 'worker-change\n');
    const r = checkpoint(repo, wt.path, wt.branch, sha, 'loop: iteration 1');
    assert.equal(r.error, 'ref_moved', JSON.stringify(r));
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('V11：敏感文件名与大文件闸门；模板文件例外', () => {
  const { repo, sha } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    writeFileSync(join(wt.path, '.env'), 'SECRET=1\n');
    writeFileSync(join(wt.path, '.env.example'), 'SECRET=fill-me\n');
    writeFileSync(join(wt.path, 'key.pem'), 'x\n');
    writeFileSync(join(wt.path, 'big.bin'), Buffer.alloc(11 * 1024 * 1024));
    writeFileSync(join(wt.path, 'normal.txt'), 'ok\n');

    const gate = checkpointGate(wt.path, sha);
    assert.equal(gate.ok, false);
    const hitPaths = gate.hits.map((h) => h.path).sort();
    assert.deepEqual(hitPaths, ['.env', 'big.bin', 'key.pem'], JSON.stringify(gate.hits));
    const rules = Object.fromEntries(gate.hits.map((h) => [h.path, h.rule]));
    assert.equal(rules['big.bin'], 'max_size');
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('protected paths：gitignore 语义匹配变更路径', () => {
  const { repo, sha } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    writeFileSync(join(wt.path, 'tests/acceptance/contract.txt'), 'tampered\n');
    writeFileSync(join(wt.path, 'app.txt'), 'legit change\n');
    writeFileSync(join(wt.path, 'newfile.txt'), 'new\n');

    const hits = protectedPathsHits(wt.path, sha, ['tests/acceptance/**']);
    assert.deepEqual(hits, ['tests/acceptance/contract.txt']);

    const noPatterns = protectedPathsHits(wt.path, sha, []);
    assert.deepEqual(noPatterns, []);
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('审计集：gitdir 文件篡改与本地 ref 变化 → violation；remotes 纯前进 → 仅记录', () => {
  const { repo, sha, git } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    const before = auditSnapshot(repo, [wt.path]);

    // 1) 无变化 → ok
    let cmp = compareAudit(repo, before, auditSnapshot(repo, [wt.path]));
    assert.equal(cmp.ok, true, JSON.stringify(cmp.violations));

    // 2) 模拟 remotes 纯前进：origin/main 从 base 前进到新 commit
    gitRun(repo, ['update-ref', 'refs/remotes/origin/main', sha]);
    const withRemote = auditSnapshot(repo, [wt.path]);
    writeFileSync(join(repo, 'app.txt'), 'v2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'advance');
    const advanced = git('rev-parse', 'HEAD').stdout.trim();
    git('reset', '-q', '--hard', sha);
    gitRun(repo, ['update-ref', 'refs/remotes/origin/main', advanced]);
    cmp = compareAudit(repo, withRemote, auditSnapshot(repo, [wt.path]));
    assert.equal(cmp.ok, true, JSON.stringify(cmp.violations));
    assert.equal(cmp.recorded.length >= 1, true, 'remotes 前进应被记录');

    // 3) 本地分支被移动 → violation
    const tampered = auditSnapshot(repo, [wt.path]);
    gitRun(repo, ['update-ref', 'refs/heads/rogue', sha]);
    cmp = compareAudit(repo, tampered, auditSnapshot(repo, [wt.path]));
    assert.equal(cmp.ok, false);

    // 4) .git/config 被篡改 → violation
    const before4 = auditSnapshot(repo, [wt.path]);
    writeFileSync(join(repo, '.git', 'config'), readFileSync(join(repo, '.git', 'config'), 'utf8') + '[core]\n\tfsmonitor = /tmp/evil\n');
    cmp = compareAudit(repo, before4, auditSnapshot(repo, [wt.path]));
    assert.equal(cmp.ok, false);
    assert.ok(cmp.violations.some((v) => v.kind === 'gitdir'), JSON.stringify(cmp.violations));
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('headIdentity：分支身份与 SHA 两元组，可检出 detach 与移动', () => {
  const { repo, sha } = makeRepo();
  try {
    const wt = createLoopWorktree(repo, 'demo', sha, {});
    const id1 = headIdentity(wt.path);
    assert.equal(id1.branch, `refs/heads/${wt.branch}`);
    assert.equal(id1.sha, sha);
    spawnSync('git', ['-C', wt.path, 'checkout', '-q', '--detach'], { encoding: 'utf8' });
    const id2 = headIdentity(wt.path);
    assert.equal(id2.branch, null, 'detach 后分支身份应为 null');
    removeWorktree(repo, wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
