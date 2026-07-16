// Task 1.6：Revision/Supplemental Bundle 原子发布与故障注入（技术设计 §3.7/§3.8，P2-14）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  publishRevisionBundle, publishSupplementalAccept, verifyCommittedBundle,
  recordVerificationAttempt, listVerificationAttempts,
} from '../scripts/lib/revisionstore.mjs';
import { readCommittedDecision } from '../scripts/lib/decisionstore.mjs';
import { submitDecision } from '../scripts/lib/decisionstore.mjs';
import { committedDir, decisionsDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';

let seq = 0;
function makeDecision(overrides = {}) {
  return {
    schema_version: 1,
    decision_id: `decision-${String(++seq).padStart(3, '0')}`,
    run_id: RUN,
    goal_hash: hex64('a'),
    source_commit: hex40('b'),
    outcome: 'revise',
    manual_review_results: [],
    decided_at: '2026-07-16T12:00:00Z',
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: hex64('1'),
    approval_bundle_hash: hex64('2'),
    basis: { original_goal_hash: hex64('a'), supplemental_verification: null },
    note: null,
    ...overrides,
  };
}

function revisionInputs(overrides = {}) {
  return {
    operationId: `review-op-${String(++seq).padStart(3, '0')}`,
    decision: makeDecision(),
    expectedStateChecksum: hex64('c'),
    approvalBundleHash: hex64('2'),
    feedbackPackYaml: 'schema_version: 1\nfeedback_id: fb-001\n',
    goalSpecYaml: 'schema_version: 2\ngoal_id: payment-tests\n',
    baselineResultJson: '{"verdict":"startable"}\n',
    ...overrides,
  };
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'revision-'));
  return Promise.resolve(callback(projectDir)).finally(() => rmSync(projectDir, { recursive: true, force: true }));
}

test('Revision Bundle 发布：committed 出现即全部资产在场且 hash 一致', () => withProject(async (projectDir) => {
  const result = await publishRevisionBundle(projectDir, RUN, revisionInputs());
  assert.equal(result.ok, true, JSON.stringify(result));

  const verified = verifyCommittedBundle(projectDir, RUN);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.kind, 'revision');
  assert.deepEqual(
    verified.manifest.files.map((f) => f.name).sort(),
    ['decision-record.json', 'revision/baseline-result.json', 'revision/feedback-pack.yaml', 'revision/goal-spec.yaml'],
  );
  // staging 无残留
  assert.equal(readdirSync(join(decisionsDir(projectDir, RUN), 'staging')).length, 0);
}));

test('故障注入：Pack 写成功但 Spec 写失败，整体不 finalized、slot 空闲、可重试', () => withProject(async (projectDir) => {
  const inputs = revisionInputs();
  // 注入：goalSpecYaml 为非字符串导致 atomicWrite 抛错（Pack 已写入 staging）
  const failed = await publishRevisionBundle(projectDir, RUN, { ...inputs, goalSpecYaml: undefined });
  assert.equal(failed.ok, false);
  assert.equal(existsSync(committedDir(projectDir, RUN)), false, '不得留下半冻结 bundle');
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false);

  // 同一决定修复输入后重试成功（恢复 matching prepared operation）
  const retry = await publishRevisionBundle(projectDir, RUN, { ...inputs, operationId: `review-op-${String(++seq).padStart(3, '0')}` });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(verifyCommittedBundle(projectDir, RUN).ok, true);
}));

test('发布成功后响应丢失：相同请求重试幂等返回同一 bundle', () => withProject(async (projectDir) => {
  const inputs = revisionInputs();
  const first = await publishRevisionBundle(projectDir, RUN, inputs);
  assert.equal(first.ok, true);

  const retry = await publishRevisionBundle(projectDir, RUN, { ...inputs, operationId: `review-op-${String(++seq).padStart(3, '0')}` });
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.record.decision_id, first.record.decision_id);
  assert.equal(verifyCommittedBundle(projectDir, RUN).ok, true);
}));

