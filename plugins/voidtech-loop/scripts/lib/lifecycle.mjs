// 循环生命周期编排（PRD F8/F9 + 4.1 启动体检 + 4.3 接受/重新发起）。
// 纯逻辑层：prepare/run/status/cancel/accept/newFromCommit。CLI 负责 detach 与信号，本层可被测试直接驱动。
// 两阶段启动（P0-1）：prepareRun 在前台完成校验、基线、锁、worktree、warm setup 与初始状态；
// runPreparedLoop 接管已准备完成的 run 跑控制器，任何异常都保证终态化（P1-5）。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateSpecObject } from './validate.mjs';
import { preflight } from './preflight.mjs';
import { runBaseline } from './baseline.mjs';
import { gitRun, gitCommonDir, createLoopWorktree } from './gitops.mjs';
import { runControllerLoop, buildInitialState } from './controller.mjs';
import { runSetup } from './evalrunner.mjs';
import { writeReport } from './report.mjs';
import {
  projectDataDir, readState, writeState, acquireLock, releaseLock,
  inspectLock, takeoverStaleLock, processIdentity, STATE_VERSION,
} from './statestore.mjs';

const TERMINAL_STATUSES = ['STOPPED', 'EVALS_PASSED', 'ACCEPTED'];

function newRunId(slug) {
  return `${slug}-${randomBytes(4).toString('hex')}`;
}

function runDir(projectDir, runId) {
  return join(projectDir, 'runs', runId);
}

