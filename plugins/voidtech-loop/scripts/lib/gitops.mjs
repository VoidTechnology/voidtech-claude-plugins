// Git 操作层（技术设计 §6）：加固包装、循环分支/worktree、审计集快照、
// 临时 index checkpoint（CAS update-ref）、checkpoint 闸门与 protected paths 匹配。
// 所有 git 调用统一走加固配置：防止仓库内配置（fsmonitor/hooksPath/filter）借控制器权限执行代码。

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync, lstatSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EMPTY_HOOKS = mkdtempSync(join(tmpdir(), 'loop-empty-hooks-'));
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// 敏感文件名黑名单与模板例外（PRD 5.4）
const SENSITIVE_BASENAMES = [
  { rule: 'env_file', test: (base) => base === '.env' || (base.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(base)) },
  { rule: 'key_material', test: (base) => /\.(pem|key|p12|pfx)$/.test(base) },
];

function hardenedArgs() {
  return [
    '-c', 'core.fsmonitor=',
    '-c', `core.hooksPath=${EMPTY_HOOKS}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', 'user.name=voidtech-loop',
    '-c', 'user.email=loop@voidtech.local',
  ];
}

function gitEnv(extra = {}) {
  const env = { GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 控制器 git 调用同样断开全局配置；身份由 hardenedArgs 显式提供
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return { ...env, ...extra };
}

export function gitRun(cwdRepo, args, extraEnv = {}) {
  return spawnSync('git', ['-C', cwdRepo, ...hardenedArgs(), ...args], {
    encoding: 'utf8',
    env: gitEnv(extraEnv),
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function gitCommonDir(repo) {
  const r = gitRun(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------- 循环分支与 worktree ----------

export function createLoopWorktree(repo, slug, baseSha, { shortId } = {}) {
  const gen = shortId ?? (() => randomBytes(3).toString('hex'));
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = attempt === 0 ? gen() : randomBytes(3).toString('hex');
    const branch = `loop/${slug}-${id}`;
    const exists = gitRun(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.status === 0) continue; // 碰撞：重新生成，不复用已有分支
    const path = mkdtempSync(join(tmpdir(), `loop-wt-${slug}-`));
    const add = gitRun(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
    if (add.status !== 0) {
      rmSync(path, { recursive: true, force: true });
      throw new Error(`创建循环 worktree 失败：${add.stderr.trim()}`);
    }
    return { branch, path };
  }
  throw new Error('循环分支 short-id 连续碰撞，放弃');
}

export function removeWorktree(repo, worktreePath) {
  gitRun(repo, ['worktree', 'remove', '--force', worktreePath]);
  gitRun(repo, ['worktree', 'prune']);
  rmSync(worktreePath, { recursive: true, force: true });
}

export function headIdentity(worktreePath) {
  const sym = gitRun(worktreePath, ['symbolic-ref', '-q', 'HEAD']);
  const sha = gitRun(worktreePath, ['rev-parse', '--verify', 'HEAD']);
  return {
    branch: sym.status === 0 ? sym.stdout.trim() : null,
    sha: sha.status === 0 ? sha.stdout.trim() : null,
  };
}

// ---------- 审计集快照（技术设计 §6） ----------

export function auditSnapshot(repo, worktreePaths = []) {
  const refsOut = gitRun(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const refs = {};
  for (const line of refsOut.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, sha] = line.split(' ');
    refs[name] = sha;
  }

  const common = gitCommonDir(repo);
  const files = {};
  for (const rel of ['config', 'info/attributes', 'info/exclude']) {
    files[rel] = fileHash(join(common, rel));
  }
  const hooksDir = join(common, 'hooks');
  const hookFiles = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((f) => !f.endsWith('.sample')).sort()
    : [];
  files['hooks/'] = createHash('sha256')
    .update(hookFiles.map((f) => `${f}:${fileHash(join(hooksDir, f))}`).join('\n'), 'utf8')
    .digest('hex');

  const worktreePointers = {};
  for (const wt of worktreePaths) {
    worktreePointers[wt] = fileHash(join(wt, '.git'));
  }

  return { refs, files, worktreePointers };
}

function fileHash(path) {
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })) return 'absent';
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'absent';
  }
}

// 比对不变量：窗口内零变化；refs/remotes/* 的纯前进只记录不终止（PRD 4.2.3）。
export function compareAudit(repo, before, after) {
  const violations = [];
  const recorded = [];

  for (const [rel, hash] of Object.entries(after.files)) {
    if (before.files[rel] !== hash) {
      violations.push({ kind: 'gitdir', item: rel });
    }
  }
  for (const [wt, hash] of Object.entries(after.worktreePointers)) {
    if (before.worktreePointers[wt] !== hash) {
      violations.push({ kind: 'worktree_pointer', item: wt });
    }
  }

  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of names) {
    const b = before.refs[name];
    const a = after.refs[name];
    if (b === a) continue;
    if (name.startsWith('refs/remotes/')) {
      if (b === undefined || (a !== undefined && isAncestor(repo, b, a))) {
        recorded.push({ kind: 'remote_ref', item: name, before: b ?? null, after: a ?? null });
        continue;
      }
    }
    violations.push({ kind: 'ref', item: name, before: b ?? null, after: a ?? null });
  }

  return { ok: violations.length === 0, violations, recorded };
}

function isAncestor(repo, maybeAncestor, sha) {
  return gitRun(repo, ['merge-base', '--is-ancestor', maybeAncestor, sha]).status === 0;
}

// ---------- 变更枚举与 checkpoint 闸门 ----------

// 以工作树为准枚举相对 lastSha 的变更路径（含未跟踪文件）。
export function changedPaths(worktreePath, lastSha) {
  const diff = gitRun(worktreePath, ['diff', '--name-only', lastSha]);
  const untracked = gitRun(worktreePath, ['ls-files', '--others', '--exclude-standard']);
  const set = new Set();
  for (const out of [diff.stdout, untracked.stdout]) {
    for (const line of out.split('\n')) {
      if (line.trim()) set.add(line.trim());
    }
  }
  return [...set].sort();
}

export function checkpointGate(worktreePath, lastSha) {
  const hits = [];
  for (const path of changedPaths(worktreePath, lastSha)) {
    const base = path.split('/').pop();
    for (const { rule, test: match } of SENSITIVE_BASENAMES) {
      if (match(base)) hits.push({ path, rule });
    }
    const abs = join(worktreePath, path);
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size > MAX_FILE_BYTES) hits.push({ path, rule: 'max_size' });
    } catch {
      // 已删除的文件没有体积问题
    }
  }
  return { ok: hits.length === 0, hits };
}

// protected paths：gitignore 语义匹配（ls-files --exclude-from 组合，技术设计 §6）。
export function protectedPathsHits(worktreePath, lastSha, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const changed = changedPaths(worktreePath, lastSha);
  if (changed.length === 0) return [];
  const patternFile = join(mkdtempSync(join(tmpdir(), 'loop-protected-')), 'patterns');
  writeFileSync(patternFile, patterns.join('\n') + '\n');
  try {
    const matched = new Set();
    for (const flags of [['-c', '-i'], ['-o', '-i']]) {
      const r = gitRun(worktreePath, ['ls-files', ...flags, `--exclude-from=${patternFile}`]);
      for (const line of r.stdout.split('\n')) {
        if (line.trim()) matched.add(line.trim());
      }
    }
    return changed.filter((p) => matched.has(p));
  } finally {
    rmSync(join(patternFile, '..'), { recursive: true, force: true });
  }
}

// ---------- checkpoint（临时 index 五步，技术设计 §6） ----------

export function checkpoint(repo, worktreePath, branch, lastSha, message) {
  const indexDir = mkdtempSync(join(tmpdir(), 'loop-index-'));
  const indexFile = join(indexDir, 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    let r = gitRun(worktreePath, ['read-tree', lastSha], env);
    if (r.status !== 0) return { error: 'read_tree_failed', detail: r.stderr.trim() };

    r = gitRun(worktreePath, ['add', '-A'], env);
    if (r.status !== 0) return { error: 'add_failed', detail: r.stderr.trim() };

    r = gitRun(worktreePath, ['write-tree'], env);
    if (r.status !== 0) return { error: 'write_tree_failed', detail: r.stderr.trim() };
    const tree = r.stdout.trim();

    const lastTree = gitRun(repo, ['rev-parse', `${lastSha}^{tree}`]).stdout.trim();
    if (tree === lastTree) return { no_change: true };

    r = gitRun(repo, ['commit-tree', tree, '-p', lastSha, '-m', message]);
    if (r.status !== 0) return { error: 'commit_tree_failed', detail: r.stderr.trim() };
    const sha = r.stdout.trim();

    // CAS：带旧值 update-ref，分支被并发移动时拒绝而不是覆盖
    r = gitRun(repo, ['update-ref', `refs/heads/${branch}`, sha, lastSha]);
    if (r.status !== 0) return { error: 'ref_moved', detail: r.stderr.trim() };

    return { sha, tree };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}
