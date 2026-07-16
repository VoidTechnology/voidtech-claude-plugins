// 一次批准与 coding Revise（二期技术设计 §6，Task 5.4，P2-12/P2-13/P2-16）。
// 草稿组装采用"控制器复制 + 只追加"：新 spec 的既有字段全部从冻结 parent spec 逐字节复制，
// reviewer 只能提出追加的 eval/agent_review——既有内容不可篡改是构造保证，不是审查结论。
// 批准链：展示 → 人批准当前版本 → conditional hash match → 静态校验 → coding baseline →
// 二次 match + slot 检查 → YAML 往返自检 → 原子冻结 Revision Bundle → 只输出显式启动命令。

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readState, atomicWrite, projectDataDir } from './statestore.mjs';
import { gitCommonDir } from './gitops.mjs';
import { validateSpecObject, validateSpecText } from './validate.mjs';
import { runBaseline } from './baseline.mjs';
import { runDir, draftDir, validateReviewArtifact, artifactHash } from './reviewstore.mjs';
import {
  saveDraftVersion, readDraftVersion, latestDraftVersion, recordApproval, verifyApprovedBundle,
} from './approvalbundle.mjs';
import { buildExecutionPlan, renderExecutionPlan } from './executionplan.mjs';
import { buildStatePrecondition } from './reviewintegrity.mjs';
import { readCommittedDecision } from './decisionstore.mjs';
import { publishRevisionBundle } from './revisionstore.mjs';

export const REVISION_DRAFT_ID = 'review-draft';

// ---------- 草稿创建（reviewflow 在 reviewer 返回 revise + revision 请求后调用） ----------

// validation 类型由控制器在草稿创建时确定性给出（P2-19：Validation Runner 不得自行选择运行类型）：
// EVALS_PASSED 父 run + 仅追加 eval → supplemental_verification（验证通过即接受原 run）；
// 其余（STOPPED 父 run、含 agent_review 追加、correction）→ coding_baseline（走一期启动语义）。
export function decideValidationKind(state, revisionRequest) {
  const appendedEvals = Array.isArray(revisionRequest?.appended_evals) ? revisionRequest.appended_evals : [];
  const appendedAgentReview = Array.isArray(revisionRequest?.appended_agent_review) ? revisionRequest.appended_agent_review : [];
  return (state.status === 'EVALS_PASSED' && appendedEvals.length > 0 && appendedAgentReview.length === 0)
    ? 'supplemental_verification'
    : 'coding_baseline';
}