// 阶段一（前台，PRD 4.1）：校验 spec → 解析 base（先规范化完整 SHA 再算 goal_hash，P1-6）→
// 基线裁定 → 陈旧锁接管（含旧 run 终态化）→ 获取锁 → 建 worktree → warm setup → 写初始状态。
// 所有会失败的准备步骤都在这里发生，返回 { ok:false, stage, ... } 时调用方能拿到真实错误。
export async function prepareRun({ repo, rawSpec, cloneDeps = [], preflightOpts = null, skipPreflight = false }) {
  // 环境门：非试点 OS/缺命令在建分支或 worktree 前拒绝（V9）。测试用 skipPreflight 走注入路径。
  if (!skipPreflight) {
    const pf = preflight(preflightOpts ?? {});
    if (!pf.ok) return { ok: false, stage: 'preflight', problems: pf.problems };
  }

  const validation = validateSpecObject(rawSpec);
  if (!validation.ok) return { ok: false, stage: 'validate', errors: validation.errors };
  let { normalized, goal_hash: goalHash } = validation;

  const common = gitCommonDir(repo);
  if (!common) return { ok: false, stage: 'git', message: '不是 Git 仓库' };

  const rev = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${normalized.base_commit}^{commit}`]);
  if (rev.status !== 0) return { ok: false, stage: 'base', message: `base_commit 无效：${normalized.base_commit}` };
  const baseSha = rev.stdout.trim();
  // goal_hash 必须对应冻结进状态的完整 SHA：输入为短 SHA 时，以完整 SHA 重新校验并重算哈希（P1-6），
  // 否则状态里的 spec 与其哈希对不上，事后无法验证 spec 未被篡改。
  if (baseSha !== normalized.base_commit) {
    const revalidation = validateSpecObject({ ...rawSpec, base_commit: baseSha });
    if (!revalidation.ok) return { ok: false, stage: 'validate', errors: revalidation.errors };
    ({ normalized, goal_hash: goalHash } = revalidation);
  }

  // 基线裁定：只有“至少一个 target 未满足且全部 invariant 成立”才可启动
  const baseline = await runBaseline(normalized, { repo, cloneDeps });
  if (baseline.verdict !== 'startable') {
    return { ok: false, stage: 'baseline', verdict: baseline.verdict, message: baseline.message };
  }

  const projectDir = projectDataDir(common);
  mkdirSync(projectDir, { recursive: true });

  // 陈旧锁接管（PRD 5.1）：接管即为旧 run 补交接物——非终态的旧 run 落为 STOPPED(interrupted)（P1-5）
  const lockState = inspectLock(projectDir);
  if (lockState.status === 'alive') {
    return { ok: false, stage: 'lock', message: '已有活动循环', holder: lockState.meta };
  }
  if (lockState.status === 'stale') {
    const takeover = takeoverStaleLock(projectDir, `start-${randomBytes(3).toString('hex')}`);
    if (takeover.won && takeover.meta?.run_id) {
      finalizeInterruptedRun(runDir(projectDir, takeover.meta.run_id), {
        kind: 'stale_lock_takeover',
        prior_pid: takeover.meta.pid ?? null,
      });
    }
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

  // warm setup（P0-3）：spec.setup 在循环 worktree 内先跑一遍，worker 起步即有依赖；
  // 产物须被 .gitignore 覆盖，否则会被当作 worker 变更进入 checkpoint。
  if (normalized.setup?.length) {
    const setup = await runSetup(normalized.setup, wt.path, { evidenceDir });
    if (!setup.ok) {
      releaseLock(projectDir, runId);
      return { ok: false, stage: 'setup', message: setup.message };
    }
  }

  // 初始状态先于控制器落盘：status <runId> 从此刻起可用；controller 字段暂为准备进程，接管后被控制器覆盖
  writeState(stateDir, buildInitialState({
    repo, spec: normalized, goalHash, runId,
    branch: wt.branch, worktree: wt.path, baseCommit: baseSha,
  }));

  return {
    ok: true, repo, runId, projectDir, stateDir, evidenceDir,
    branch: wt.branch, worktree: wt.path, baseSha, normalized, goalHash,
  };
}

// 阶段二：跑控制器直至终态。锁在终态释放（PRD 3.3）；控制器抛出未处理异常时，
// 先为 run 写出 STOPPED(interrupted) 终态与报告再返回（P1-5：任何终止路径都有交接物）。
export async function runPreparedLoop(prep, { overrideArgv = null, shouldStop = null } = {}) {
  const { repo, runId, projectDir, stateDir, evidenceDir, branch, worktree, baseSha, normalized, goalHash } = prep;
  try {
    const final = await runControllerLoop({
      repo, spec: normalized, goalHash, runId,
      branch, worktree, baseCommit: baseSha,
      stateDir, evidenceDir, overrideArgv, shouldStop,
    });
    return { ok: true, runId, projectDir, stateDir, branch, worktree, final };
  } catch (err) {
    const detail = { kind: 'controller_crash', error: String(err?.stack ?? err) };
    finalizeInterruptedRun(stateDir, detail);
    return { ok: false, stage: 'controller', runId, projectDir, stateDir, message: detail.error };
  } finally {
    releaseLock(projectDir, runId);
  }
}

// 单进程组合（前台模式与测试入口）：prepare + run。
export async function startLoop({ repo, rawSpec, cloneDeps = [], overrideArgv = null, shouldStop = null, preflightOpts = null, skipPreflight = false }) {
  const prep = await prepareRun({ repo, rawSpec, cloneDeps, preflightOpts, skipPreflight });
  if (!prep.ok) return prep;
  return runPreparedLoop(prep, { overrideArgv, shouldStop });
}

// 把非终态的 run 落为 STOPPED(interrupted) 并补交接报告。幂等：已终态或状态不可读时不动。
export function finalizeInterruptedRun(stateDir, detail) {
  const r = readState(stateDir);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (TERMINAL_STATUSES.includes(r.state.status)) return { ok: true, already: true, status: r.state.status };
  const next = {
    ...r.state,
    status: 'STOPPED',
    stop_reason: 'interrupted',
    stop_detail: detail,
    updated_at: new Date().toISOString(),
  };
  writeState(stateDir, next);
  writeReport(stateDir, next);
  return { ok: true, state: next };
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
  writeReport(stateDir, next);
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
  if (TERMINAL_STATUSES.includes(r.state.status)) {
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
export async function newFromCommit({ repo, rawSpec, baseCommit, overrideArgv = null, skipPreflight = false, preflightOpts = null }) {
  const rev = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${baseCommit}^{commit}`]);
  if (rev.status !== 0) return { ok: false, stage: 'base', message: `--base 无效：${baseCommit}` };
  const spec = { ...rawSpec, base_commit: rev.stdout.trim() };
  return startLoop({ repo, rawSpec: spec, overrideArgv, skipPreflight, preflightOpts });
}

export { STATE_VERSION };
