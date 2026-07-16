// 执行健康与评审健康分离（二期技术设计 §3.5，Task 1.4，P2-24/P2-25）。
// run_integrity 只看一期执行资产（state 可读且 checksum 成立）；review_integrity 只看
// operation journal 与 committed decision。review 损坏不得把 frozen spec、rounds、evidence 连带判坏。
// 恢复矩阵以 (state.status, staging/committed 存在性, record.outcome) 为完整键，legacy Accept
// 一律按 legacy_accepted 读取，不迁移、不补造 Record。

import { readState, updateStateIfChecksum } from './statestore.mjs';
import { withRunReviewLock } from './runreviewlock.mjs';
import { runDir } from './reviewstore.mjs';
import { listOperations, markOperationCommitted } from './reviewoperation.mjs';
import { readCommittedDecision, submitDecision } from './decisionstore.mjs';

export function isLegacyAccepted(state) {
  return state.status === 'ACCEPTED'
    && state.review_protocol_version === undefined
    && state.decision_ref === undefined;
}

// Accept 的 state 更新（含恢复语义）：checksum 匹配则迁移到 ACCEPTED；
// state 已被同一 operation 更新过（崩溃后重试）时按已应用处理，不判失败。
export function buildAcceptStateUpdate(stateDir) {
  return ({ expectedStateChecksum, decision, operation }) => {
    // 前置守卫：state 已 ACCEPTED 时只允许 ref 匹配的同一 operation 继续（恢复），
    // 其他任何决定（如 note 不同的重试）不得改写 decision_ref——那是被替换而非恢复。
    const before = readState(stateDir);
    if (!before.ok) return { ok: false, reason: before.reason };
    if (before.state.status === 'ACCEPTED') {
      return before.state.decision_ref?.operation_id === operation.operation_id
        ? { ok: true, already: true }
        : { ok: false, reason: 'state_changed' };
    }
    const updated = updateStateIfChecksum(stateDir, expectedStateChecksum, (s) => ({
      ...s,
      status: 'ACCEPTED',
      accepted_at: new Date().toISOString(),
      review_protocol_version: 1,
      decision_ref: {
        operation_id: operation.operation_id,
        decision_id: decision.decision_id,
        decision_hash: operation.decision_payload.decision_hash,
      },
    }));
    if (updated.ok) return updated;
    if (updated.reason === 'state_changed') {
      const current = readState(stateDir);
      if (current.ok && current.state.status === 'ACCEPTED'
        && current.state.decision_ref?.operation_id === operation.operation_id) {
        return { ok: true, already: true };
      }
    }
    return updated;
  };
}

// Abandon/Revise 的发布前置校验（§3.5）：不修改 state，只要求 checksum 仍等于 operation 记录值。
export function buildStatePrecondition(stateDir) {
  return ({ expectedStateChecksum }) => {
    const current = readState(stateDir);
    if (!current.ok) return { ok: false, reason: current.reason };
    return current.checksum === expectedStateChecksum
      ? { ok: true }
      : { ok: false, reason: 'state_changed' };
  };
}

