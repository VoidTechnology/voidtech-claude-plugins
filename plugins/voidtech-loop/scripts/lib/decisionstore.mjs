// Decision slot 与提交事务核心（二期技术设计 §3.3，Task 1.3）。
// 语义：每个 terminal run 最多一个 finalized decision（committed/ 出现即占用 slot）；
// 相同幂等键返回已有记录；冲突拒绝；matching prepared operation 恢复而非新建。
// 本层不接生命周期：Accept 的 state 更新与 Abandon/Revise 的 checksum 前置校验
// 由调用方经 applyStateUpdate 注入（Task 1.4 接线）。

import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './statestore.mjs';
import { withRunReviewLock } from './runreviewlock.mjs';
import {
  runDir, committedDir, committedDecisionRecordPath, stagingDir,
  validateReviewArtifact, artifactHash,
} from './reviewstore.mjs';
import {
  buildOperation, writeOperation, listOperations, markOperationCommitted,
} from './reviewoperation.mjs';

// 幂等键（§3.3）：run、goal hash、source commit、outcome、manual review results、
// proposal hash、approval bundle hash、grant hash 与 note。decision_id 与 decided_at
// 不进入键：重试产生新 ID/时间戳仍是同一决定；note 不同则视为冲突请求。
export function decisionIdempotencyKey(record) {
  return artifactHash({
    run_id: record.run_id,
    goal_hash: record.goal_hash,
    source_commit: record.source_commit,
    outcome: record.outcome,
    manual_review_results: record.manual_review_results,
    proposal_hash: record.proposal_hash,
    approval_bundle_hash: record.approval_bundle_hash,
    grant_hash: record.authorization?.grant_hash ?? null,
    note: record.note,
  });
}

export function readCommittedDecision(projectDir, runId) {
  const path = committedDecisionRecordPath(projectDir, runId);
  if (!existsSync(path)) return { ok: true, exists: false };
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const validation = validateReviewArtifact('decision_record', record);
  if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
  return { ok: true, exists: true, record };
}

export function findMatchingPreparedOperation(projectDir, runId, requestedRecord) {
  const key = decisionIdempotencyKey(requestedRecord);
  for (const entry of listOperations(projectDir, runId)) {
    if (!entry.ok) continue;
    const op = entry.operation;
    if (op.phase === 'prepared' && decisionIdempotencyKey(op.decision_payload.decision) === key) {
      return op;
    }
  }
  return null;
}

function fsyncDirBestEffort(path) {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // 目录 fsync 在个别文件系统上不可用；rename 原子性不受影响
  }
}

// 原子发布（§3.7）：staging 目录整体 rename 到 committed/。目标已存在且非空时 rename 失败，
// 天然构成 first-finalized-decision-wins；路径构造从不预创建空 committed/。
export function atomicPublishCommitted(projectDir, runId, stagingPath) {
  const target = committedDir(projectDir, runId);
  try {
    renameSync(stagingPath, target);
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'ENOTDIR') {
      return { ok: false, reason: 'slot_occupied' };
    }
    throw err;
  }
  fsyncDirBestEffort(dirname(target));
  return { ok: true };
}

// stageFiles: (stagingPath) => void，由调用方写入 decision-record.json 之外的附加资产
// （Task 1.6 的 Revision/Supplemental Bundle）；本层保证 decision-record.json 一定在场。
export async function submitDecision(projectDir, runId, {
  operationId, decision, grant = null, expectedStateChecksum,
  applyStateUpdate = null, stageFiles = null,
}) {
  const validation = validateReviewArtifact('decision_record', decision);
  if (!validation.ok) return { ok: false, reason: 'invalid_decision', errors: validation.errors };

  const runPath = runDir(projectDir, runId);
  const locked = await withRunReviewLock(runPath, operationId, async () => {
    // 1) 锁内重读 decision slot：已有 finalized decision 时按幂等/冲突分类
    const committed = readCommittedDecision(projectDir, runId);
    if (!committed.ok) return { ok: false, reason: 'committed_corrupt' };
    if (committed.exists) {
      if (decisionIdempotencyKey(committed.record) === decisionIdempotencyKey(decision)) {
        // 幂等命中：若上次崩溃发生在 publish 与 committed 标记之间，这里补齐 journal
        const lagging = findMatchingPreparedOperation(projectDir, runId, decision);
        if (lagging) markOperationCommitted(projectDir, runId, lagging.operation_id);
        return { ok: true, idempotent: true, record: committed.record };
      }
      return { ok: false, reason: 'review_conflict', existing: committed.record };
    }

    // 2) matching prepared operation 必须恢复而非新建（§3.3）；恢复时发布原决定
    const matching = findMatchingPreparedOperation(projectDir, runId, decision);
    const operation = matching
      ?? buildOperation({ operationId, runId, outcome: decision.outcome, expectedStateChecksum, decision, grant });
    if (!matching) {
      const written = writeOperation(projectDir, runId, operation);
      if (!written.ok) return written;
    }
    const effective = operation.decision_payload.decision;

    // 3) Accept 的 state 更新 / Abandon-Revise 的 checksum 前置校验（调用方注入）
    if (applyStateUpdate) {
      const updated = applyStateUpdate({
        expectedStateChecksum: operation.expected_state_checksum,
        decision: effective,
        operation,
      });
      if (!updated.ok) {
        return { ok: false, reason: updated.reason ?? 'state_update_failed', operation_id: operation.operation_id };
      }
    }

    // 4) staging 写全 → 原子 rename 发布
    const staging = stagingDir(projectDir, runId, `${operation.operation_id}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    atomicWrite(join(staging, 'decision-record.json'), JSON.stringify(effective, null, 2));
    if (stageFiles) {
      // staging 写入中的任何失败（含异常）都不得留下半成品发布：清理 staging，slot 保持空闲
      let staged;
      try {
        staged = await stageFiles(staging, effective);
      } catch (err) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: 'stage_files_failed', error: String(err?.message ?? err) };
      }
      if (staged && staged.ok === false) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: staged.reason ?? 'stage_files_failed' };
      }
    }
    const published = atomicPublishCommitted(projectDir, runId, staging);
    if (!published.ok) {
      rmSync(staging, { recursive: true, force: true });
      const after = readCommittedDecision(projectDir, runId);
      if (after.ok && after.exists) {
        return decisionIdempotencyKey(after.record) === decisionIdempotencyKey(effective)
          ? { ok: true, idempotent: true, record: after.record }
          : { ok: false, reason: 'review_conflict', existing: after.record };
      }
      return { ok: false, reason: 'publish_failed' };
    }

    // 5) committed 标记（丢失时恢复矩阵可从 committed/ + prepared operation 补齐）
    markOperationCommitted(projectDir, runId, operation.operation_id);
    return { ok: true, record: effective, operation_id: operation.operation_id };
  });

  if (!locked.ok) return { ok: false, reason: `review_lock_${locked.reason}`, holder: locked.holder };
  return locked.result;
}
