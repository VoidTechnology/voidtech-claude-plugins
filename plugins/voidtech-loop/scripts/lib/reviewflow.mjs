// 建议模式 review 流程编排（二期技术设计 §6/§8，Task 5.3，P2-05/P2-16）。
// 终态 run → Fact Pack → candidate snapshot → 初始上下文 → fresh reviewer → proposal 持久化。
// 状态矩阵（PRD §10.3.3）：非终态拒绝；已决 run 返回已有决定；每 run 同时最多一个活动
// review session；人不同意时可直接落相反人工决定，或带方向意见要求重提案（最多一次），
// 两条路径都保留原 proposal。任何路径都不自动启动新 run。

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readState, atomicWrite } from './statestore.mjs';
import { gitCommonDir } from './gitops.mjs';
import { projectDataDir } from './statestore.mjs';
import { runDir, reviewsDir, proposalPath } from './reviewstore.mjs';
import { acquireRunReviewLock, releaseRunReviewLock } from './runreviewlock.mjs';
import { readCommittedDecision } from './decisionstore.mjs';
import { buildReviewFactPack, persistFactPack, computeInputManifestHash } from './reviewfactpack.mjs';
import { createReviewSnapshot, destroyReviewSnapshot, bindSnapshotToManifest } from './reviewsnapshot.mjs';
import { buildInitialReviewContext } from './reviewcontext.mjs';
import { runReviewer, buildReviewerPrompt } from './reviewerio.mjs';
import { persistProposal } from './reviewproposal.mjs';

const REVIEWABLE = ['EVALS_PASSED', 'STOPPED'];

// 单 run 单活动 session：复用 mkdir 锁原语，锁挂在 reviews/<run-id>/ 下，
// 与决策提交的 <run-dir>/review.lock 相互独立（review 生成期不占决策临界区）。
function acquireSessionLock(projectDir, runId, sessionId) {
  const dir = reviewsDir(projectDir, runId);
  mkdirSync(dir, { recursive: true });
  return acquireRunReviewLock(dir, sessionId);
}

function releaseSessionLock(projectDir, runId, sessionId) {
  return releaseRunReviewLock(reviewsDir(projectDir, runId), sessionId);
}

function auditPath(projectDir, runId, proposalId) {
  return `${proposalPath(projectDir, runId, proposalId)}`.replace(/\.json$/, '.audit.json');
}

function listCorrectionCount(projectDir, runId) {
  const dir = join(reviewsDir(projectDir, runId), 'proposals');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.endsWith('.audit.json')).filter((n) => {
    try {
      return JSON.parse(readFileSync(join(dir, n), 'utf8')).correction === true;
    } catch {
      return false;
    }
  }).length;
}

// 单发式 coverage 的机械口径：diff 全量内联 = changed files 已做 diff 级检查；
// 任何裁剪都如实降级为 budget_limited，不把部分注入包装成 complete。
function singleShotCoverage(manifest, context) {
  const diffClipped = context.omitted.includes('diff_clipped') || context.omitted.includes('diff');
  const limitations = [];
  if (diffClipped) limitations.push('budget_limited');
  if (manifest.diff.files.some((f) => f.binary)) limitations.push('binary_limited');
  let status = 'complete';
  if (limitations.includes('budget_limited')) status = 'budget_limited';
  else if (limitations.includes('binary_limited')) status = 'binary_limited';
  return {
    status,
    changed_files_total: manifest.diff.files.length,
    changed_files_inspected: diffClipped ? 0 : manifest.diff.files.length,
    evidence_items_total: manifest.evidence.length,
    // 单发式只注入 evidence 元数据与摘要，不算逐条检查
    evidence_items_inspected: 0,
    budget_used_bytes: context.total_bytes,
    budget_limit_bytes: 128 * 1024,
    limitations,
  };
}

