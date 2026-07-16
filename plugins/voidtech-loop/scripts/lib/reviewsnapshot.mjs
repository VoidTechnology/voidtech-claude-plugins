// Candidate snapshot 与路径边界（二期技术设计 §7.5，Task 4.2，P2-27）。
// review 开始时对冻结 candidate SHA 创建 detached 一次性 worktree，生成 tracked-files
// manifest；整个 session 只使用同一 snapshot。reviewer 看不到：用户当前工作区的未提交
// 修改、其他 worktree、home、插件数据目录、`.git`/refs/锁文件、manifest 外文件。
// 安全由本层实现而非依赖 worktree 隔离：路径规范化、symlink 拒绝、realpath 逃逸防御。

import { mkdtempSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gitRun, resolveCommit } from './gitops.mjs';
import { artifactHash } from './reviewstore.mjs';

export function createReviewSnapshot(repo, candidate) {
  const resolved = resolveCommit(repo, candidate);
  if (!resolved.ok) return { ok: false, reason: 'invalid_candidate' };

  const parent = mkdtempSync(join(tmpdir(), 'loop-review-snapshot-'));
  const worktree = join(parent, 'snapshot');
  const added = gitRun(repo, ['worktree', 'add', '--detach', worktree, resolved.sha]);
  if (added.status !== 0) {
    rmSync(parent, { recursive: true, force: true });
    return { ok: false, reason: 'worktree_failed', detail: added.stderr };
  }

  const listed = gitRun(worktree, ['ls-files', '-z']);
  if (listed.status !== 0) {
    destroyWorktree(repo, worktree, parent);
    return { ok: false, reason: 'ls_files_failed', detail: listed.stderr };
  }
  const trackedFiles = listed.stdout.split('\0').filter(Boolean).sort();

  return {
    ok: true,
    snapshot: {
      snapshot_id: `snapshot-${randomBytes(6).toString('hex')}`,
      repo,
      commit: resolved.sha,
      worktree,
      parent_dir: parent,
      tracked_files: trackedFiles,
      tracked_set: new Set(trackedFiles),
      tracked_files_manifest_hash: artifactHash(trackedFiles),
    },
  };
}

function destroyWorktree(repo, worktree, parent) {
  gitRun(repo, ['worktree', 'remove', '--force', worktree]);
  rmSync(parent, { recursive: true, force: true });
}

// 清理约束（§7.5）：session 完成或取消、且无活动 retrieval 后由调用方（session 编排层）调用。
export function destroyReviewSnapshot(snapshot) {
  destroyWorktree(snapshot.repo, snapshot.worktree, snapshot.parent_dir);
  return { ok: true };
}

// 把 snapshot 身份绑定进 Fact Pack manifest：绑定后 input_manifest_hash 随之变化，
// proposal 引用的是绑定后的 hash（§7.1）。
export function bindSnapshotToManifest(manifest, snapshot) {
  return {
    ...manifest,
    snapshot: {
      snapshot_id: snapshot.snapshot_id,
      tracked_files_manifest_hash: snapshot.tracked_files_manifest_hash,
    },
  };
}

// 路径解析的唯一入口：所有 read/search/list 都必须经过这里。
// 拒绝：绝对路径、反斜杠、空段/`..`/`.git` 段、manifest 外文件、symlink、realpath 逃逸。
export function resolveSnapshotPath(snapshot, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { ok: false, reason: 'invalid_path' };
  }
  if (isAbsolute(requestedPath) || requestedPath.includes('\\')) {
    return { ok: false, reason: 'absolute_or_backslash' };
  }
  const segments = requestedPath.split('/');
  if (segments.some((s) => s === '' || s === '..' || s === '.git')) {
    return { ok: false, reason: 'path_traversal' };
  }
  const normalized = segments.filter((s) => s !== '.').join('/');
  if (!snapshot.tracked_set.has(normalized)) {
    return { ok: false, reason: 'not_in_manifest' };
  }
  const full = join(snapshot.worktree, normalized);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: 'symlink_rejected' };
  }
  let real;
  let root;
  try {
    real = realpathSync(full);
    root = realpathSync(snapshot.worktree);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return { ok: false, reason: 'escapes_snapshot' };
  }
  return { ok: true, path: full, relative: normalized, size: st.size };
}
