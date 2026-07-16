// 循环生命周期编排（PRD F8/F9 + 4.1 启动体检 + 4.3 接受/重新发起）。
// 纯逻辑层：prepare/run/status/cancel/accept/newFromCommit。CLI 负责 detach 与信号，本层可被测试直接驱动。
// 两阶段启动（P0-1）：prepareRun 在前台完成校验、基线、锁、worktree、初始状态与循环 setup；
// runPreparedLoop 接管已准备完成的 run 跑控制器，任何异常都保证终态化（P1-5）。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateSpecObject } from './validate.mjs';
import { preflight } from './preflight.mjs';
import { runBaseline } from './baseline.mjs';
import { gitCommonDir, resolveCommit, createLoopWorktree } from './gitops.mjs';
import { runControllerLoop, buildInitialState } from './controller.mjs';
import { runSetup } from './evalrunner.mjs';
import { writeReport } from './report.mjs';
import {
  projectDataDir, readState, writeState, acquireLock, releaseLock,
  inspectLock, takeoverStaleLock, processIdentity, updateLockMeta, STATE_VERSION,
} from './statestore.mjs';
import { submitDecision, readCommittedDecision } from './decisionstore.mjs';
import { latestVerificationBlocker } from './supplementalverification.mjs';
import {
  classifyReviewIntegrity, recoverRunReview, isLegacyAccepted,
  buildAcceptStateUpdate, buildStatePrecondition,
} from './reviewintegrity.mjs';

const TERMINAL_STATUSES = ['STOPPED', 'EVALS_PASSED', 'ACCEPTED'];

function newRunId(slug) {
  return `${slug}-${randomBytes(4).toString('hex')}`;
}

function runDir(projectDir, runId) {
  return join(projectDir, 'runs', runId);
}

// 阶段一（前台，PRD 4.1）：校验 spec → 解析 base（先规范化完整 SHA 再算 goal_hash，P1-6）→
// 基线裁定 → 陈旧锁接管（含旧 run 终态化）→ 获取锁 → 建 worktree → 写初始状态 → 循环 setup。
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

  const resolvedBase = resolveCommit(repo, normalized.base_commit);
  if (!resolvedBase.ok) return { ok: false, stage: 'base', message: `base_commit 无效：${normalized.base_commit}` };
  const baseSha = resolvedBase.sha;
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

  const prep = {
    ok: true, repo, runId, projectDir, stateDir, evidenceDir,
    branch: wt.branch, worktree: wt.path, baseSha, normalized, goalHash,
  };

  // 初始状态必须先于任何后续可失败步骤落盘。这样循环 setup、后台握手等失败都能复用
  // finalizeInterruptedRun 留下可审计终态，而不是产生无记录的孤儿分支。
  writeState(stateDir, buildInitialState({
    repo, spec: normalized, goalHash, runId,
    branch: wt.branch, worktree: wt.path, baseCommit: baseSha,
  }));

  // 循环 setup（P0-3）：spec.setup 在循环 worktree 内跑一遍，worker 起步即有依赖；
  // 产物须被 .gitignore 覆盖，否则会被当作 worker 变更进入 checkpoint。
  if (normalized.setup?.length) {
    const setup = await runSetup(normalized.setup, wt.path, { evidenceDir });
    if (!setup.ok) {
      const detail = { kind: 'setup_failed', message: setup.message };
      failPreparedRun(prep, detail);
      return { ...prep, ok: false, stage: 'setup', message: setup.message };
    }
  }

  return prep;
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

// prepared run 在控制器接管前失败时的统一收尾：保留分支/worktree 现场，终态化并释放锁。
// 幂等调用不会覆盖已有终态，也不会因为锁已释放而把成功收尾误报成失败。
export function failPreparedRun(prep, detail) {
  const finalized = finalizeInterruptedRun(prep.stateDir, detail);
  const released = releaseLock(prep.projectDir, prep.runId);
  const releaseOk = released.ok || released.reason === 'not_held';
  return { ok: finalized.ok && releaseOk, finalized, released };
}