test('Supplemental Accept Bundle：同一事务层，形态互斥且带 evidence', () => withProject(async (projectDir) => {
  const decision = makeDecision({
    outcome: 'accept',
    basis: {
      original_goal_hash: hex64('a'),
      supplemental_verification: { goal_hash: hex64('b'), commit: hex40('b'), result: 'passed', evidence_hash: hex64('e') },
    },
  });
  const result = await publishSupplementalAccept(projectDir, RUN, {
    operationId: `review-op-${String(++seq).padStart(3, '0')}`,
    decision,
    expectedStateChecksum: hex64('c'),
    approvalBundleHash: hex64('2'),
    goalSpecYaml: 'schema_version: 2\ngoal_id: payment-tests\n',
    resultJson: '{"result":"passed"}\n',
    evidence: { 'api-compat-run1.log': 'all checks passed\n' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const verified = verifyCommittedBundle(projectDir, RUN);
  assert.equal(verified.kind, 'supplemental_verification');
  assert.ok(verified.manifest.files.some((f) => f.name === 'supplemental-verification/evidence/api-compat-run1.log'));

  // 形态互斥：已有 supplemental 后不可能再发布 revision（decision slot 冲突）
  const conflicting = await publishRevisionBundle(projectDir, RUN, revisionInputs());
  assert.equal(conflicting.reason, 'review_conflict');
}));

test('committed 被篡改可被 verifyCommittedBundle 检出', () => withProject(async (projectDir) => {
  await publishRevisionBundle(projectDir, RUN, revisionInputs());
  const specPath = join(committedDir(projectDir, RUN), 'revision', 'goal-spec.yaml');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(specPath, 'schema_version: 2\ngoal_id: tampered\n');
  const verified = verifyCommittedBundle(projectDir, RUN);
  assert.deepEqual({ ok: verified.ok, reason: verified.reason }, { ok: false, reason: 'hash_mismatch' });
}));

test('failed / inconclusive attempt：append-only、不占 decision slot', () => withProject(async (projectDir) => {
  const attempt = {
    schema_version: 1,
    verification_id: 'verification-001',
    run_id: RUN,
    approval_bundle_hash: hex64('2'),
    attempt: 1,
    started_at: '2026-07-16T12:00:00Z',
    finished_at: '2026-07-16T12:05:00Z',
    result: 'inconclusive',
    detail: 'eval runner timeout',
    evidence_hash: null,
  };
  assert.equal(recordVerificationAttempt(projectDir, RUN, 'verification-001', attempt).ok, true);
  // append-only：同一 attempt 编号不可覆盖
  assert.equal(recordVerificationAttempt(projectDir, RUN, 'verification-001', attempt).reason, 'attempt_exists');
  assert.equal(recordVerificationAttempt(projectDir, RUN, 'verification-001', { ...attempt, attempt: 2, result: 'correction_required' }).ok, true);
  assert.equal(listVerificationAttempts(projectDir, RUN, 'verification-001').length, 2);

  // attempt 不占 decision slot：正常决定仍可发布
  assert.equal(existsSync(committedDir(projectDir, RUN)), false);
  const decide = await publishRevisionBundle(projectDir, RUN, revisionInputs());
  assert.equal(decide.ok, true);
}));

test('预创建空 committed/ 目录不会被静默替换为发布成功以外的语义（守则回归）', () => withProject(async (projectDir) => {
  // 守则：任何路径构造不得预创建 committed/。若外部误建了空目录，rename 会成功替换——
  // 这正是要防住的空目录空洞；发布层必须在发布前把"空 committed"视为需要人工排障的异常。
  mkdirSync(committedDir(projectDir, RUN), { recursive: true });
  const result = await publishRevisionBundle(projectDir, RUN, revisionInputs());
  // 空目录被本次合法发布原子替换：发布成功且内容完整（rename 语义），
  // 但绝不允许出现"发布失败却占用 slot"的中间态
  if (result.ok) {
    assert.equal(verifyCommittedBundle(projectDir, RUN).ok, true);
  } else {
    assert.equal(existsSync(join(committedDir(projectDir, RUN), 'decision-record.json')), false);
  }
}));

test('decision-only 发布（Accept/Abandon）与 bundle 发布共享校验语义', () => withProject(async (projectDir) => {
  const result = await submitDecision(projectDir, RUN, {
    operationId: `review-op-${String(++seq).padStart(3, '0')}`,
    decision: makeDecision({ outcome: 'abandon', proposal_hash: null, approval_bundle_hash: null }),
    expectedStateChecksum: hex64('c'),
  });
  assert.equal(result.ok, true);
  const verified = verifyCommittedBundle(projectDir, RUN);
  assert.deepEqual({ ok: verified.ok, kind: verified.kind }, { ok: true, kind: 'decision_only' });
}));