// 分类（§3.5 恢复矩阵的只读投影）。stateResult 为 readState 的原始返回。
export function classifyReviewIntegrity(projectDir, runId, stateResult) {
  const runIntegrity = stateResult.ok ? 'ok'
    : (stateResult.reason === 'missing' ? 'unknown' : 'damaged');
  const state = stateResult.ok ? stateResult.state : null;

  const committed = readCommittedDecision(projectDir, runId);
  if (!committed.ok) {
    return { run_integrity: runIntegrity, review_integrity: 'damaged', detail: `committed decision ${committed.reason}` };
  }

  const operations = listOperations(projectDir, runId).filter((e) => e.ok).map((e) => e.operation);

  if (committed.exists) {
    const record = committed.record;
    if (state?.status === 'ACCEPTED') {
      if (isLegacyAccepted(state)) {
        return { run_integrity: runIntegrity, review_integrity: 'conflict', detail: 'legacy ACCEPTED 与 committed decision 并存' };
      }
      return state.decision_ref?.decision_id === record.decision_id
        ? { run_integrity: runIntegrity, review_integrity: 'committed', outcome: record.outcome }
        : { run_integrity: runIntegrity, review_integrity: 'conflict', detail: 'state decision_ref 与 committed record 不一致' };
    }
    if (record.outcome === 'accept') {
      // committed Accept + state 落后：仅当 operation precondition 与当前 checksum 成立才可补齐（recoverRunReview）
      return { run_integrity: runIntegrity, review_integrity: 'committed', outcome: 'accept', state_lag: true };
    }
    // Abandon/Revise 不修改 run state：原终态 + committed record 是正常终局
    return { run_integrity: runIntegrity, review_integrity: 'committed', outcome: record.outcome };
  }

  if (state?.status === 'ACCEPTED') {
    if (isLegacyAccepted(state)) {
      return { run_integrity: runIntegrity, review_integrity: 'legacy_accepted' };
    }
    const matching = operations.find((op) => op.operation_id === state.decision_ref?.operation_id);
    return matching
      ? { run_integrity: runIntegrity, review_integrity: 'prepared', recoverable: true }
      : { run_integrity: runIntegrity, review_integrity: 'damaged', detail: 'decision_ref 存在但 Record 与 operation 均缺失' };
  }

  if (operations.some((op) => op.phase === 'committed')) {
    return { run_integrity: runIntegrity, review_integrity: 'damaged', detail: 'operation 已 committed 但 decision record 缺失' };
  }
  if (operations.some((op) => op.phase === 'prepared')) {
    return { run_integrity: runIntegrity, review_integrity: 'prepared' };
  }
  return { run_integrity: runIntegrity, review_integrity: 'not_started' };
}

// 恢复入口（§3.5）：只处理可机械恢复的两行；其余保持 fail closed，不猜测修复。
export async function recoverRunReview(projectDir, runId) {
  const stateDir = runDir(projectDir, runId);
  const stateResult = readState(stateDir);
  const cls = classifyReviewIntegrity(projectDir, runId, stateResult);
  const operations = listOperations(projectDir, runId).filter((e) => e.ok).map((e) => e.operation);

  // 行 5：committed Accept + state 落后 → operation precondition 与当前 checksum 成立时补齐 state
  if (cls.review_integrity === 'committed' && cls.state_lag) {
    const committed = readCommittedDecision(projectDir, runId);
    const op = operations.find((o) => o.decision_payload.decision.decision_id === committed.record.decision_id);
    if (!op) return { ok: false, reason: 'review_damaged', detail: 'committed record 无对应 operation，fail closed' };
    const locked = await withRunReviewLock(stateDir, op.operation_id, async () => {
      const applied = buildAcceptStateUpdate(stateDir)({
        expectedStateChecksum: op.expected_state_checksum,
        decision: op.decision_payload.decision,
        operation: op,
      });
      if (!applied.ok) return { ok: false, reason: 'review_damaged', detail: `state 前置条件不成立（${applied.reason}），fail closed` };
      markOperationCommitted(projectDir, runId, op.operation_id);
      return { ok: true, repaired: 'state' };
    });
    return locked.ok ? locked.result : { ok: false, reason: `review_lock_${locked.reason}` };
  }

  // 行 4：prepared Accept + state 已 ACCEPTED 且 ref 匹配 → 从 operation 恢复并发布 Record
  if (cls.review_integrity === 'prepared' && cls.recoverable && stateResult.ok) {
    const op = operations.find((o) => o.operation_id === stateResult.state.decision_ref.operation_id);
    const result = await submitDecision(projectDir, runId, {
      operationId: op.operation_id,
      decision: op.decision_payload.decision,
      grant: op.grant,
      expectedStateChecksum: op.expected_state_checksum,
      applyStateUpdate: buildAcceptStateUpdate(stateDir),
    });
    return result.ok ? { ok: true, repaired: 'record', record: result.record } : result;
  }

  return { ok: true, nothing_to_do: true, classification: cls };
}