// 后台控制器在 ready 回执前同时接管锁和状态中的 PID 身份，避免用户拿到 run ID 后
// 立即 cancel 时仍向已经退出的准备进程发信号。
export function adoptPreparedRun(prep, identity) {
  const lock = updateLockMeta(prep.projectDir, prep.runId, identity);
  if (!lock.ok) return { ok: false, reason: `锁接管失败：${lock.reason}` };
  const current = readState(prep.stateDir);
  if (!current.ok) {
    releaseLock(prep.projectDir, prep.runId);
    return { ok: false, reason: `初始状态不可读：${current.reason}` };
  }
  writeState(prep.stateDir, {
    ...current.state,
    controller: identity,
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
}

export function getStatus({ repo, runId = null }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  if (runId) {
    const r = readState(runDir(projectDir, runId));
    // 执行健康与评审健康分开呈现（P2-24）：state 不可读也不掩盖 review 层信息
    return { ...r, review: classifyReviewIntegrity(projectDir, runId, r) };
  }
  const lockState = inspectLock(projectDir);
  return { ok: true, lock: lockState };
}

function localUser() {
  return { kind: 'local_user', claimed_id: null, identity_verified: false };
}

function newDecisionId() {
  return `decision-${randomBytes(6).toString('hex')}`;
}

function newOperationId() {
  return `review-op-${randomBytes(6).toString('hex')}`;
}

// 人工输入 [{ item, passed, note? }] 规范化为 Decision Record 形态；passed_by 只能是 local_user（P2-11）。
function normalizeManualResults(results) {
  return results.map((m) => ({
    item: m.item,
    passed: m.passed === true,
    passed_by: localUser(),
    note: m.note ?? null,
  }));
}

// manual review 完整性（§3.5）：spec 声明的每一项必须有结果；不接受规格之外的额外条目。
function checkManualReviewCoverage(spec, results) {
  const required = spec?.manual_review ?? [];
  const provided = new Set(results.map((m) => m.item));
  const missing = required.filter((item) => !provided.has(item));
  const extra = results.filter((m) => !required.includes(m.item)).map((m) => m.item);
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

// accept（二期 §3.5，P2-15）：EVALS_PASSED -> ACCEPTED 保持一期语义，同时经 run review lock、
// Operation Journal 与 decision slot 生成外部 Decision Record。重复调用幂等；legacy Accept 不补造 Record。
export async function acceptRun({ repo, runId, manualReviewResults = [], note = null }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  const stateDir = runDir(projectDir, runId);
  const r = readState(stateDir);
  if (!r.ok) return { ok: false, message: `状态不可读：${r.reason}` };

  if (r.state.status === 'ACCEPTED' && isLegacyAccepted(r.state)) {
    return { ok: true, already: true, legacy: true, state: r.state };
  }
  if (r.state.status !== 'EVALS_PASSED' && r.state.status !== 'ACCEPTED') {
    return { ok: false, message: `accept 只能从 EVALS_PASSED 进入；当前状态 ${r.state.status}` };
  }

  // 已有 finalized accept（含 supplemental accept）：直接幂等返回，不比较请求参数
  const existing = readCommittedDecision(projectDir, runId);
  if (existing.ok && existing.exists && existing.record.outcome === 'accept' && r.state.status === 'ACCEPTED') {
    return { ok: true, already: true, idempotent: true, state: r.state, decision: existing.record };
  }

  // P2-21：最近一次补充验证为 correction_required / inconclusive 时，普通 Accept 被阻断
  if (r.state.status === 'EVALS_PASSED') {
    const blocker = latestVerificationBlocker(projectDir, runId);
    if (blocker) {
      return {
        ok: false, reason: 'supplemental_verification_blocking', blocker,
        message: `补充验证最近一次结果为 ${blocker.result}（${blocker.detail ?? ''}）；`
          + `请先完成 correction Revise、重试验证或 abandon，再考虑 Accept`,
      };
    }
  }

  const coverage = checkManualReviewCoverage(r.state.spec, manualReviewResults);
  if (!coverage.ok) {
    return {
      ok: false, reason: 'manual_review_incomplete',
      message: `manual review 结果不完整或含规格外条目；缺少 ${JSON.stringify(coverage.missing)}，多余 ${JSON.stringify(coverage.extra)}`,
      missing: coverage.missing, extra: coverage.extra,
    };
  }

  const decision = {
    schema_version: 1,
    decision_id: newDecisionId(),
    run_id: runId,
    goal_hash: r.state.goal_hash,
    source_commit: r.state.candidate_commit,
    outcome: 'accept',
    manual_review_results: normalizeManualResults(manualReviewResults),
    decided_at: new Date().toISOString(),
    decided_by: localUser(),
    authorization: null,
    proposal_hash: null,
    approval_bundle_hash: null,
    basis: { original_goal_hash: r.state.goal_hash, supplemental_verification: null },
    note,
  };

  const result = await submitDecision(projectDir, runId, {
    operationId: newOperationId(),
    decision,
    expectedStateChecksum: r.checksum,
    applyStateUpdate: buildAcceptStateUpdate(stateDir),
  });
  if (!result.ok) return { ...result, message: result.message ?? `accept 失败：${result.reason}` };

  // committed Accept + state 落后（幂等命中但 state 未迁移）：按恢复矩阵补齐，补不齐 fail closed
  let after = readState(stateDir);
  if (after.ok && after.state.status === 'EVALS_PASSED') {
    const recovered = await recoverRunReview(projectDir, runId);
    if (!recovered.ok) return recovered;
    after = readState(stateDir);
  }

  const review = classifyReviewIntegrity(projectDir, runId, after);
  writeReport(stateDir, after.state, { decision: result.record, integrity: review });
  return { ok: true, state: after.state, decision: result.record, idempotent: result.idempotent ?? false, review };
}

// abandon（二期 §3.5，PRD §10.2）：不修改 run state 或 checksum，只在 decision slot 上
// 追加 finalized Decision Record；发布前锁内重读并要求 checksum 未变。
export async function abandonRun({ repo, runId, note = null }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  const stateDir = runDir(projectDir, runId);
  const r = readState(stateDir);
  if (!r.ok) return { ok: false, message: `状态不可读：${r.reason}` };
  if (r.state.status !== 'EVALS_PASSED' && r.state.status !== 'STOPPED') {
    return { ok: false, message: `abandon 只能对终态且未接受的 run 执行；当前状态 ${r.state.status}` };
  }

  const decision = {
    schema_version: 1,
    decision_id: newDecisionId(),
    run_id: runId,
    goal_hash: r.state.goal_hash,
    source_commit: r.state.candidate_commit ?? r.state.last_checkpoint ?? r.state.base_commit,
    outcome: 'abandon',
    manual_review_results: [],
    decided_at: new Date().toISOString(),
    decided_by: localUser(),
    authorization: null,
    proposal_hash: null,
    approval_bundle_hash: null,
    basis: { original_goal_hash: r.state.goal_hash, supplemental_verification: null },
    note,
  };

  const result = await submitDecision(projectDir, runId, {
    operationId: newOperationId(),
    decision,
    expectedStateChecksum: r.checksum,
    applyStateUpdate: buildStatePrecondition(stateDir),
  });
  if (!result.ok) return { ...result, message: result.message ?? `abandon 失败：${result.reason}` };

  // Abandon 不写回旧 state：state 与 checksum 保持原值（P2-24）
  const after = readState(stateDir);
  return {
    ok: true, state: after.state, decision: result.record,
    idempotent: result.idempotent ?? false,
    review: classifyReviewIntegrity(projectDir, runId, after),
  };
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
  const resolved = resolveCommit(repo, baseCommit);
  if (!resolved.ok) return { ok: false, stage: 'base', message: `--base 无效：${baseCommit}` };
  const spec = { ...rawSpec, base_commit: resolved.sha };
  return startLoop({ repo, rawSpec: spec, overrideArgv, skipPreflight, preflightOpts });
}

export { STATE_VERSION };
