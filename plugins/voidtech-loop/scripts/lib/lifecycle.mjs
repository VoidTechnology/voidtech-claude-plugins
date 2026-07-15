// 循环生命周期编排（PRD F8/F9 + 4.1 启动体检 + 4.3 接受/重新发起）。
// 纯逻辑层：start/status/cancel/accept/newFromCommit。CLI 负责 detach 与信号，本层可被测试直接驱动。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateSpecObject } from './validate.mjs';
import { preflight } from './preflight.mjs';
import { runBaseline } from './baseline.mjs';
import { gitRun, gitCommonDir, createLoopWorktree } from './gitops.mjs';
import { runControllerLoop } from './controller.mjs';
import {
  projectDataDir, readState, writeState, acquireLock, releaseLock,
  inspectLock, takeoverStaleLock, processIdentity, STATE_VERSION,
} from './statestore.mjs';

function newRunId(slug) {
  return `${slug}-${randomBytes(4).toString('hex')}`;
}

function runDir(projectDir, runId) {
  return join(projectDir, 'runs', runId);
}

// 启动体检（PRD 4.1）：校验 spec → 解析 base → 基线裁定 → 获取锁 → 建 worktree → 跑控制器。
// 返回 { ok, ...} 或 { ok:false, stage, ... }。overrideArgv 供测试注入 stub worker。
export async function startLoop({ repo, rawSpec, cloneDeps = [], overrideArgv = null, shouldStop = null, preflightOpts = null, skipPreflight = false }) {
  // 环境门：非试点 OS/缺命令在建分支或 worktree 前拒绝（V9）。测试用 skipPreflight 走注入路径。
  if (!skipPreflight) {
    const pf = preflight(preflightOpts ?? {});
    if (!pf.ok) return { ok: false, stage: 'preflight', problems: pf.problems };
  }

  const validation = validateSpecObject(rawSpec);
  if (!validation.ok) return { ok: false, stage: 'validate', errors: validation.errors };
  const { normalized, goal_hash: goalHash } = validation;

  const common = gitCommonDir(repo);
  if (!common) return { ok: false, stage: 'git', message: '不是 Git 仓库' };

  const rev = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${normalized.base_commit}^{commit}`]);
  if (rev.status !== 0) return { ok: false, stage: 'base', message: `base_commit 无效：${normalized.base_commit}` };
  const baseSha = rev.stdout.trim();
  normalized.base_commit = baseSha;

  // 基线裁定：只有“至少一个 target 未满足且全部 invariant 成立”才可启动
  const baseline = await runBaseline(normalized, { repo, cloneDeps });
  if (baseline.verdict !== 'startable') {
    return { ok: false, stage: 'baseline', verdict: baseline.verdict, message: baseline.message };
  }

  const projectDir = projectDataDir(common);
  mkdirSync(projectDir, { recursive: true });

  // 陈旧锁接管（PRD 5.1）
  const lockState = inspectLock(projectDir);
  if (lockState.status === 'alive') {
    return { ok: false, stage: 'lock', message: '已有活动循环', holder: lockState.meta };
  }
  if (lockState.status === 'stale') {
    takeoverStaleLock(projectDir, `start-${randomBytes(3).toString('hex')}`);
  }

  const runId = newRunId(normalized.goal_id);
  const lock = acquireLock(projectDir, { run_id: runId, ...processIdentity() });
  if (!lock.ok) return { ok: false, stage: 'lock', message: '获取项目锁失败', reason: lock.reason };

  let wt;
  try {
    wt = createLoopWorktree(repo, normalized.goal_id, baseSha, {});
  } catch (err) {
    releaseLock(projectDir, runId);
    return { ok: false, stage: 'worktree', message: String(err) };
  }

  const stateDir = runDir(projectDir, runId);
  const evidenceDir = join(stateDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  try {
    const final = await runControllerLoop({
      repo, spec: normalized, goalHash, runId,
      branch: wt.branch, worktree: wt.path, baseCommit: baseSha,
      stateDir, evidenceDir, overrideArgv, shouldStop,
    });
    return { ok: true, runId, projectDir, stateDir, branch: wt.branch, worktree: wt.path, final };
  } finally {
    // 循环进入终态：释放执行期项目锁（PRD 3.3），保留分支/worktree 供人工检视
    releaseLock(projectDir, runId);
  }
}

export function getStatus({ repo, runId = null }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  if (runId) {
    return readState(runDir(projectDir, runId));
  }
  const lockState = inspectLock(projectDir);
  return { ok: true, lock: lockState };
}

// accept：只能从 EVALS_PASSED → ACCEPTED（V16）。只更新对应 run，不占长生命周期锁。
export function acceptRun({ repo, runId }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const stateDir = runDir(projectDataDir(common), runId);
  const r = readState(stateDir);
  if (!r.ok) return { ok: false, message: `状态不可读：${r.reason}` };
  if (r.state.status !== 'EVALS_PASSED') {
    return { ok: false, message: `accept 只能从 EVALS_PASSED 进入；当前状态 ${r.state.status}` };
  }
  const next = { ...r.state, status: 'ACCEPTED', accepted_at: new Date().toISOString() };
  writeState(stateDir, next);
  return { ok: true, state: next };
}

// cancel：幂等（PRD 4.3）。活动进程发 SIGTERM；已 STOPPED/ACCEPTED 直接返回成功。
export function cancelRun({ repo, runId }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  const stateDir = runDir(projectDir, runId);
  const r = readState(stateDir);
  if (!r.ok) return { ok: false, message: `状态不可读：${r.reason}` };
  if (['STOPPED', 'ACCEPTED', 'EVALS_PASSED'].includes(r.state.status)) {
    return { ok: true, already: true, status: r.state.status };
  }
  const pid = r.state.controller?.pid;
  if (pid && isSamePid(r.state.controller)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程可能已退出 */ }
  }
  return { ok: true, signaled: Boolean(pid) };
}

function isSamePid(controller) {
  const now = processIdentity(controller.pid);
  return now.pid_start === controller.pid_start && now.pid_comm === controller.pid_comm;
}

// 从任意有效 commit 发起全新循环（PRD 4.3 / V20）：新 runId、新分支、新哈希，不改旧 run。
export async function newFromCommit({ repo, rawSpec, baseCommit, overrideArgv = null }) {
  const rev = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${baseCommit}^{commit}`]);
  if (rev.status !== 0) return { ok: false, stage: 'base', message: `--base 无效：${baseCommit}` };
  const spec = { ...rawSpec, base_commit: rev.stdout.trim() };
  return startLoop({ repo, rawSpec: spec, overrideArgv });
}

export { STATE_VERSION };
