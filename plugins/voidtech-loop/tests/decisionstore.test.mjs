// Task 1.3：decision slot 幂等/冲突矩阵、first-finalized-decision-wins 与 prepared 恢复（技术设计 §3.3，P2-15）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  submitDecision, readCommittedDecision, decisionIdempotencyKey,
  findMatchingPreparedOperation, atomicPublishCommitted,
} from '../scripts/lib/decisionstore.mjs';
import { buildOperation, writeOperation, readOperation } from '../scripts/lib/reviewoperation.mjs';
import { committedDir, stagingDir, decisionsDir } from '../scripts/lib/reviewstore.mjs';
import { atomicWrite } from '../scripts/lib/statestore.mjs';

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
    outcome: 'accept',
    manual_review_results: [],
    decided_at: '2026-07-16T12:00:00Z',
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null,
    proposal_hash: null,
    approval_bundle_hash: null,
    basis: { original_goal_hash: hex64('a'), supplemental_verification: null },
    note: null,
    ...overrides,
  };
}

function submit(projectDir, decision, extra = {}) {
  return submitDecision(projectDir, RUN, {
    operationId: `review-op-${String(++seq).padStart(3, '0')}`,
    decision,
    expectedStateChecksum: hex64('c'),
    ...extra,
  });
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'decision-'));
  return Promise.resolve(callback(projectDir)).finally(() => rmSync(projectDir, { recursive: true, force: true }));
}

test('空 slot：Accept 发布成功，operation 标记 committed', () => withProject(async (projectDir) => {
  const result = await submit(projectDir, makeDecision());
  assert.equal(result.ok, true);
  assert.equal(result.record.outcome, 'accept');

  const committed = readCommittedDecision(projectDir, RUN);
  assert.equal(committed.exists, true);

  const op = readOperation(projectDir, RUN, result.operation_id);
  assert.equal(op.operation.phase, 'committed');
  // staging 已被 rename 走，不留残余
  assert.ok(!existsSync(stagingDir(projectDir, RUN, 'x')) || readdirSync(join(decisionsDir(projectDir, RUN), 'staging')).length === 0);
}));

test('幂等：相同决定（不同 decision_id/时间戳）返回已有记录', () => withProject(async (projectDir) => {
  const first = await submit(projectDir, makeDecision());
  const retry = await submit(projectDir, makeDecision({ decided_at: '2026-07-16T13:00:00Z' }));
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.record.decision_id, first.record.decision_id);
}));

test('冲突矩阵：Accept 后 Abandon/Revise 拒绝；note 不同视为冲突', () => withProject(async (projectDir) => {
  await submit(projectDir, makeDecision());

  const abandon = await submit(projectDir, makeDecision({ outcome: 'abandon' }));
  assert.deepEqual({ ok: abandon.ok, reason: abandon.reason }, { ok: false, reason: 'review_conflict' });

  const revise = await submit(projectDir, makeDecision({ outcome: 'revise', approval_bundle_hash: hex64('d') }));
  assert.equal(revise.reason, 'review_conflict');

  const differentNote = await submit(projectDir, makeDecision({ note: 'with a note' }));
  assert.equal(differentNote.reason, 'review_conflict');
}));

test('冲突矩阵：Revise 后相同 bundle 幂等、不同 bundle 拒绝', () => withProject(async (projectDir) => {
  const revise = makeDecision({ outcome: 'revise', approval_bundle_hash: hex64('d'), proposal_hash: hex64('e') });
  assert.equal((await submit(projectDir, revise)).ok, true);

  const sameBundle = await submit(projectDir, makeDecision({ outcome: 'revise', approval_bundle_hash: hex64('d'), proposal_hash: hex64('e') }));
  assert.equal(sameBundle.idempotent, true);

  const otherBundle = await submit(projectDir, makeDecision({ outcome: 'revise', approval_bundle_hash: hex64('f'), proposal_hash: hex64('e') }));
  assert.equal(otherBundle.reason, 'review_conflict');
}));

test('matching prepared operation 被恢复：发布原决定而非重试请求的新 ID', () => withProject(async (projectDir) => {
  // 模拟第一次提交在 publish 前崩溃：只留下 prepared operation
  const original = makeDecision({ note: 'crash before publish' });
  const op = buildOperation({
    operationId: 'review-op-crash', runId: RUN, outcome: 'accept',
    expectedStateChecksum: hex64('c'), decision: original,
  });
  assert.equal(writeOperation(projectDir, RUN, op).ok, true);
  assert.ok(findMatchingPreparedOperation(projectDir, RUN, original));

  // 相同幂等键的重试（新 decision_id）：必须恢复原 operation 并发布原决定
  const retry = await submit(projectDir, makeDecision({ note: 'crash before publish', decided_at: '2026-07-16T14:00:00Z' }));
  assert.equal(retry.ok, true);
  assert.equal(retry.operation_id, 'review-op-crash');
  assert.equal(retry.record.decision_id, original.decision_id);
  assert.equal(readCommittedDecision(projectDir, RUN).record.decision_id, original.decision_id);
}));

test('applyStateUpdate 失败：不发布、slot 空闲、operation 保持 prepared 可重试', () => withProject(async (projectDir) => {
  const decision = makeDecision();
  const failed = await submit(projectDir, decision, {
    applyStateUpdate: () => ({ ok: false, reason: 'state_changed' }),
  });
  assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: 'state_changed' });
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false);

  const prepared = findMatchingPreparedOperation(projectDir, RUN, decision);
  assert.ok(prepared);
  assert.equal(prepared.phase, 'prepared');

  // 修复前置条件后重试同一决定：恢复同一 operation 并成功
  const retry = await submit(projectDir, makeDecision());
  assert.equal(retry.ok, true);
  assert.equal(retry.operation_id, prepared.operation_id);
}));

test('first wins：发布竞争输家按幂等/冲突分类，不产生第二决定', () => withProject(async (projectDir) => {
  const winner = makeDecision();
  await submit(projectDir, winner);

  // 直接驱动底层发布：竞争者的 staging 在 slot 已占时 rename 失败
  const staging = stagingDir(projectDir, RUN, 'loser-tx');
  mkdirSync(staging, { recursive: true });
  atomicWrite(join(staging, 'decision-record.json'), JSON.stringify(makeDecision({ outcome: 'abandon' }), null, 2));
  const published = atomicPublishCommitted(projectDir, RUN, staging);
  assert.deepEqual({ ok: published.ok, reason: published.reason }, { ok: false, reason: 'slot_occupied' });

  // committed 内容仍是赢家
  assert.equal(readCommittedDecision(projectDir, RUN).record.decision_id, winner.decision_id);
  assert.ok(existsSync(committedDir(projectDir, RUN)));
}));

test('幂等键：decision_id/decided_at 不参与，note/grant/bundle 参与', () => {
  const base = makeDecision();
  const sameKey = makeDecision({ decision_id: 'decision-zzz', decided_at: '2027-01-01T00:00:00Z' });
  assert.equal(decisionIdempotencyKey(base), decisionIdempotencyKey(sameKey));

  assert.notEqual(decisionIdempotencyKey(base), decisionIdempotencyKey(makeDecision({ note: 'x' })));
  assert.notEqual(decisionIdempotencyKey(base), decisionIdempotencyKey(makeDecision({ approval_bundle_hash: hex64('1') })));
  assert.notEqual(
    decisionIdempotencyKey(base),
    decisionIdempotencyKey(makeDecision({
      decided_by: { kind: 'agent', session_id: 's', authorization: 'bounded_delegate' },
      authorization: { grant_id: 'g', grant_hash: hex64('2') },
    })),
  );
});