export function createRevisionDraft({ projectDir, runId, state, proposal, proposalHash, revisionRequest, inputManifestHash, validationKind = 'coding_baseline' }) {
  const candidate = state.candidate_commit ?? state.last_checkpoint;
  const appendedEvals = Array.isArray(revisionRequest?.appended_evals) ? revisionRequest.appended_evals : [];
  const appendedAgentReview = Array.isArray(revisionRequest?.appended_agent_review) ? revisionRequest.appended_agent_review : [];
  const mapping = revisionRequest?.finding_mapping && typeof revisionRequest.finding_mapping === 'object'
    ? revisionRequest.finding_mapping : {};
  if (appendedEvals.length === 0 && appendedAgentReview.length === 0) {
    return { ok: false, reason: 'empty_revision' };
  }

  // 只追加：既有条目 id 冲突由 validator 拒绝；映射只能指向本次追加的新 id（机械阻断）
  const appendedIds = new Set([...appendedEvals, ...appendedAgentReview].map((e) => e?.id).filter(Boolean));
  const items = proposal.findings.map((f) => {
    const mapped = Array.isArray(mapping[f.id]) ? mapping[f.id] : [];
    const unknown = mapped.filter((id) => !appendedIds.has(id));
    return {
      id: f.id, summary: f.summary,
      disposition: mapped.length > 0 ? 'apply' : 'escalate',
      mapped_to: mapped, evidence_refs: f.evidence_refs, note: null,
      _unknown: unknown,
    };
  });
  const badMapping = items.filter((i) => i._unknown.length > 0);
  if (badMapping.length > 0) {
    return { ok: false, reason: 'mapping_to_unknown_ids', items: badMapping.map((i) => ({ id: i.id, unknown: i._unknown })) };
  }
  const feedback = {
    schema_version: 1,
    feedback_id: `feedback-${randomBytes(6).toString('hex')}`,
    parent_run_id: runId,
    created_at: new Date().toISOString(),
    source: { kind: 'review_finding', reference: proposal.proposal_id, content_hash: proposalHash },
    items: items.map(({ _unknown, ...rest }) => rest),
  };
  const feedbackValidation = validateReviewArtifact('feedback_pack', feedback);
  if (!feedbackValidation.ok) return { ok: false, reason: 'invalid_feedback_pack', errors: feedbackValidation.errors };
  const feedbackHash = artifactHash(feedback);

  // 控制器复制 parent 既有字段（逐字节保留），provenance 由控制器生成（content-addressed，S9）
  const parent = state.spec;
  const spec = {
    schema_version: 2,
    goal_id: parent.goal_id,
    task: parent.task,
    base_commit: candidate,
    budgets: parent.budgets,
    ...(parent.setup ? { setup: parent.setup } : {}),
    protected_paths: parent.protected_paths ?? [],
    evals: [...parent.evals, ...appendedEvals],
    manual_review: parent.manual_review ?? [],
    out_of_scope: parent.out_of_scope ?? [],
    ...((parent.agent_review ?? []).length + appendedAgentReview.length > 0
      ? { agent_review: [...(parent.agent_review ?? []), ...appendedAgentReview] }
      : {}),
    provenance: {
      parent_run: { run_id: runId, goal_hash: state.goal_hash, source_commit: candidate },
      feedback: [{ feedback_id: feedback.feedback_id, feedback_hash: feedbackHash }],
    },
  };
  const specValidation = validateSpecObject(spec);
  if (!specValidation.ok) return { ok: false, reason: 'draft_spec_invalid', errors: specValidation.errors };

  const { plan, execution_plan_hash: planHash } = buildExecutionPlan(specValidation.normalized, candidate);
  const validationPlan = { schema_version: 1, kind: validationKind, goal_spec_hash: specValidation.goal_hash };

  const saved = saveDraftVersion(projectDir, runId, REVISION_DRAFT_ID, {
    parent_run_id: runId,
    proposal_hash: proposalHash,
    feedback_pack_hash: feedbackHash,
    goal_spec_hash: specValidation.goal_hash,
    base_commit: candidate,
    execution_plan_hash: planHash,
    delegation_grant_hash: null,
    evidence_snapshot_hash: inputManifestHash,
    validation_plan_hash: artifactHash(validationPlan),
  });
  if (!saved.ok) return saved;

  const version = saved.bundle.draft_version;
  const dir = draftDir(projectDir, runId, REVISION_DRAFT_ID);
  atomicWrite(join(dir, `spec-v${version}.json`), JSON.stringify(specValidation.normalized, null, 2));
  atomicWrite(join(dir, `feedback-pack-v${version}.json`), JSON.stringify(feedback, null, 2));
  atomicWrite(join(dir, `validation-plan-v${version}.json`), JSON.stringify(validationPlan, null, 2));

  return {
    ok: true,
    bundle: saved.bundle,
    spec: specValidation.normalized,
    feedback,
    plan,
    validation_kind: validationKind,
    unmapped: feedback.items.filter((i) => i.disposition === 'escalate'),
  };
}

function readDraftPayloads(projectDir, runId, version) {
  const dir = draftDir(projectDir, runId, REVISION_DRAFT_ID);
  const specPath = join(dir, `spec-v${version}.json`);
  const packPath = join(dir, `feedback-pack-v${version}.json`);
  const planPath = join(dir, `validation-plan-v${version}.json`);
  if (!existsSync(specPath) || !existsSync(packPath) || !existsSync(planPath)) {
    return { ok: false, reason: 'draft_payload_missing' };
  }
  try {
    return {
      ok: true,
      spec: JSON.parse(readFileSync(specPath, 'utf8')),
      feedback: JSON.parse(readFileSync(packPath, 'utf8')),
      validationPlan: JSON.parse(readFileSync(planPath, 'utf8')),
    };
  } catch {
    return { ok: false, reason: 'draft_payload_corrupt' };
  }
}

// 加载并完整校验当前草稿：bundle 自洽 + 三份载荷与 bundle 内 hash 逐一绑定（篡改即拒绝）。
export function loadVerifiedDraft(projectDir, runId) {
  const version = latestDraftVersion(projectDir, runId, REVISION_DRAFT_ID);
  if (version === 0) return { ok: false, reason: 'no_draft' };
  const draft = readDraftVersion(projectDir, runId, REVISION_DRAFT_ID, version);
  if (!draft.ok) return { ok: false, reason: `draft_${draft.reason}` };
  const payloads = readDraftPayloads(projectDir, runId, version);
  if (!payloads.ok) return payloads;

  const specValidation = validateSpecObject(payloads.spec);
  if (!specValidation.ok || specValidation.goal_hash !== draft.bundle.goal_spec_hash) {
    return { ok: false, reason: 'draft_spec_tampered' };
  }
  if (artifactHash(payloads.feedback) !== draft.bundle.feedback_pack_hash) {
    return { ok: false, reason: 'draft_pack_tampered' };
  }
  if (artifactHash(payloads.validationPlan) !== draft.bundle.validation_plan_hash) {
    return { ok: false, reason: 'draft_plan_kind_tampered' };
  }
  const { plan, execution_plan_hash: planHash } = buildExecutionPlan(specValidation.normalized, draft.bundle.base_commit);
  if (planHash !== draft.bundle.execution_plan_hash) {
    return { ok: false, reason: 'draft_plan_tampered' };
  }
  return { ok: true, version, bundle: draft.bundle, payloads, normalized: specValidation.normalized, plan, validation_kind: payloads.validationPlan.kind };
}

