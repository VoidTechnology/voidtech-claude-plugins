// Review Operation Journal（二期技术设计 §3.2，Task 1.3）。
// 每次 finalized review decision 先建立内部 operation：decision_payload 保存可恢复的完整
// canonical Decision Record；phase 只有 prepared/committed；文件用同目录 tmp + fsync + rename 更新。
// 不得复用 operation ID 表达第二个决定。

import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { atomicWrite } from './statestore.mjs';
import {
  operationsDir, operationPath, validateReviewArtifact, computeDecisionHash,
} from './reviewstore.mjs';

export function buildOperation({ operationId, runId, outcome, expectedStateChecksum, decision, grant = null }) {
  return {
    operation_id: operationId,
    protocol_version: 1,
    run_id: runId,
    outcome,
    expected_state_checksum: expectedStateChecksum,
    grant,
    decision_payload: { decision_hash: computeDecisionHash(decision), decision },
    phase: 'prepared',
  };
}

export function writeOperation(projectDir, runId, operation) {
  const validation = validateReviewArtifact('review_operation', operation);
  if (!validation.ok) return { ok: false, reason: 'invalid_operation', errors: validation.errors };
  const path = operationPath(projectDir, runId, operation.operation_id);
  if (existsSync(path)) {
    const current = readOperation(projectDir, runId, operation.operation_id);
    if (!current.ok) return { ok: false, reason: 'corrupt_operation' };
    if (current.operation.decision_payload.decision_hash !== operation.decision_payload.decision_hash) {
      return { ok: false, reason: 'operation_id_reused' };
    }
  }
  mkdirSync(operationsDir(projectDir, runId), { recursive: true });
  atomicWrite(path, JSON.stringify(operation, null, 2));
  return { ok: true, operation };
}

export function readOperation(projectDir, runId, operationId) {
  const path = operationPath(projectDir, runId, operationId);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let operation;
  try {
    operation = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const validation = validateReviewArtifact('review_operation', operation);
  if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
  // payload 内容与其 hash 必须自洽，否则恢复会发布被篡改的决定
  if (computeDecisionHash(operation.decision_payload.decision) !== operation.decision_payload.decision_hash) {
    return { ok: false, reason: 'payload_hash_mismatch' };
  }
  return { ok: true, operation };
}

export function listOperations(projectDir, runId) {
  const dir = operationsDir(projectDir, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const operationId = name.slice(0, -'.json'.length);
      return { operation_id: operationId, ...readOperation(projectDir, runId, operationId) };
    });
}

export function markOperationCommitted(projectDir, runId, operationId) {
  const current = readOperation(projectDir, runId, operationId);
  if (!current.ok) return current;
  if (current.operation.phase === 'committed') return { ok: true, operation: current.operation, already: true };
  const next = { ...current.operation, phase: 'committed' };
  atomicWrite(operationPath(projectDir, runId, operationId), JSON.stringify(next, null, 2));
  return { ok: true, operation: next };
}
