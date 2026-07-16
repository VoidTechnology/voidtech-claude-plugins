// Task 1.4：Accept/Abandon 事务迁移、恢复矩阵故障注入与 integrity 分离
// （技术设计 §3.5，P2-24/P2-25/P2-26）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { acceptRun, abandonRun, getStatus } from '../scripts/lib/lifecycle.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, readState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir, committedDecisionRecordPath } from '../scripts/lib/reviewstore.mjs';
import { buildOperation, writeOperation, readOperation } from '../scripts/lib/reviewoperation.mjs';
import { submitDecision, readCommittedDecision } from '../scripts/lib/decisionstore.mjs';
import { classifyReviewIntegrity, recoverRunReview } from '../scripts/lib/reviewintegrity.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';

// 与 acceptRun 内部构造完全一致的决定（幂等键可复现），用于伪造"崩溃残留"的 prepared operation。
function acceptDecisionLike(state, { manualReviewResults = [], note = null } = {}) {
  return {
    schema_version: 1,
    decision_id: 'decision-crashed01',
    run_id: RUN,
    goal_hash: state.goal_hash,
    source_commit: state.candidate_commit,
    outcome: 'accept',
    manual_review_results: manualReviewResults,
    decided_at: '2026-07-16T11:00:00Z',
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: null,
    approval_bundle_hash: null,
    basis: { original_goal_hash: state.goal_hash, supplemental_verification: null },
    note,
  };
}