export async function runSuggestionReview({ repo, runId, direction = null, overrideArgv = null }) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  const stateDir = runDir(projectDir, runId);

  const stateResult = readState(stateDir);
  if (!stateResult.ok) return { ok: false, reason: 'state_unreadable', message: `状态不可读：${stateResult.reason}` };
  const state = stateResult.state;

  // 已决 run：返回已有决定（状态矩阵）
  const committed = readCommittedDecision(projectDir, runId);
  if (!committed.ok) return { ok: false, reason: 'committed_corrupt' };
  if (committed.exists) {
    return { ok: true, already_decided: true, record: committed.record };
  }
  if (state.status === 'ACCEPTED') {
    return { ok: true, already_decided: true, legacy: true, status: state.status };
  }
  if (!REVIEWABLE.includes(state.status)) {
    return { ok: false, reason: 'not_terminal', message: `review 只对终态且未决的 run 可用；当前状态 ${state.status}` };
  }

  // 带方向重提案最多一次（PRD §10.1 / P2-30）
  if (direction && listCorrectionCount(projectDir, runId) >= 1) {
    return { ok: false, reason: 'correction_exhausted', message: '带方向意见的重提案最多一次；请直接作出人工决定（loop accept / loop abandon）' };
  }

  const sessionMutex = `review-session-${randomBytes(6).toString('hex')}`;
  const locked = acquireSessionLock(projectDir, runId, sessionMutex);
  if (!locked.ok) {
    return { ok: false, reason: 'review_in_progress', message: '该 run 已有活动 review session', holder: locked.holder };
  }

  let snapshot = null;
  try {
    const built = buildReviewFactPack({ repo, projectDir, runId });
    if (!built.ok) return { ok: false, reason: `fact_pack_${built.reason}`, missing: built.missing ?? null };

    const created = createReviewSnapshot(repo, built.manifest.candidate_commit);
    if (!created.ok) return { ok: false, reason: `snapshot_${created.reason}` };
    snapshot = created.snapshot;

    const manifest = bindSnapshotToManifest(built.manifest, snapshot);
    const inputManifestHash = computeInputManifestHash(manifest);
    persistFactPack(projectDir, runId, manifest);

    const context = buildInitialReviewContext({
      manifest, spec: state.spec, diffText: built.diff_text, evidenceSummaries: [],
    });
    if (!context.ok) return { ok: false, reason: context.reason, required_bytes: context.required_bytes };

    let prompt = buildReviewerPrompt({ initialContext: context.context });
    if (direction) {
      prompt += `\n人类方向意见（本次重提案必须回应，但结论仍须由证据支撑）：${direction}\n`;
    }

    const coverage = singleShotCoverage(manifest, context);
    const reviewed = await runReviewer({
      prompt, manifest, inputManifestHash, spec: state.spec, coverage,
      trackedSet: snapshot.tracked_set, overrideArgv,
    });
    if (!reviewed.ok) return { ok: false, reason: reviewed.reason, detail: reviewed.detail ?? null, audit: reviewed.audit ?? null };

    const saved = persistProposal(projectDir, runId, reviewed.proposal);
    if (!saved.ok) return { ok: false, reason: saved.reason };
    atomicWrite(auditPath(projectDir, runId, reviewed.proposal.proposal_id), JSON.stringify({
      ...reviewed.audit,
      proposal_hash: reviewed.proposal_hash,
      input_manifest_hash: inputManifestHash,
      fact_pack_id: manifest.fact_pack_id,
      correction: direction !== null,
      direction,
    }, null, 2));

    return {
      ok: true,
      proposal: reviewed.proposal,
      proposal_hash: reviewed.proposal_hash,
      audit: reviewed.audit,
      fact_pack_id: manifest.fact_pack_id,
      summary: renderProposalSummary(reviewed.proposal, { runId, correction: direction !== null }),
    };
  } finally {
    if (snapshot) destroyReviewSnapshot(snapshot);
    releaseSessionLock(projectDir, runId, sessionMutex);
  }
}

// 面向人的摘要：推荐结论、关键发现与证据、可执行动作。normal path 不暴露内部 hash；
// hash 与 session 元数据在 .audit.json 审计视图中可查。
export function renderProposalSummary(proposal, { runId, correction = false }) {
  const L = [];
  L.push(`Review 建议${correction ? '（带方向重提案）' : ''}：${proposal.recommended_outcome.toUpperCase()}`);
  L.push('');
  if (proposal.findings.length) {
    L.push('发现：');
    for (const f of proposal.findings) {
      L.push(`  [${f.severity}] ${f.id}（${f.category}）：${f.summary}`);
      L.push(`      证据：${f.evidence_refs.join('、')}`);
    }
  } else {
    L.push('发现：无');
  }
  if (proposal.agent_review_results.length) {
    L.push('agent review 结果：');
    for (const a of proposal.agent_review_results) {
      L.push(`  ${a.id}：${a.verdict} —— ${a.rationale}`);
    }
  }
  if (proposal.escalations.length) {
    L.push('需人工裁定：');
    for (const e of proposal.escalations) {
      L.push(`  [${e.reason_category}] ${e.summary}`);
    }
  }
  L.push('');
  L.push(`coverage：${proposal.coverage.status}${proposal.coverage.limitations.length ? `（${proposal.coverage.limitations.join('、')}）` : ''}`);
  L.push('');
  L.push('可执行动作（不会自动执行任何一项）：');
  L.push(`  loop accept ${runId} [--manual-passed] [--note <text>]   # 接受该 run`);
  L.push(`  loop abandon ${runId} [--reason <text>]                  # 放弃该 run`);
  if (!correction) {
    L.push(`  loop review ${runId} --direction "<方向意见>"            # 不同意时带方向重提案（最多一次）`);
  }
  return L.join('\n');
}