// ---------- 批准视图（normal path 不出现任何 hash） ----------

export function renderDraftApprovalView({ runId, state, bundle, spec, feedback, plan }) {
  const parentEvalIds = new Set(state.spec.evals.map((e) => e.id));
  const parentAgentIds = new Set((state.spec.agent_review ?? []).map((a) => a.id));
  const newEvals = spec.evals.filter((e) => !parentEvalIds.has(e.id));
  const newAgent = (spec.agent_review ?? []).filter((a) => !parentAgentIds.has(a.id));
  const unmapped = feedback.items.filter((i) => i.disposition === 'escalate');

  const L = [];
  L.push(`Revision Draft（版本 ${bundle.draft_version}）——来源 run：${runId}`);
  L.push('');
  L.push(`原始意图（task 原文，逐字节保留）：${state.spec.task}`);
  L.push('');
  L.push('规格变化摘要（只追加，既有 target/invariant/manual review/out-of-scope 未被修改）：');
  for (const e of newEvals) {
    L.push(`  + eval ${e.id}（${e.role}）：${Array.isArray(e.command) ? e.command.join(' ') : e.command}`);
  }
  for (const a of newAgent) {
    L.push(`  + agent_review ${a.id}${a.required ? '（required）' : ''}：${a.criterion}`);
  }
  L.push('');
  if (unmapped.length) {
    L.push('未映射内容（未被任何新检查覆盖，须人工自行判断）：');
    for (const i of unmapped) L.push(`  - ${i.id}：${i.summary}`);
  } else {
    L.push('未映射内容：无（全部 apply 项已映射到新检查）');
  }
  L.push('');
  L.push('完整 Execution Plan（批准即授权对该精确计划执行 baseline 与未来 run 的既定次数）：');
  for (const line of renderExecutionPlan(plan)) L.push(`  ${line}`);
  L.push('');
  L.push('机器只保证 Pack 内每个 apply 项已映射或被机械阻断，不能证明模型抽取了你的全部真实意图；');
  L.push('请对照上方原始意图与变化摘要自行核对。批准命令（批准"当前展示版本"，草稿任何变化都会使批准失效）：');
  L.push(`  loop approve ${runId} --approve-execution`);
  return L.join('\n');
}

// ---------- 批准执行链 ----------

const SEMANTIC_FAIL = ['all_targets_met', 'invariant_broken'];

