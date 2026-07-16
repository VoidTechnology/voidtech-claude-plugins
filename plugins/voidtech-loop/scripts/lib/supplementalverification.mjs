// Supplemental Verification（二期技术设计 §6.1/§3.8，Task 5.5，P2-18~P2-22）。
// verification-only 草稿只追加 eval：新增检查在原 candidate 的一次性 worktree 中执行，
// 不创建 run state、不调用 startLoop。三分流：
//   全部通过 → verification_passed：原子发布 Supplemental Accept Bundle 并接受原 run；
//   任一业务失败 → correction_required：append-only 记录 attempt，生成 coding correction 草稿；
//   超时/环境/基础设施 → verification_inconclusive：记录 attempt，可对完全相同 bundle 精确重试。
// 与 coding baseline 共用底层命令执行（evalrunner），仅上层 result adapter 不同（P2-19）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { readState } from './statestore.mjs';
import { writeReport } from './report.mjs';
import { classifyReviewIntegrity } from './reviewintegrity.mjs';
import { runEvalPack } from './evalrunner.mjs';
import { runDir, verificationAttemptsDir, artifactHash } from './reviewstore.mjs';
import { buildAcceptStateUpdate } from './reviewintegrity.mjs';
import { publishSupplementalAccept, recordVerificationAttempt, listVerificationAttempts } from './revisionstore.mjs';
import { validateSpecText } from './validate.mjs';
import { emitYaml, createRevisionDraft, REVISION_DRAFT_ID } from './reviewapproval.mjs';


function appendedEvalsOf(parentSpec, draftSpec) {
  const parentIds = new Set(parentSpec.evals.map((e) => e.id));
  return draftSpec.evals.filter((e) => !parentIds.has(e.id));
}

