// Task 1.1：review artifact schema、路径单一来源与 canonical hash（技术设计 §2/§3.1/§3.2/§3.6）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import {
  loadReviewSchema, validateReviewArtifact, artifactHash,
  computeApprovalBundleHash, computeDecisionHash,
  runDir, runReviewLockParent, decisionsDir, operationsDir, operationPath,
  committedDir, committedDecisionRecordPath, committedRevisionDir, committedSupplementalDir,
  stagingDir, reviewsDir, factPackDir, proposalPath, draftDir,
  verificationAttemptsDir, delegationGrantPath,
} from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);

function validDecision() {
  return {
    schema_version: 1,
    decision_id: 'decision-001',
    run_id: 'payment-tests-a1b2c3d4',
    goal_hash: hex64('a'),
    source_commit: hex40('b'),
    outcome: 'accept',
    manual_review_results: [{
      item: 'Confirm the public payment API remains source-compatible',
      passed: true,
      passed_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
      note: null,
    }],
    decided_at: '2026-07-16T12:00:00Z',
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: null,
    approval_bundle_hash: null,
    basis: { original_goal_hash: hex64('a'), supplemental_verification: null },
    note: null,
  };
}

function validOperation() {
  const decision = validDecision();
  return {
    operation_id: 'review-op-001',
    protocol_version: 1,
    run_id: 'payment-tests-a1b2c3d4',
    outcome: 'accept',
    expected_state_checksum: hex64('c'),
    grant: null,
    decision_payload: { decision_hash: computeDecisionHash(decision), decision },
    phase: 'prepared',
  };
}

function validFeedbackPack() {
  return {
    schema_version: 1,
    feedback_id: 'payment-review-001',
    parent_run_id: 'payment-tests-a1b2c3d4',
    created_at: '2026-07-16T12:00:00Z',
    source: { kind: 'review_finding', reference: null, content_hash: null },
    items: [{
      id: 'finding-001',
      summary: 'Public API compatibility is not covered by evals',
      disposition: 'apply',
      mapped_to: ['api-compat'],
      evidence_refs: ['diff:src/api.ts'],
      note: null,
    }],
  };
}

function validBundle() {
  const bundle = {
    schema_version: 1,
    draft_id: 'review-draft-1',
    draft_version: 3,
    parent_run_id: 'payment-tests-a1b2c3d4',
    proposal_hash: hex64('1'),
    feedback_pack_hash: hex64('2'),
    goal_spec_hash: hex64('3'),
    base_commit: hex40('4'),
    execution_plan_hash: hex64('5'),
    delegation_grant_hash: null,
    evidence_snapshot_hash: hex64('6'),
    validation_plan_hash: hex64('7'),
  };
  bundle.approval_bundle_hash = computeApprovalBundleHash(bundle);
  return bundle;
}

function validManifest() {
  return {
    schema_version: 1,
    kind: 'revision',
    decision_id: 'decision-001',
    approval_bundle_hash: hex64('8'),
    files: [
      { name: 'feedback-pack.yaml', sha256: hex64('9') },
      { name: 'goal-spec.yaml', sha256: hex64('0') },
    ],
  };
}

function validVerification() {
  return {
    schema_version: 1,
    verification_id: 'verification-001',
    run_id: 'payment-tests-a1b2c3d4',
    approval_bundle_hash: hex64('8'),
    attempt: 1,
    started_at: '2026-07-16T12:00:00Z',
    finished_at: '2026-07-16T12:05:00Z',
    result: 'inconclusive',
    detail: 'eval runner timeout',
    evidence_hash: null,
  };
}

const FIXTURES = {
  decision_record: validDecision,
  review_operation: validOperation,
  feedback_pack: validFeedbackPack,
  approval_bundle: validBundle,
  revision_manifest: validManifest,
  verification_record: validVerification,
};

test('六类 artifact 的合法 fixture 全部通过校验', () => {
  for (const [kind, make] of Object.entries(FIXTURES)) {
    const result = validateReviewArtifact(kind, make());
    assert.deepEqual(result.errors, [], `${kind} 应通过`);
    assert.equal(result.ok, true);
  }
});

test('全部 schema 声明 additionalProperties: false，未知字段被拒绝', () => {
  for (const [kind, make] of Object.entries(FIXTURES)) {
    assert.equal(loadReviewSchema(kind).additionalProperties, false, `${kind} schema 顶层`);
    const mutated = { ...make(), unexpected_field: true };
    const result = validateReviewArtifact(kind, mutated);
    assert.equal(result.ok, false, `${kind} 应拒绝未知字段`);
  }
});

test('decision record：agent 委托形态合法，非法 outcome 被拒绝', () => {
  const delegated = {
    ...validDecision(),
    outcome: 'revise',
    decided_by: { kind: 'agent', session_id: 'review-session-123', authorization: 'bounded_delegate' },
    authorization: { grant_id: 'review-grant-001', grant_hash: hex64('e') },
    proposal_hash: hex64('f'),
    approval_bundle_hash: hex64('d'),
  };
  assert.equal(validateReviewArtifact('decision_record', delegated).ok, true);

  const badOutcome = { ...validDecision(), outcome: 'merge' };
  assert.equal(validateReviewArtifact('decision_record', badOutcome).ok, false);
});

