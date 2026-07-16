// Task 1.3：Operation Journal 行为（技术设计 §3.2）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOperation, writeOperation, readOperation, listOperations, markOperationCommitted,
} from '../scripts/lib/reviewoperation.mjs';
import { operationPath } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';

function makeDecision(overrides = {}) {
  return {
    schema_version: 1,
    decision_id: 'decision-001',
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

function makeOp(overrides = {}, decisionOverrides = {}) {
  return buildOperation({
    operationId: 'review-op-001',
    runId: RUN,
    outcome: 'accept',
    expectedStateChecksum: hex64('c'),
    decision: makeDecision(decisionOverrides),
    ...overrides,
  });
}

test('prepared operation 写入、读取与 committed 标记', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-op-'));
  try {
    const op = makeOp();
    assert.equal(writeOperation(projectDir, RUN, op).ok, true);

    const read = readOperation(projectDir, RUN, 'review-op-001');
    assert.equal(read.ok, true);
    assert.equal(read.operation.phase, 'prepared');

    const committed = markOperationCommitted(projectDir, RUN, 'review-op-001');
    assert.equal(committed.ok, true);
    assert.equal(committed.operation.phase, 'committed');
    // 幂等：重复标记不报错
    assert.equal(markOperationCommitted(projectDir, RUN, 'review-op-001').already, true);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('不得复用 operation ID 表达第二个决定', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-op-'));
  try {
    assert.equal(writeOperation(projectDir, RUN, makeOp()).ok, true);
    // 同 ID 同决定：幂等重写允许
    assert.equal(writeOperation(projectDir, RUN, makeOp()).ok, true);
    // 同 ID 不同决定：拒绝
    const second = writeOperation(projectDir, RUN, makeOp({}, { outcome: 'abandon' }));
    assert.deepEqual({ ok: second.ok, reason: second.reason }, { ok: false, reason: 'operation_id_reused' });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('payload 与 hash 不自洽的 operation 被拒绝读取', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-op-'));
  try {
    const op = makeOp();
    writeOperation(projectDir, RUN, op);
    const tampered = structuredClone(op);
    tampered.decision_payload.decision.note = 'tampered';
    writeFileSync(operationPath(projectDir, RUN, 'review-op-001'), JSON.stringify(tampered, null, 2));
    const read = readOperation(projectDir, RUN, 'review-op-001');
    assert.deepEqual({ ok: read.ok, reason: read.reason }, { ok: false, reason: 'payload_hash_mismatch' });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('非法 decision payload 在 prepare 即被拒绝', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-op-'));
  try {
    const op = makeOp({}, { outcome: 'merge' });
    const written = writeOperation(projectDir, RUN, op);
    assert.equal(written.ok, false);
    assert.equal(written.reason, 'invalid_operation');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('listOperations 按文件名排序返回全部 operation', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-op-'));
  try {
    writeOperation(projectDir, RUN, makeOp({ operationId: 'review-op-002' }, { note: 'second' }));
    writeOperation(projectDir, RUN, makeOp({ operationId: 'review-op-001' }));
    const all = listOperations(projectDir, RUN);
    assert.deepEqual(all.map((e) => e.operation_id), ['review-op-001', 'review-op-002']);
    assert.ok(all.every((e) => e.ok));
    assert.deepEqual(listOperations(projectDir, 'no-such-run'), []);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