// manual review 完整性与 acceptRun 同规（供 supplemental accept 使用）
function checkManualCoverage(spec, results) {
  const required = spec?.manual_review ?? [];
  const provided = new Set(results.map((m) => m.item));
  const missing = required.filter((item) => !provided.has(item));
  const extra = results.map((m) => m.item).filter((item) => !required.includes(item));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

export async function runSupplementalVerification({
  repo, projectDir, runId, state, stateChecksum, loaded, manualReviewResults = [], evalRunner = null,
}) {
  const runEvals = evalRunner ?? runEvalPack;
  const { bundle, normalized, payloads } = loaded;
  const candidate = bundle.base_commit;
  const stateDir = runDir(projectDir, runId);

  // supplemental accept 与人工 accept 同规：manual review 必须完整（P2-11 语义不被绕过）
  const coverage = checkManualCoverage(state.spec, manualReviewResults);
  if (!coverage.ok) {
    return {
      ok: false, reason: 'manual_review_incomplete', missing: coverage.missing, extra: coverage.extra,
      message: `补充验证通过也不能绕过 manual review：缺少 ${JSON.stringify(coverage.missing)}；用 --manual-passed 逐项确认后重试`,
    };
  }

  const appended = appendedEvalsOf(state.spec, normalized);
  if (appended.length === 0) return { ok: false, reason: 'no_appended_checks' };

  const verificationId = `verification-v${bundle.draft_version}`;
  const attemptNo = listVerificationAttempts(projectDir, runId, verificationId).length + 1;
  const attemptEvidenceDir = join(verificationAttemptsDir(projectDir, runId, verificationId), `attempt-${attemptNo}-evidence`);
  const startedAt = new Date().toISOString();

  // 只执行补充检查（parent evals 已在同一 candidate 上证明过）；setup 语义沿用一期
  const subset = { ...normalized, evals: appended };
  const pack = await runEvals(subset, {
    repo, candidateSha: candidate, goalHash: bundle.goal_spec_hash, evidenceDir: attemptEvidenceDir,
  });

  const attemptBase = {
    schema_version: 1,
    verification_id: verificationId,
    run_id: runId,
    approval_bundle_hash: bundle.approval_bundle_hash,
    attempt: attemptNo,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    evidence_hash: null,
  };

  // 基础设施失败 / 超时：inconclusive——不解释为代码缺陷，不 Accept、不输出 start，可精确重试（P2-21）
  const timedOut = (pack.results ?? []).some((r) => r.timed_out);
  if (pack.error || timedOut) {
    const detail = pack.error ? `${pack.error}: ${pack.message ?? ''}` : `eval 超时：${pack.results.filter((r) => r.timed_out).map((r) => r.id).join('、')}`;
    recordVerificationAttempt(projectDir, runId, verificationId, {
      ...attemptBase, result: 'inconclusive', detail,
    });
    return {
      ok: false, reason: 'verification_inconclusive', retryable: true, detail,
      message: `补充验证 inconclusive（${detail}）；不接受、不生成启动命令；修复环境后可对完全相同版本精确重试`,
    };
  }

  const failed = pack.results.filter((r) => !r.pass);
  if (failed.length > 0) {
    // correction_required：失败检查成为 coding 草稿的 target（在 base 上失败，首轮不得自动提升 invariant，P2-20）
    recordVerificationAttempt(projectDir, runId, verificationId, {
      ...attemptBase, result: 'correction_required',
      detail: `补充检查未通过：${failed.map((r) => r.id).join('、')}`,
    });
    const failedIds = new Set(failed.map((r) => r.id));
    const correctionEvals = appended.map((e) => (failedIds.has(e.id) ? { ...e, role: 'target' } : e));
    const correction = createRevisionDraft({
      projectDir, runId, state,
      proposal: { proposal_id: `correction-${verificationId}`, findings: [] },
      proposalHash: bundle.proposal_hash,
      revisionRequest: { appended_evals: correctionEvals, appended_agent_review: [], finding_mapping: {} },
      inputManifestHash: bundle.evidence_snapshot_hash,
      validationKind: 'coding_baseline',
    });
    return {
      ok: false, reason: 'correction_required', failed_ids: [...failedIds],
      correction_draft: correction.ok ? { draft_id: REVISION_DRAFT_ID, draft_version: correction.bundle.draft_version } : null,
      message: `补充验证失败：${[...failedIds].join('、')}。已生成以原 candidate 为 base 的 correction 草稿（失败检查为 target），`
        + `执行 loop approve ${runId} --approve-execution 批准后将走一期完整 baseline 与新 run；在此之前该 run 不能被 Accept`,
    };
  }

  // verification_passed：冻结补充 Spec + evidence，接受原 run；不创建 run ID、不调用 startLoop（P2-18）
  const specYaml = emitYaml(payloads.spec);
  const roundtrip = validateSpecText(specYaml);
  if (!roundtrip.ok || roundtrip.goal_hash !== bundle.goal_spec_hash) {
    return { ok: false, reason: 'yaml_roundtrip_mismatch' };
  }
  const resultSummary = {
    result: 'passed',
    candidate_commit: candidate,
    goal_spec_hash: bundle.goal_spec_hash,
    checks: pack.results.map((r) => ({ id: r.id, role: r.role, pass: r.pass })),
  };
  const evidenceHash = artifactHash(resultSummary);
  const evidenceFiles = collectAttemptEvidence(attemptEvidenceDir);

  const decision = {
    schema_version: 1,
    decision_id: `decision-${randomBytes(6).toString('hex')}`,
    run_id: runId,
    goal_hash: state.goal_hash,
    source_commit: candidate,
    outcome: 'accept',
    manual_review_results: manualReviewResults.map((m) => ({
      item: m.item, passed: m.passed === true,
      passed_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
      note: m.note ?? null,
    })),
    decided_at: new Date().toISOString(),
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: bundle.proposal_hash,
    approval_bundle_hash: bundle.approval_bundle_hash,
    basis: {
      original_goal_hash: state.goal_hash,
      supplemental_verification: {
        goal_hash: bundle.goal_spec_hash, commit: candidate, result: 'passed', evidence_hash: evidenceHash,
      },
    },
    note: null,
  };
  const published = await publishSupplementalAccept(projectDir, runId, {
    operationId: `review-op-${randomBytes(6).toString('hex')}`,
    decision,
    expectedStateChecksum: stateChecksum,
    applyStateUpdate: buildAcceptStateUpdate(stateDir),
    approvalBundleHash: bundle.approval_bundle_hash,
    goalSpecYaml: specYaml,
    resultJson: JSON.stringify(resultSummary, null, 2),
    evidence: evidenceFiles,
  });
  if (!published.ok) return published;

  const after = readState(stateDir);
  // P2-22：Accept 报告同时追溯原 goal hash 与补充验证 hash
  writeReport(stateDir, after.state, {
    decision: published.record,
    integrity: classifyReviewIntegrity(projectDir, runId, after),
  });
  return {
    ok: true,
    outcome: 'verification_passed',
    decision: published.record,
    state: after.state,
    // 原 candidate 通过补充验证并已接受：没有新 run，也没有启动命令（P2-18/P2-22）
    message: `补充验证全部通过；原 candidate ${candidate.slice(0, 10)} 已按补充规格接受（原 goal hash 与补充验证 hash 均记录于 Decision basis）。未创建新 run。`,
  };
}

// 供 acceptRun 守卫（P2-21）：最近一次 attempt 为 correction_required / inconclusive 时阻断普通 Accept。
export function latestVerificationBlocker(projectDir, runId) {
  const root = join(projectDir, 'reviews', runId, 'verifications');
  if (!existsSync(root)) return null;
  let latest = null;
  for (const vid of readdirSync(root)) {
    for (const attempt of listVerificationAttempts(projectDir, runId, vid)) {
      if (!latest || attempt.started_at > latest.started_at) latest = attempt;
    }
  }
  if (!latest) return null;
  return ['correction_required', 'inconclusive'].includes(latest.result) ? latest : null;
}

function collectAttemptEvidence(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out[basename(p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