test('manual honesty：manual_review_results 的 passed_by.kind 只能是 local_user（P2-11）', () => {
  const forged = validDecision();
  forged.manual_review_results = [{
    item: 'Confirm the public payment API remains source-compatible',
    passed: true,
    passed_by: { kind: 'agent', claimed_id: null, identity_verified: false },
    note: null,
  }];
  assert.equal(validateReviewArtifact('decision_record', forged).ok, false);
});

test('operation journal：嵌套 decision payload 被完整二次校验', () => {
  const op = validOperation();
  op.decision_payload.decision.outcome = 'merge';
  const result = validateReviewArtifact('review_operation', op);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.startsWith('$.decision_payload.decision')));

  const badPhase = { ...validOperation(), phase: 'finalized' };
  assert.equal(validateReviewArtifact('review_operation', badPhase).ok, false);
});

test('supplemental basis：verification-only Accept 的双规格引用合法（P2-22）', () => {
  const supplemental = validDecision();
  supplemental.basis = {
    original_goal_hash: hex64('a'),
    supplemental_verification: {
      goal_hash: hex64('b'), commit: hex40('c'), result: 'passed', evidence_hash: hex64('d'),
    },
  };
  assert.equal(validateReviewArtifact('decision_record', supplemental).ok, true);
});

test('approval_bundle_hash 覆盖全部内容字段，且不受键序与自身字段影响', () => {
  const bundle = validBundle();
  const baseline = computeApprovalBundleHash(bundle);

  // 键序不敏感
  const reordered = Object.fromEntries(Object.entries(bundle).reverse());
  assert.equal(computeApprovalBundleHash(reordered), baseline);

  // 自身字段不进入哈希
  assert.equal(computeApprovalBundleHash({ ...bundle, approval_bundle_hash: hex64('f') }), baseline);

  // 每个内容字段变化都改变哈希（Task 1.1 验收：Pack、Spec、base、Execution Plan、
  // 可选 Delegation Grant、evidence 快照与 validation plan 全覆盖）
  const mutations = {
    draft_id: 'review-draft-2',
    draft_version: 4,
    parent_run_id: 'other-run-00000000',
    proposal_hash: hex64('a'),
    feedback_pack_hash: hex64('a'),
    goal_spec_hash: hex64('a'),
    base_commit: hex40('a'),
    execution_plan_hash: hex64('a'),
    delegation_grant_hash: hex64('a'),
    evidence_snapshot_hash: hex64('a'),
    validation_plan_hash: hex64('a'),
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = { ...bundle, [field]: value };
    assert.notEqual(computeApprovalBundleHash(mutated), baseline, `${field} 变化应改变 approval_bundle_hash`);
  }
});

test('artifactHash 与 decision_hash 对键序稳定', () => {
  const decision = validDecision();
  const reordered = Object.fromEntries(Object.entries(decision).reverse());
  assert.equal(computeDecisionHash(reordered), computeDecisionHash(decision));
  assert.notEqual(artifactHash({ a: 1 }), artifactHash({ a: 2 }));
});

test('路径单一来源：staging、committed、operations、review lock、grant 互不混淆', () => {
  const projectDir = `${sep}tmp${sep}project-data`;
  const runId = 'payment-tests-a1b2c3d4';

  const paths = [
    runDir(projectDir, runId),
    decisionsDir(projectDir, runId),
    operationsDir(projectDir, runId),
    operationPath(projectDir, runId, 'review-op-001'),
    committedDir(projectDir, runId),
    committedDecisionRecordPath(projectDir, runId),
    committedRevisionDir(projectDir, runId),
    committedSupplementalDir(projectDir, runId),
    stagingDir(projectDir, runId, 'tx-001'),
    reviewsDir(projectDir, runId),
    factPackDir(projectDir, runId, 'fact-pack-001'),
    proposalPath(projectDir, runId, 'proposal-001'),
    draftDir(projectDir, runId, 'review-draft-1'),
    verificationAttemptsDir(projectDir, runId, 'verification-001'),
    delegationGrantPath(projectDir, 'review-grant-001'),
  ];
  assert.equal(new Set(paths).size, paths.length, '全部路径应互不相同');

  // finalized 与 staging 物理分离，但共享同一父目录（原子 rename 的同卷前提，§3.7）
  const committed = committedDir(projectDir, runId);
  const staging = stagingDir(projectDir, runId, 'tx-001');
  assert.ok(!staging.startsWith(committed + sep));
  assert.ok(!committed.startsWith(staging + sep));
  assert.ok(committed.startsWith(decisionsDir(projectDir, runId) + sep));
  assert.ok(staging.startsWith(decisionsDir(projectDir, runId) + sep));

  // review lock 挂在 run 目录（一期 state 同处），不在 decisions/ 下
  assert.equal(runReviewLockParent(projectDir, runId), runDir(projectDir, runId));

  // review 资产与 decision 资产分树，run 执行资产不与 review 资产混放
  assert.ok(reviewsDir(projectDir, runId).startsWith(`${projectDir}${sep}reviews${sep}`));
  assert.ok(delegationGrantPath(projectDir, 'g').startsWith(`${projectDir}${sep}delegation-grants${sep}`));
});
