// 确定性控制器主循环（PRD F4 / 4.2 / 3.4）。
// 每轮：预算检查 → 快照 → 有界 worker → 后置校验（fail closed）→ 闸门 → checkpoint →
// 快照重拍 → eval（前后审计比对）→ 裁定。worker 不能决定自己是否完成，也不能选择是否执行 checker。

import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  auditSnapshot, compareAudit, headIdentity, checkpoint, checkpointGate,
  protectedPathsHits,
} from './gitops.mjs';
import { runEvalPack, WORKER_SUMMARY_TOTAL_CAP } from './evalrunner.mjs';
import { runWorker, buildWorkerPrompt, writeWorkerSettings } from './workerio.mjs';
import { writeState, STATE_VERSION, processIdentity } from './statestore.mjs';
import { writeReport } from './report.mjs';

const NO_PROGRESS_LIMIT = 3;
const CONTROLLER_PATHS = ['.claude'];

export async function runControllerLoop(ctx) {
  const {
    repo, spec, goalHash, runId, branch, worktree, baseCommit,
    stateDir, evidenceDir, overrideArgv = null, shouldStop = null,
  } = ctx;

  const startedAt = Date.now();
  const state = {
    state_version: STATE_VERSION,
    run_id: runId,
    goal_hash: goalHash,
    spec,
    repo,
    branch,
    worktree,
    base_commit: baseCommit,
    status: 'RUNNING',
    stop_reason: null,
    stop_detail: null,
    iteration: 0,
    started_at: new Date(startedAt).toISOString(),
    updated_at: null,
    last_checkpoint: baseCommit,
    candidate_commit: null,
    rounds: [],
    cost: { total_usd: null, unavailable: true },
    audit_recorded: [],
    controller: processIdentity(),
  };
  const persist = () => {
    state.updated_at = new Date().toISOString();
    writeState(stateDir, state);
  };
  const cleanupTransient = () => {
    try { rmSync(guardDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  };
  const stopped = (reason, detail) => {
    state.status = 'STOPPED';
    state.stop_reason = reason;
    state.stop_detail = detail;
    persist();
    writeReport(stateDir, state);
    cleanupTransient();
    return state;
  };

  // 冻结 protected patterns 供守卫使用（不放入 worktree，避免进入 diff）
  const guardDir = mkdtempSync(join(tmpdir(), 'loop-guard-'));
  state.guard_dir = guardDir;
  const patternsFile = join(guardDir, 'protected-patterns');
  writeFileSync(patternsFile, spec.protected_paths.join('\n') + '\n');
  writeWorkerSettings(worktree, { protectedPatternsFile: patternsFile });
  mkdirSync(evidenceDir, { recursive: true });
  persist();

  let failedSummaries = [];
  let noProgressStreak = 0;
  let lastDenials = new Set();

  while (true) {
    if (shouldStop?.()) return stopped('canceled', { kind: 'user_stop' });

    // 预算检查（PRD 5.3）
    if (state.iteration >= spec.budgets.max_iterations) {
      return stopped('exhausted', { kind: 'iterations', limit: spec.budgets.max_iterations });
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    if (elapsedSec >= spec.budgets.max_duration_seconds) {
      return stopped('exhausted', { kind: 'duration', limit: spec.budgets.max_duration_seconds });
    }

    state.iteration += 1;
    state.status = 'RUNNING';
    persist();

    const snapBefore = auditSnapshot(repo, [worktree]);
    const remaining = Math.max(1, Math.ceil(spec.budgets.max_duration_seconds - elapsedSec));
    const prompt = buildWorkerPrompt({
      spec,
      iteration: state.iteration,
      lastCheckpoint: state.last_checkpoint,
      failedSummaries,
    });
    const worker = await runWorker({ worktree, prompt, timeoutSeconds: remaining, overrideArgv, shouldStop });
    // cancel 在 worker 运行期间到达：worker 进程组已被终止，及时收尾为 canceled（L2）
    if (shouldStop?.() || worker.canceled) return stopped('canceled', { kind: 'user_stop' });

    const round = {
      iteration: state.iteration,
      worker: { exit: worker.exit, timed_out: worker.timed_out, duration_ms: worker.duration_ms },
      no_change: false,
      checkpoint: null,
      eval: null,
      cost_usd: worker.cost_usd ?? null,
    };
    state.rounds.push(round);
    if (worker.cost_usd != null) {
      state.cost.total_usd = (state.cost.total_usd ?? 0) + worker.cost_usd;
      state.cost.unavailable = false;
    }

    if (worker.timed_out) {
      return stopped('exhausted', { kind: 'duration', detail: 'worker_timeout' });
    }
    if (!worker.ok) {
      return stopped('interrupted', { kind: 'worker_error', exit: worker.exit, spawn_error: worker.spawn_error });
    }

    // 权限连续拒绝熔断（PRD 5.3）：同一规范化请求连续两轮被拒
    const denials = new Set(worker.permission_denials ?? []);
    const repeated = [...denials].filter((d) => lastDenials.has(d));
    if (repeated.length > 0) {
      return stopped('blocked', { kind: 'permission_denied', requests: repeated });
    }
    lastDenials = denials;

    // ---- 每轮后置校验（PRD 4.2.3，fail closed）----
    const head = headIdentity(worktree);
    if (head.branch !== `refs/heads/${branch}` || head.sha !== state.last_checkpoint) {
      return stopped('failed', { kind: 'head_moved', expected: state.last_checkpoint, actual: head });
    }
    const snapAfter = auditSnapshot(repo, [worktree]);
    const audit = compareAudit(repo, snapBefore, snapAfter);
    state.audit_recorded.push(...audit.recorded);
    if (!audit.ok) {
      return stopped('failed', { kind: 'audit_violation', violations: audit.violations });
    }
    const protectedHits = protectedPathsHits(worktree, state.last_checkpoint, spec.protected_paths, { exclude: CONTROLLER_PATHS });
    if (protectedHits.length > 0) {
      return stopped('blocked', { kind: 'protected_path', hits: protectedHits });
    }

    // ---- checkpoint 闸门与生成（PRD 4.2.4–5）----
    // 闸门在变更列表上跑；是否有进展以 checkpoint 的树比对为唯一权威，
    // 避免 worker worktree 陈旧 index 让 changedPaths 与 checkpoint 判定不一致。
    // .claude/ 是控制器注入的守卫配置，既不进 checkpoint 也不算进展。
    const gate = checkpointGate(worktree, state.last_checkpoint, { exclude: CONTROLLER_PATHS });
    if (!gate.ok) {
      return stopped('blocked', { kind: 'checkpoint_gate', hits: gate.hits });
    }

    const cp = checkpoint(repo, worktree, branch, state.last_checkpoint, `loop(${runId}): iteration ${state.iteration}`, { exclude: CONTROLLER_PATHS });
    if (cp.error) {
      return stopped('failed', { kind: 'checkpoint_failed', error: cp.error, detail: cp.detail });
    }
    if (cp.no_change) {
      round.no_change = true;
      noProgressStreak += 1;
      if (noProgressStreak >= NO_PROGRESS_LIMIT) {
        return stopped('blocked', { kind: 'no_progress', rounds: noProgressStreak });
      }
      persist();
      continue;
    }
    noProgressStreak = 0;
    round.checkpoint = cp.sha;
    state.last_checkpoint = cp.sha;
    persist();

    // ---- 验收（PRD 4.2.6–8；eval 前后审计比对，V24）----
    state.status = 'VERIFYING';
    persist();
    const snapEvalBefore = auditSnapshot(repo, [worktree]);
    const verdict = await runEvalPack(spec, {
      repo,
      candidateSha: cp.sha,
      goalHash,
      evidenceDir: join(evidenceDir, `iteration-${state.iteration}`),
    });
    const snapEvalAfter = auditSnapshot(repo, [worktree]);
    const evalAudit = compareAudit(repo, snapEvalBefore, snapEvalAfter);
    state.audit_recorded.push(...evalAudit.recorded);
    if (!evalAudit.ok) {
      return stopped('failed', { kind: 'eval_audit_violation', violations: evalAudit.violations });
    }
    if (verdict.error) {
      return stopped('failed', { kind: 'eval_infra', error: verdict.error, message: verdict.message });
    }

    round.eval = {
      passed: verdict.passed,
      failed_ids: verdict.failed.map((f) => f.id),
      results: verdict.results.map((r) => ({
        id: r.id,
        role: r.role,
        pass: r.pass,
        timed_out: r.timed_out,
        runs: r.runs.map((x) => ({ exit: x.exit, timed_out: x.timed_out, duration_ms: x.duration_ms, evidence: x.evidence ?? null })),
      })),
    };

    if (verdict.passed) {
      state.status = 'EVALS_PASSED';
      state.candidate_commit = cp.sha;
      persist();
      writeReport(stateDir, state);
      cleanupTransient();
      return state;
    }

    // 失败证据注入下一轮（总量约束 32KiB，PRD 4.2.7–8）
    failedSummaries = capSummaries(verdict.failed.map((f) => f.summary));
    persist();
  }
}

function capSummaries(summaries) {
  const out = [];
  let total = 0;
  for (const s of summaries) {
    const bytes = Buffer.byteLength(s, 'utf8');
    if (total + bytes > WORKER_SUMMARY_TOTAL_CAP) break;
    out.push(s);
    total += bytes;
  }
  return out;
}