// 每个用例一个独立 repo + 数据根；直接落 seed state，不跑真实循环。
async function withSeededRun(seedOverrides, callback) {
  await withDataRoot(async () => {
    const { repo } = makeTestRepo({ prefix: 'review-rec-', files: { 'README.md': 'seed\n' } });
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const seed = {
        state_version: STATE_VERSION,
        run_id: RUN,
        status: 'EVALS_PASSED',
        goal_hash: hex64('a'),
        base_commit: hex40('1'),
        last_checkpoint: hex40('2'),
        candidate_commit: hex40('2'),
        branch: 'loop/payment-tests',
        worktree: '/tmp/wt',
        iteration: 3,
        started_at: '2026-07-16T10:00:00Z',
        spec: { goal_id: 'payment-tests', task: 'fix', manual_review: [], out_of_scope: [] },
        rounds: [],
        cost: { total_usd: 0, unavailable: true },
        ...seedOverrides,
      };
      writeState(stateDir, seed);
      await callback({ repo, projectDir, stateDir, seed });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('accept 全路径：state 迁移 + Decision Record + report 呈现两类 integrity', () => withSeededRun({}, async ({ repo, projectDir, stateDir }) => {
  const acc = await acceptRun({ repo, runId: RUN });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  assert.equal(acc.state.status, 'ACCEPTED');
  assert.equal(acc.state.review_protocol_version, 1);
  assert.equal(acc.review.run_integrity, 'ok');
  assert.equal(acc.review.review_integrity, 'committed');

  const op = readOperation(projectDir, RUN, acc.state.decision_ref.operation_id);
  assert.equal(op.operation.phase, 'committed');

  const report = readFileSync(join(stateDir, 'report.md'), 'utf8');
  assert.match(report, /run_integrity/);
  assert.match(report, /review_integrity/);
  assert.match(report, /local_user（identity_verified: false）/);
}));

test('manual review 完整性：缺结果拒绝，规格外条目拒绝，补全后可接受', () => withSeededRun({
  spec: { goal_id: 'g', task: 't', manual_review: ['Check API compatibility'], out_of_scope: [] },
}, async ({ repo }) => {
  const missing = await acceptRun({ repo, runId: RUN });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'manual_review_incomplete');
  assert.deepEqual(missing.missing, ['Check API compatibility']);

  const extra = await acceptRun({
    repo, runId: RUN,
    manualReviewResults: [{ item: 'Check API compatibility', passed: true }, { item: 'Invented item', passed: true }],
  });
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ['Invented item']);

  const done = await acceptRun({ repo, runId: RUN, manualReviewResults: [{ item: 'Check API compatibility', passed: true }] });
  assert.equal(done.ok, true);
  assert.equal(done.decision.manual_review_results[0].passed_by.kind, 'local_user');
}));

test('恢复行 3：prepared Accept + EVALS_PASSED，重试恢复原 operation 并发布原决定', () => withSeededRun({}, async ({ repo, projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const crashed = acceptDecisionLike(seedState.state);
  writeOperation(projectDir, RUN, buildOperation({
    operationId: 'review-op-crashed', runId: RUN, outcome: 'accept',
    expectedStateChecksum: seedState.checksum, decision: crashed,
  }));
  assert.equal(classifyReviewIntegrity(projectDir, RUN, seedState).review_integrity, 'prepared');

  const retry = await acceptRun({ repo, runId: RUN });
  assert.equal(retry.ok, true);
  assert.equal(retry.decision.decision_id, 'decision-crashed01', '必须发布崩溃前的原决定');
  assert.equal(retry.state.decision_ref.operation_id, 'review-op-crashed');
}));

test('恢复行 4：prepared Accept + state 已 ACCEPTED（Record 未发布），恢复发布同一 Record', () => withSeededRun({}, async ({ projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const crashed = acceptDecisionLike(seedState.state);
  const op = buildOperation({
    operationId: 'review-op-crashed', runId: RUN, outcome: 'accept',
    expectedStateChecksum: seedState.checksum, decision: crashed,
  });
  writeOperation(projectDir, RUN, op);
  // 模拟崩溃点：state 已迁移、Record 未发布
  writeState(stateDir, {
    ...seedState.state, status: 'ACCEPTED', accepted_at: '2026-07-16T11:00:01Z',
    review_protocol_version: 1,
    decision_ref: { operation_id: 'review-op-crashed', decision_id: crashed.decision_id, decision_hash: op.decision_payload.decision_hash },
  });
  const cls = classifyReviewIntegrity(projectDir, RUN, readState(stateDir));
  assert.deepEqual({ ri: cls.review_integrity, rec: cls.recoverable }, { ri: 'prepared', rec: true });

  const recovered = await recoverRunReview(projectDir, RUN);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.record.decision_id, crashed.decision_id);
  assert.equal(readCommittedDecision(projectDir, RUN).record.decision_id, crashed.decision_id);
  assert.equal(readOperation(projectDir, RUN, 'review-op-crashed').operation.phase, 'committed');
  assert.equal(classifyReviewIntegrity(projectDir, RUN, readState(stateDir)).review_integrity, 'committed');
}));

test('恢复行 5：committed Accept + state 落后，precondition 成立补齐，state 漂移则 fail closed', () => withSeededRun({}, async ({ projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const decision = acceptDecisionLike(seedState.state);
  // 直接经底层事务发布 Record，但注入"state 更新丢失"（applyStateUpdate 成功却不落盘）
  const published = await submitDecision(projectDir, RUN, {
    operationId: 'review-op-laggy', decision, expectedStateChecksum: seedState.checksum,
    applyStateUpdate: () => ({ ok: true }),
  });
  assert.equal(published.ok, true);
  assert.equal(readState(stateDir).state.status, 'EVALS_PASSED', '注入后 state 落后于 committed');
  const cls = classifyReviewIntegrity(projectDir, RUN, readState(stateDir));
  assert.deepEqual({ ri: cls.review_integrity, lag: cls.state_lag }, { ri: 'committed', lag: true });

  // precondition 成立：补齐 state
  const repaired = await recoverRunReview(projectDir, RUN);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, 'state');
  assert.equal(readState(stateDir).state.status, 'ACCEPTED');
}));

test('恢复行 5 负例：state 在崩溃后被第三方改动，不补齐、fail closed', () => withSeededRun({}, async ({ projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const published = await submitDecision(projectDir, RUN, {
    operationId: 'review-op-laggy', decision: acceptDecisionLike(seedState.state),
    expectedStateChecksum: seedState.checksum, applyStateUpdate: () => ({ ok: true }),
  });
  assert.equal(published.ok, true);
  // 第三方改动 state → checksum 漂移
  writeState(stateDir, { ...readState(stateDir).state, iteration: 99 });

  const repaired = await recoverRunReview(projectDir, RUN);
  assert.deepEqual({ ok: repaired.ok, reason: repaired.reason }, { ok: false, reason: 'review_damaged' });
  assert.equal(readState(stateDir).state.status, 'EVALS_PASSED', 'fail closed：不猜测修复');
}));

test('legacy Accept：分类 legacy_accepted，重复 accept 不补造 Record，abandon 拒绝', () => withSeededRun({
  status: 'ACCEPTED', accepted_at: '2026-07-01T00:00:00Z',
}, async ({ repo, projectDir }) => {
  const status = getStatus({ repo, runId: RUN });
  assert.equal(status.review.review_integrity, 'legacy_accepted');
  assert.equal(status.review.run_integrity, 'ok');

  const acc = await acceptRun({ repo, runId: RUN });
  assert.deepEqual({ ok: acc.ok, already: acc.already, legacy: acc.legacy }, { ok: true, already: true, legacy: true });
  assert.equal(existsSync(committedDecisionRecordPath(projectDir, RUN)), false, '不补造 Record');

  assert.equal((await abandonRun({ repo, runId: RUN })).ok, false);
}));

test('新协议 ACCEPTED + Record 与 operation 均缺失：review damaged，run facts 独立可读', () => withSeededRun({
  status: 'ACCEPTED', accepted_at: '2026-07-16T11:00:00Z',
  review_protocol_version: 1,
  decision_ref: { operation_id: 'review-op-gone', decision_id: 'decision-gone0001', decision_hash: hex64('e') },
}, async ({ repo }) => {
  const status = getStatus({ repo, runId: RUN });
  assert.equal(status.ok, true, 'run 执行资产仍可读');
  assert.equal(status.review.run_integrity, 'ok');
  assert.equal(status.review.review_integrity, 'damaged');
}));

test('abandon：不修改 state 与 checksum，幂等重试，其后 accept 冲突', () => withSeededRun({}, async ({ repo, stateDir }) => {
  const before = readState(stateDir);
  const ab = await abandonRun({ repo, runId: RUN, note: 'not worth merging' });
  assert.equal(ab.ok, true);
  assert.equal(ab.review.review_integrity, 'committed');
  assert.equal(ab.review.outcome, 'abandon');

  const after = readState(stateDir);
  assert.equal(after.state.status, 'EVALS_PASSED', 'run state 不被修改');
  assert.equal(after.checksum, before.checksum, 'checksum 不被修改');

  const again = await abandonRun({ repo, runId: RUN, note: 'not worth merging' });
  assert.equal(again.idempotent, true);

  const acc = await acceptRun({ repo, runId: RUN });
  assert.deepEqual({ ok: acc.ok, reason: acc.reason }, { ok: false, reason: 'review_conflict' });
}));

test('abandon 前置校验：prepared operation 的 expected checksum 失效时返回 state_changed', () => withSeededRun({}, async ({ repo, projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const decision = {
    ...acceptDecisionLike(seedState.state), outcome: 'abandon',
    source_commit: seedState.state.candidate_commit,
  };
  // 残留 prepared abandon（expected checksum 为旧值），随后 state 被合法改动
  writeOperation(projectDir, RUN, buildOperation({
    operationId: 'review-op-stale', runId: RUN, outcome: 'abandon',
    expectedStateChecksum: seedState.checksum, decision,
  }));
  writeState(stateDir, { ...seedState.state, iteration: 4 });

  const retry = await abandonRun({ repo, runId: RUN });
  assert.deepEqual({ ok: retry.ok, reason: retry.reason }, { ok: false, reason: 'state_changed' });
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false, '前置失效不得发布');
}));

test('决定替换防护：state 已被崩溃决定 A 接受时，不同 note 的重试不得改写 decision_ref', () => withSeededRun({}, async ({ repo, projectDir, stateDir }) => {
  const seedState = readState(stateDir);
  const crashed = acceptDecisionLike(seedState.state);
  const opA = buildOperation({
    operationId: 'review-op-a', runId: RUN, outcome: 'accept',
    expectedStateChecksum: seedState.checksum, decision: crashed,
  });
  writeOperation(projectDir, RUN, opA);
  // 崩溃点：state 已 ACCEPTED 且 ref 指向 op-a，Record 未发布
  writeState(stateDir, {
    ...seedState.state, status: 'ACCEPTED', accepted_at: '2026-07-16T11:00:01Z',
    review_protocol_version: 1,
    decision_ref: { operation_id: 'review-op-a', decision_id: crashed.decision_id, decision_hash: opA.decision_payload.decision_hash },
  });

  // 带不同 note 的重试：幂等键不同 → 不是同一决定，必须拒绝而非替换
  const replaced = await acceptRun({ repo, runId: RUN, note: 'different intent' });
  assert.deepEqual({ ok: replaced.ok, reason: replaced.reason }, { ok: false, reason: 'state_changed' });
  assert.equal(readState(stateDir).state.decision_ref.operation_id, 'review-op-a', 'ref 不得被改写');
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false, '不得发布替换决定');

  // 原决定（相同幂等键）的重试仍可正常恢复
  const recovered = await acceptRun({ repo, runId: RUN });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.decision.decision_id, crashed.decision_id);
}));

test('冲突 finalized decision：state ref 与 committed record 不一致时标记 conflict', () => withSeededRun({}, async ({ repo, stateDir }) => {
  const acc = await acceptRun({ repo, runId: RUN });
  assert.equal(acc.ok, true);
  // 注入不一致：state 指向另一个决定
  const cur = readState(stateDir);
  writeState(stateDir, {
    ...cur.state,
    decision_ref: { ...cur.state.decision_ref, decision_id: 'decision-other0001' },
  });
  const status = getStatus({ repo, runId: RUN });
  assert.equal(status.review.review_integrity, 'conflict');
}));
