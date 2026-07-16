// Task 4.2：candidate snapshot 隔离与路径边界（技术设计 §7.5，P2-27）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestRepo } from './helpers.mjs';
import {
  createReviewSnapshot, destroyReviewSnapshot, resolveSnapshotPath, bindSnapshotToManifest,
} from '../scripts/lib/reviewsnapshot.mjs';

function makeRepoWithCandidate({ withSymlink = false } = {}) {
  const fixture = makeTestRepo({
    prefix: 'snapshot-',
    files: { 'src/app.js': 'v1\n', 'docs/readme.md': 'docs\n' },
  });
  const { repo, git } = fixture;
  writeFileSync(join(repo, 'src/app.js'), 'v2\n');
  if (withSymlink) symlinkSync('/etc/hosts', join(repo, 'src/escape-link'));
  git('add', '-A');
  git('commit', '-q', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD').stdout.trim();
  return { repo, git, base: fixture.sha, candidate };
}

test('snapshot 冻结 candidate：用户工作区后续未提交修改不可见', () => {
  const { repo, candidate } = makeRepoWithCandidate();
  let snapshot = null;
  try {
    const created = createReviewSnapshot(repo, candidate);
    assert.equal(created.ok, true, JSON.stringify(created));
    snapshot = created.snapshot;

    // snapshot 后污染用户工作区
    writeFileSync(join(repo, 'src/app.js'), 'DIRTY UNCOMMITTED\n');
    writeFileSync(join(repo, 'src/untracked.js'), 'untracked\n');

    const resolved = resolveSnapshotPath(snapshot, 'src/app.js');
    assert.equal(resolved.ok, true);
    assert.equal(readFileSync(resolved.path, 'utf8'), 'v2\n', '读到的是冻结 candidate 内容');

    // 未提交新文件不在 tracked manifest
    assert.equal(resolveSnapshotPath(snapshot, 'src/untracked.js').reason, 'not_in_manifest');

    // tracked manifest hash 稳定且绑定 manifest 改变 input hash 的前提成立
    assert.deepEqual(snapshot.tracked_files, ['docs/readme.md', 'src/app.js']);
    const bound = bindSnapshotToManifest({ snapshot: { snapshot_id: null, tracked_files_manifest_hash: null } }, snapshot);
    assert.equal(bound.snapshot.snapshot_id, snapshot.snapshot_id);
    assert.equal(bound.snapshot.tracked_files_manifest_hash, snapshot.tracked_files_manifest_hash);
  } finally {
    if (snapshot) destroyReviewSnapshot(snapshot);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('路径边界：绝对路径、..、.git、manifest 外、空段全部拒绝', () => {
  const { repo, candidate } = makeRepoWithCandidate();
  let snapshot = null;
  try {
    snapshot = createReviewSnapshot(repo, candidate).snapshot;
    const cases = [
      ['/etc/passwd', 'absolute_or_backslash'],
      ['..\\x', 'absolute_or_backslash'],
      ['../outside.txt', 'path_traversal'],
      ['src/../../outside.txt', 'path_traversal'],
      ['.git/config', 'path_traversal'],
      ['src//app.js', 'path_traversal'],
      ['nonexistent.js', 'not_in_manifest'],
      ['', 'invalid_path'],
    ];
    for (const [path, reason] of cases) {
      const r = resolveSnapshotPath(snapshot, path);
      assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason }, `path=${JSON.stringify(path)}`);
    }
    // `.` 段规范化后仍可命中 tracked 文件
    assert.equal(resolveSnapshotPath(snapshot, './src/./app.js').ok, true);
  } finally {
    if (snapshot) destroyReviewSnapshot(snapshot);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('symlink 防御：已提交的 symlink 即使指向仓库外也拒绝读取', () => {
  const { repo, candidate } = makeRepoWithCandidate({ withSymlink: true });
  let snapshot = null;
  try {
    snapshot = createReviewSnapshot(repo, candidate).snapshot;
    assert.ok(snapshot.tracked_set.has('src/escape-link'), 'symlink 本身被 git 跟踪');
    const r = resolveSnapshotPath(snapshot, 'src/escape-link');
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'symlink_rejected' });
  } finally {
    if (snapshot) destroyReviewSnapshot(snapshot);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('destroy 清理 worktree；非法 candidate 拒绝创建', () => {
  const { repo, candidate } = makeRepoWithCandidate();
  try {
    const created = createReviewSnapshot(repo, candidate);
    const worktree = created.snapshot.worktree;
    assert.equal(existsSync(worktree), true);
    destroyReviewSnapshot(created.snapshot);
    assert.equal(existsSync(worktree), false);

    assert.equal(createReviewSnapshot(repo, 'deadbeef'.repeat(5)).ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
