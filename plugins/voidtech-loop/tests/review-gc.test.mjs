// Task 5.6：review 资产 GC 保守语义（staging 持锁清理、grant 保护、孤儿 snapshot、finalized 永不删）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gcRunReviewAssets, gcDelegationGrants, sweepOrphanSnapshots } from '../scripts/lib/reviewgc.mjs';
import { submitDecision } from '../scripts/lib/decisionstore.mjs';
import { buildOperation, writeOperation } from '../scripts/lib/reviewoperation.mjs';
import { createDelegationGrant } from '../scripts/lib/delegationgrant.mjs';
import { acquireRunReviewLock, releaseRunReviewLock } from '../scripts/lib/runreviewlock.mjs';
import { runDir, decisionsDir, reviewsDir, committedDecisionRecordPath, delegationGrantPath } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';
const OLD = new Date('2026-07-01T00:00:00Z');

let seq = 0;
function makeDecision(overrides = {}) {
  return {
    schema_version: 1,
    decision_id: `decision-${String(++seq).padStart(3, '0')}`,
    run_id: RUN, goal_hash: hex64('a'), source_commit: hex40('b'), outcome: 'accept',
    manual_review_results: [], decided_at: '2026-07-16T12:00:00Z',
    decided_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    authorization: null, proposal_hash: null, approval_bundle_hash: null,
    basis: { original_goal_hash: hex64('a'), supplemental_verification: null }, note: null,
    ...overrides,
  };
}

function seedStaging(projectDir, name, mtime = null) {
  const dir = join(decisionsDir(projectDir, RUN), 'staging', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'decision-record.json'), '{}');
  if (mtime) utimesSync(dir, mtime, mtime);
  return dir;
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'review-gc-'));
  return Promise.resolve(callback(projectDir)).finally(() => rmSync(projectDir, { recursive: true, force: true }));
}

test('staging GC：已决 run 全清；未决 run 只清超 TTL 残留；finalized 与 journal 永不删', () => withProject(async (projectDir) => {
  // 未决：新鲜 staging 保留、老 staging 清除
  seedStaging(projectDir, 'fresh-tx');
  seedStaging(projectDir, 'stale-tx', OLD);
  const undecided = await gcRunReviewAssets(projectDir, RUN);
  assert.deepEqual({ removed: undecided.removed, keptStaging: undecided.kept.filter((k) => k.startsWith('staging')) },
    { removed: ['staging/stale-tx'], keptStaging: ['staging/fresh-tx'] });

  // 落一个 finalized decision → 残留 staging 一律可删；committed 与 operation 保留
  const decided = await submitDecision(projectDir, RUN, {
    operationId: 'review-op-gc1', decision: makeDecision(), expectedStateChecksum: hex64('c'),
  });
  assert.equal(decided.ok, true);
  seedStaging(projectDir, 'loser-tx');
  const after = await gcRunReviewAssets(projectDir, RUN);
  assert.ok(after.removed.includes('staging/loser-tx'));
  assert.ok(after.kept.includes('committed'));
  assert.ok(after.kept.some((k) => k.startsWith('operations/')));
  assert.equal(existsSync(committedDecisionRecordPath(projectDir, RUN)), true, 'finalized 永不自动删');
}));

test('staging GC 持 run review lock：锁被占时拒绝，不并发决策临界区', () => withProject(async (projectDir) => {
  const dir = runDir(projectDir, RUN);
  mkdirSync(dir, { recursive: true });
  acquireRunReviewLock(dir, 'active-decision');
  try {
    const r = await gcRunReviewAssets(projectDir, RUN);
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'review_lock_held' });
  } finally {
    releaseRunReviewLock(dir, 'active-decision');
  }
}));

test('fact pack GC：未决全保留；已决后仅保留被 proposal 审计引用的', () => withProject(async (projectDir) => {
  const packs = join(reviewsDir(projectDir, RUN), 'fact-packs');
  mkdirSync(join(packs, 'fact-pack-used'), { recursive: true });
  mkdirSync(join(packs, 'fact-pack-orphan'), { recursive: true });
  const proposals = join(reviewsDir(projectDir, RUN), 'proposals');
  mkdirSync(proposals, { recursive: true });
  writeFileSync(join(proposals, 'p1.audit.json'), JSON.stringify({ fact_pack_id: 'fact-pack-used' }));

  // 未决：全保留
  await gcRunReviewAssets(projectDir, RUN);
  assert.deepEqual(readdirSync(packs).sort(), ['fact-pack-orphan', 'fact-pack-used']);

  // 已决：孤儿删除、被引用保留
  await submitDecision(projectDir, RUN, {
    operationId: 'review-op-gc2', decision: makeDecision(), expectedStateChecksum: hex64('c'),
  });
  const r = await gcRunReviewAssets(projectDir, RUN);
  assert.ok(r.removed.includes('fact-packs/fact-pack-orphan'));
  assert.deepEqual(readdirSync(packs), ['fact-pack-used']);
}));

test('grant GC：有效保留、已消费保留（即使过期）、过期未引用删除、损坏保留', () => withProject(async (projectDir) => {
  const base = {
    schema_version: 1, run_id: RUN, issued_at: '2026-07-16T12:00:00Z',
    scope: { outcomes: ['accept'], existing_fields: 'byte_identical', append_eval_max: 1, append_agent_review_max: 0, may_weaken_invariants: false, may_change_out_of_scope: false },
    execution: { policy: 'exact', inherit_parent_plans: true, allowed_plan_hashes: [] },
    limits: { max_commands: 8, max_total_seconds: 600, network: 'best_effort_not_denied' },
    one_shot: true,
    issued_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
  };
  createDelegationGrant(projectDir, { ...base, grant_id: 'g-valid', expires_at: '2026-07-20T00:00:00Z' });
  createDelegationGrant(projectDir, { ...base, grant_id: 'g-expired', expires_at: '2026-07-10T00:00:00Z' });
  createDelegationGrant(projectDir, { ...base, grant_id: 'g-consumed', expires_at: '2026-07-10T00:00:00Z' });
  writeFileSync(delegationGrantPath(projectDir, 'g-corrupt'), 'not json');

  // g-consumed 被 operation 引用（one-shot 已消费）
  mkdirSync(runDir(projectDir, RUN), { recursive: true });
  writeOperation(projectDir, RUN, buildOperation({
    operationId: 'review-op-gc3', runId: RUN, outcome: 'accept',
    expectedStateChecksum: hex64('c'), decision: makeDecision({ decision_id: 'decision-gcg' }),
    grant: { grant_id: 'g-consumed', grant_hash: hex64('d') },
  }));

  const r = gcDelegationGrants(projectDir, { now: new Date('2026-07-17T00:00:00Z') });
  assert.deepEqual(r.removed, ['g-expired']);
  assert.deepEqual(r.kept.sort(), ['g-consumed', 'g-corrupt', 'g-valid']);
}));

test('孤儿 snapshot：超 TTL 清除、新鲜保留；不触碰任何业务仓库文件', () => {
  const oldDir = mkdtempSync(join(tmpdir(), 'loop-review-snapshot-gcold-'));
  const newDir = mkdtempSync(join(tmpdir(), 'loop-review-snapshot-gcnew-'));
  try {
    utimesSync(oldDir, OLD, OLD);
    const r = sweepOrphanSnapshots({ now: new Date('2026-07-17T00:00:00Z') });
    assert.ok(r.removed.some((n) => oldDir.endsWith(n)));
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(newDir), true);
  } finally {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  }
});
