// Task 1.2：per-run review lock 与锁内 compare-and-write（技术设计 §3.4，P2-26）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireRunReviewLock, releaseRunReviewLock, inspectRunReviewLock, withRunReviewLock,
} from '../scripts/lib/runreviewlock.mjs';
import {
  writeState, readState, updateStateIfChecksum, acquireLock, inspectLock, STATE_VERSION,
} from '../scripts/lib/statestore.mjs';

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'review-lock-'));
  return { root, runA: join(root, 'runs', 'run-a'), runB: join(root, 'runs', 'run-b') };
}

function seedState(dir, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeState(dir, { state_version: STATE_VERSION, run_id: 'run-a', status: 'EVALS_PASSED', ...extra });
  return readState(dir);
}

test('同一 run 串行：持锁期间第二次获取被拒绝', () => {
  const { root, runA } = makeDirs();
  try {
    assert.equal(acquireRunReviewLock(runA, 'op-1').ok, true);
    const second = acquireRunReviewLock(runA, 'op-2');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'held');
    assert.equal(second.holder.operation_id, 'op-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不同 run 并行：两把锁互不影响', () => {
  const { root, runA, runB } = makeDirs();
  try {
    assert.equal(acquireRunReviewLock(runA, 'op-a').ok, true);
    assert.equal(acquireRunReviewLock(runB, 'op-b').ok, true);
    assert.equal(inspectRunReviewLock(runA).meta.operation_id, 'op-a');
    assert.equal(inspectRunReviewLock(runB).meta.operation_id, 'op-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withRunReviewLock：成功与抛错都释放锁', async () => {
  const { root, runA } = makeDirs();
  try {
    const done = await withRunReviewLock(runA, 'op-1', async () => 'value');
    assert.deepEqual({ ok: done.ok, result: done.result }, { ok: true, result: 'value' });
    assert.equal(inspectRunReviewLock(runA).status, 'free');

    await assert.rejects(
      withRunReviewLock(runA, 'op-2', async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(inspectRunReviewLock(runA).status, 'free');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('陈旧接管：死进程持有的锁被接管，旧 operation ID 带回供恢复', () => {
  const { root, runA } = makeDirs();
  try {
    // 伪造一个判活必然失败的持有者（PID 存在性无关：start/comm 双因子不匹配）
    mkdirSync(join(runA, 'review.lock'), { recursive: true });
    writeFileSync(join(runA, 'review.lock', 'meta.json'), JSON.stringify({
      operation_id: 'op-stale', pid: 99999999, pid_start: 'never', pid_comm: 'ghost',
    }));
    const acquired = acquireRunReviewLock(runA, 'op-new');
    assert.equal(acquired.ok, true);
    assert.equal(acquired.taken_over_from.operation_id, 'op-stale');
    assert.equal(inspectRunReviewLock(runA).meta.operation_id, 'op-new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release 校验 owner：非持有 operation 不能释放', () => {
  const { root, runA } = makeDirs();
  try {
    acquireRunReviewLock(runA, 'op-1');
    const denied = releaseRunReviewLock(runA, 'op-other');
    assert.deepEqual({ ok: denied.ok, reason: denied.reason }, { ok: false, reason: 'not_owner' });
    assert.equal(releaseRunReviewLock(runA, 'op-1').ok, true);
    assert.equal(releaseRunReviewLock(runA, 'op-1').reason, 'not_held');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updateStateIfChecksum：未持锁拒绝（lock_not_held）', () => {
  const { root, runA } = makeDirs();
  try {
    const seeded = seedState(runA);
    const denied = updateStateIfChecksum(runA, seeded.checksum, (s) => s);
    assert.deepEqual({ ok: denied.ok, reason: denied.reason }, { ok: false, reason: 'lock_not_held' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updateStateIfChecksum：checksum 匹配则更新，不匹配返回 state_changed 且不覆盖', async () => {
  const { root, runA } = makeDirs();
  try {
    const seeded = seedState(runA);
    await withRunReviewLock(runA, 'op-1', async () => {
      const updated = updateStateIfChecksum(runA, seeded.checksum, (s) => ({ ...s, status: 'ACCEPTED' }));
      assert.equal(updated.ok, true);
      assert.equal(updated.state.status, 'ACCEPTED');
      assert.notEqual(updated.checksum, seeded.checksum);

      // 用旧 checksum 再来一次：必须拒绝，且磁盘 state 不被覆盖（P2-26）
      const conflicted = updateStateIfChecksum(runA, seeded.checksum, (s) => ({ ...s, status: 'STOPPED' }));
      assert.deepEqual({ ok: conflicted.ok, reason: conflicted.reason }, { ok: false, reason: 'state_changed' });
      assert.equal(conflicted.checksum, updated.checksum);
      assert.equal(readState(runA).state.status, 'ACCEPTED');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review lock 不占用项目锁：两把锁独立获取与检查', () => {
  const { root, runA } = makeDirs();
  try {
    assert.equal(acquireRunReviewLock(runA, 'op-1').ok, true);
    // 项目锁在 projectDir/lock，review lock 在 runs/<id>/review.lock，互不可见
    assert.equal(inspectLock(root).status, 'free');
    assert.equal(acquireLock(root, { run_id: 'run-a', pid: process.pid }).ok, true);
    assert.equal(inspectRunReviewLock(runA).status, 'alive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
