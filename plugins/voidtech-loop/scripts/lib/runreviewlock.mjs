// Per-run review lock（二期技术设计 §3.4，Task 1.2）。
// 位于 <run-dir>/review.lock/，复用一期项目锁的 mkdir 原子创建、双因子判活与 tombstone 陈旧接管协议。
// 边界：同一 run 的 Accept/Abandon/Revise 串行；不同 run 可并行；不占用也不替代项目锁。
// owner metadata 绑定 operation ID：stale takeover 带回旧 operation，接管者恢复它而不是新建第二个决定。

import { mkdirSync, rmSync, existsSync, readFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, processIdentity, isProcessAlive } from './statestore.mjs';

const CREATING_GRACE_MS = 2000;

function lockPath(runDir) {
  return join(runDir, 'review.lock');
}

// 返回 { status: 'free'|'creating'|'alive'|'stale', meta? }，语义与一期 inspectLock 一致。
export function inspectRunReviewLock(runDir) {
  const dir = lockPath(runDir);
  if (!existsSync(dir)) return { status: 'free' };
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    let age = 0;
    try { age = Date.now() - statSync(dir).birthtimeMs; } catch { /* 拿不到时间则保守按创建中 */ }
    return age > CREATING_GRACE_MS ? { status: 'stale', meta: null } : { status: 'creating' };
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { status: 'stale', meta: null };
  }
  return isProcessAlive(meta) ? { status: 'alive', meta } : { status: 'stale', meta };
}

export function acquireRunReviewLock(runDir, operationId) {
  mkdirSync(runDir, { recursive: true });
  try {
    mkdirSync(lockPath(runDir));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const current = inspectRunReviewLock(runDir);
    if (current.status !== 'stale') {
      return { ok: false, reason: current.status === 'creating' ? 'creating' : 'held', holder: current.meta ?? null };
    }
    // 陈旧接管：rename 到唯一 tombstone，仅一个进程能赢；旧 operation ID 带回给调用方恢复（§3.4）
    const tombstone = join(runDir, `review.lock.tombstone.${randomUUID().slice(0, 8)}`);
    try {
      renameSync(lockPath(runDir), tombstone);
    } catch {
      return { ok: false, reason: 'lost_race' };
    }
    let prior = null;
    try {
      prior = JSON.parse(readFileSync(join(tombstone, 'meta.json'), 'utf8'));
    } catch {
      // 空锁或元数据损坏的 tombstone，prior 保持 null
    }
    rmSync(tombstone, { recursive: true, force: true });
    try {
      mkdirSync(lockPath(runDir));
    } catch {
      return { ok: false, reason: 'lost_race' };
    }
    writeMeta(runDir, operationId);
    return { ok: true, taken_over_from: prior };
  }
  writeMeta(runDir, operationId);
  return { ok: true, taken_over_from: null };
}

function writeMeta(runDir, operationId) {
  atomicWrite(join(lockPath(runDir), 'meta.json'), JSON.stringify({
    operation_id: operationId,
    ...processIdentity(),
    acquired_at: new Date().toISOString(),
  }, null, 2));
}

export function releaseRunReviewLock(runDir, operationId) {
  const current = inspectRunReviewLock(runDir);
  if (current.status === 'free') return { ok: false, reason: 'not_held' };
  if (current.meta && current.meta.operation_id !== operationId) {
    return { ok: false, reason: 'not_owner', holder: current.meta };
  }
  rmSync(lockPath(runDir), { recursive: true, force: true });
  return { ok: true };
}

// 决策入口的统一临界区：获取（含陈旧接管）→ 回调 → 保证释放。
// 回调收到 taken_over_from，接管旧 operation 时必须恢复它而不是另起决定（§3.3/§3.4）。
export async function withRunReviewLock(runDir, operationId, callback) {
  const acquired = acquireRunReviewLock(runDir, operationId);
  if (!acquired.ok) return { ok: false, reason: acquired.reason, holder: acquired.holder ?? null };
  try {
    const result = await callback({ takenOverFrom: acquired.taken_over_from });
    return { ok: true, result, taken_over_from: acquired.taken_over_from };
  } finally {
    releaseRunReviewLock(runDir, operationId);
  }
}