export async function approveRevision({
  repo, runId, approveExecution = false, manualReviewResults = [],
  baselineRunner = runBaseline, evalRunner = null,
}) {
  const common = gitCommonDir(repo);
  if (!common) return { ok: false, message: '不是 Git 仓库' };
  const projectDir = projectDataDir(common);
  const stateDir = runDir(projectDir, runId);

  const stateResult = readState(stateDir);
  if (!stateResult.ok) return { ok: false, reason: 'state_unreadable' };
  const state = stateResult.state;

  const loaded = loadVerifiedDraft(projectDir, runId);
  if (!loaded.ok) {
    return loaded.reason === 'no_draft'
      ? { ok: false, reason: 'no_draft', message: '该 run 没有待批准的 Revision Draft；先执行 loop review' }
      : loaded;
  }
  const { version, bundle, payloads, normalized, plan } = loaded;

  const view = renderDraftApprovalView({
    runId, state, bundle, spec: normalized, feedback: payloads.feedback, plan,
  });
  if (!approveExecution) {
    return { ok: true, displayed: true, view, draft_version: version, validation_kind: loaded.validation_kind };
  }

  // 人批准"当前展示版本"：系统内部绑定 approval_bundle_hash（P2-13）
  const approval = recordApproval(projectDir, runId, REVISION_DRAFT_ID, version, { approveExecution: true });
  if (!approval.ok) return approval;
  const verified = verifyApprovedBundle(projectDir, runId, REVISION_DRAFT_ID, approval.approval);
  if (!verified.ok) return { ok: false, reason: verified.reason, view };

  // 类型分流（P2-19）：同一批准协议，验证型与 coding 使用不同的上层 result adapter
  if (loaded.validation_kind === 'supplemental_verification') {
    const { runSupplementalVerification } = await import('./supplementalverification.mjs');
    return runSupplementalVerification({
      repo, projectDir, runId, state, stateChecksum: stateResult.checksum,
      loaded, approval: approval.approval, manualReviewResults, evalRunner,
    });
  }

  // coding baseline（批准之后才允许执行任何代码，P2-12）
  const draft = { bundle };
  const specValidation = { normalized, goal_hash: bundle.goal_spec_hash, flags: { shell: normalized.evals.some((e) => e.shell === true), setup: 'setup' in normalized } };
  const baseline = await baselineRunner(specValidation.normalized, { repo });
  if (SEMANTIC_FAIL.includes(baseline.verdict)) {
    return {
      ok: false, reason: 'baseline_semantic_failed', verdict: baseline.verdict,
      message: `${baseline.message}\n草稿未冻结；请用 loop review ${runId} --direction "<意见>" 重提案，或直接人工决定`,
    };
  }
  if (baseline.verdict !== 'startable') {
    return {
      ok: false, reason: 'baseline_infra_failed', retryable: true, verdict: baseline.verdict,
      message: `${baseline.message}\n基础设施失败：草稿与批准保留，修复环境后可对完全相同版本精确重试`,
    };
  }

  // 二次 conditional match + decision slot（baseline 期间草稿变化 → 结果作废，P2-13）
  const recheck = verifyApprovedBundle(projectDir, runId, REVISION_DRAFT_ID, approval.approval);
  if (!recheck.ok) return { ok: false, reason: `post_baseline_${recheck.reason}` };
  const slot = readCommittedDecision(projectDir, runId);
  if (!slot.ok) return { ok: false, reason: 'committed_corrupt' };
  if (slot.exists) return { ok: false, reason: 'review_conflict', existing: slot.record };

  // YAML 往返自检：发布的 spec 文本重新走完整 parser/validator 必须复现同一 goal_hash（fail closed）
  const specYaml = emitYaml(payloads.spec);
  const roundtrip = validateSpecText(specYaml);
  if (!roundtrip.ok || roundtrip.goal_hash !== draft.bundle.goal_spec_hash) {
    return { ok: false, reason: 'yaml_roundtrip_mismatch' };
  }

  const decision = {
    schema_version: 1,
    decision_id: `decision-${randomBytes(6).toString('hex')}`,
    run_id: runId,
    goal_hash: state.goal_hash,
    source_commit: draft.bundle.base_commit,
    outcome: 'revise',
    manual_review_results: [],
    decided_at: new Date().toISOString(),
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: draft.bundle.proposal_hash,
    approval_bundle_hash: draft.bundle.approval_bundle_hash,
    basis: { original_goal_hash: state.goal_hash, supplemental_verification: null },
    note: null,
  };
  const published = await publishRevisionBundle(projectDir, runId, {
    operationId: `review-op-${randomBytes(6).toString('hex')}`,
    decision,
    expectedStateChecksum: stateResult.checksum,
    applyStateUpdate: buildStatePrecondition(stateDir),
    approvalBundleHash: draft.bundle.approval_bundle_hash,
    feedbackPackYaml: emitYaml(payloads.feedback),
    goalSpecYaml: specYaml,
    baselineResultJson: JSON.stringify({ verdict: baseline.verdict, base_commit: baseline.base_commit, message: baseline.message }, null, 2),
  });
  if (!published.ok) return published;

  const committedSpecPath = join(projectDir, 'decisions', runId, 'committed', 'revision', 'goal-spec.yaml');
  const needsAllowShell = specValidation.flags.shell || specValidation.flags.setup;
  return {
    ok: true,
    frozen: true,
    decision: published.record,
    committed_spec_path: committedSpecPath,
    // 不自动启动（P2-16）：只输出显式启动命令
    start_command: `node ${join(new URL('..', import.meta.url).pathname, 'loop.mjs')} goal --spec "${committedSpecPath}"${needsAllowShell ? ' --allow-shell' : ''}`,
  };
}

// ---------- 极简 YAML 发射器（仅覆盖本插件资产形态；发布前有完整 parser 往返自检兜底） ----------

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value); // 双引号标量是合法 YAML，且与 yaml.mjs 的解析行为一致
}

export function emitYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        const [firstKey, firstVal] = entries[0];
        const first = isNested(firstVal)
          ? `${pad}- ${firstKey}:\n${emitYaml(firstVal, indent + 4)}`
          : `${pad}- ${firstKey}: ${yamlScalar(firstVal)}`;
        const rest = entries.slice(1).map(([k, v]) => isNested(v)
          ? `${pad}  ${k}:\n${emitYaml(v, indent + 4)}`
          : `${pad}  ${k}: ${yamlScalar(v)}`);
        return [first, ...rest].join('\n');
      }
      return `${pad}- ${yamlScalar(item)}`;
    }).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => isNested(v)
      ? `${pad}${k}:\n${emitYaml(v, indent + 2)}`
      : `${pad}${k}: ${yamlScalar(v)}`).join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

function isNested(v) {
  return v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}
