// Task 3.2：Delegation Grant 冻结、one-shot claim 与 exact plan gate（技术设计 §5.2，P2-28）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDelegationGrant, readDelegationGrant, evaluateGrantClaim,
  checkOutcomeAllowed, checkPlanAgainstGrant,
} from '../scripts/lib/delegationgrant.mjs';
import { buildExecutionPlan } from '../scripts/lib/executionplan.mjs';
import { buildOperation, writeOperation } from '../scripts/lib/reviewoperation.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';
const FULL = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

function makeGrant(overrides = {}) {
  return {
    schema_version: 1,
    grant_id: 'review-grant-001',
    run_id: RUN,
    issued_at: '2026-07-16T12:00:00Z',
    scope: {
      outcomes: ['accept', 'revise'],
      existing_fields: 'byte_identical',
      append_eval_max: 3,
      append_agent_review_max: 2,
      may_weaken_invariants: false,
      may_change_out_of_scope: false,
    },
    execution: { policy: 'exact', inherit_parent_plans: true, allowed_plan_hashes: [] },
    limits: { max_commands: 8, max_total_seconds: 3600, network: 'best_effort_not_denied' },
    expires_at: '2026-07-17T12:00:00Z',
    one_shot: true,
    issued_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    ...overrides,
  };
}

function makeDecision(overrides = {}) {
  return {
    schema_version: 1,
    decision_id: 'decision-001',
    run_id: RUN,
    goal_hash: hex64('a'),
    source_commit: hex40('b'),
    outcome: 'accept',
    manual_review_results: [],
    decided_at: '2026-07-16T12:30:00Z',
    decided_by: { kind: 'agent', session_id: 'review-session-1', authorization: 'bounded_delegate' },
    authorization: { grant_id: 'review-grant-001', grant_hash: hex64('c') },
    proposal_hash: hex64('d'),
    approval_bundle_hash: hex64('e'),
    basis: { original_goal_hash: hex64('a'), supplemental_verification: null },
    note: null,
    ...overrides,
  };
}

function makePlan(evalOverrides = []) {
  const v = validateSpecObject({
    schema_version: 1,
    goal_id: 'payment-tests',
    task: 'fix',
    base_commit: FULL,
    budgets: { max_iterations: 10 },
    evals: evalOverrides.length ? evalOverrides
      : [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 300 }],
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return buildExecutionPlan(v.normalized, hex40('b'));
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'grant-'));
  try {
    return callback(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

test('grant 冻结：创建后只读、hash 稳定、重复创建拒绝', () => withProject((projectDir) => {
  const created = createDelegationGrant(projectDir, makeGrant());
  assert.equal(created.ok, true);
  const read = readDelegationGrant(projectDir, 'review-grant-001');
  assert.equal(read.ok, true);
  assert.equal(read.grant_hash, created.grant_hash);
  assert.equal(createDelegationGrant(projectDir, makeGrant()).reason, 'grant_exists');
}));

test('schema 强制 Phase 2 边界：非 exact policy、可弱化 invariant、通配 allowlist 均拒绝', () => withProject((projectDir) => {
  const patterns = createDelegationGrant(projectDir, makeGrant({
    grant_id: 'g-pattern',
    execution: { policy: 'exact', inherit_parent_plans: true, allowed_plan_hashes: ['npm-*'] },
  }));
  assert.equal(patterns.reason, 'invalid_grant', '通配符不满足精确 hash pattern');

  const weaken = createDelegationGrant(projectDir, makeGrant({
    grant_id: 'g-weaken',
    scope: { ...makeGrant().scope, may_weaken_invariants: true },
  }));
  assert.equal(weaken.reason, 'invalid_grant');

  const prefix = createDelegationGrant(projectDir, makeGrant({
    grant_id: 'g-prefix',
    execution: { policy: 'prefix', inherit_parent_plans: true, allowed_plan_hashes: [] },
  }));
  assert.equal(prefix.reason, 'invalid_grant');

  const abandonOutcome = createDelegationGrant(projectDir, makeGrant({
    grant_id: 'g-abandon',
    scope: { ...makeGrant().scope, outcomes: ['abandon'] },
  }));
  assert.equal(abandonOutcome.reason, 'invalid_grant', 'agent 自动 Abandon 不在 Phase 2 范围');
}));

test('one-shot claim：首次可用、他决定消费后拒绝、matching operation 恢复且不再查过期', () => withProject((projectDir) => {
  const grant = makeGrant();
  const decision = makeDecision();
  const before = new Date('2026-07-17T00:00:00Z');

  // 首次 claim：过期检查只发生在这里
  assert.equal(evaluateGrantClaim(projectDir, RUN, grant, { decision, now: before }).ok, true);
  assert.equal(evaluateGrantClaim(projectDir, RUN, grant, {
    decision, now: new Date('2026-07-18T00:00:00Z'),
  }).reason, 'grant_expired');

  // 写入引用该 grant 的 prepared operation（= claim 已发生）
  writeOperation(projectDir, RUN, buildOperation({
    operationId: 'review-op-claim', runId: RUN, outcome: 'accept',
    expectedStateChecksum: hex64('f'), decision, grant: { grant_id: grant.grant_id, grant_hash: hex64('c') },
  }));

  // 相同决定在过期后仍可恢复：claim 后对整个生命周期有效（S10 语义）
  const recovery = evaluateGrantClaim(projectDir, RUN, grant, {
    decision, now: new Date('2026-07-20T00:00:00Z'),
  });
  assert.deepEqual({ ok: recovery.ok, recovery: recovery.recovery }, { ok: true, recovery: true });

  // 不同决定：one-shot 已被消费
  const other = evaluateGrantClaim(projectDir, RUN, grant, {
    decision: makeDecision({ note: 'different decision' }), now: before,
  });
  assert.deepEqual({ ok: other.ok, reason: other.reason }, { ok: false, reason: 'grant_consumed' });

  // run 不匹配
  assert.equal(evaluateGrantClaim(projectDir, 'other-run', grant, { decision, now: before }).reason, 'wrong_run');
}));

test('exact plan gate：仅"未变父 plan + inherit"或"精确列于 allowlist"通过', () => {
  const { plan, execution_plan_hash: parentHash } = makePlan();

  // 继承路径
  const inherit = checkPlanAgainstGrant(makeGrant(), { plan, planHash: parentHash, parentPlanHash: parentHash });
  assert.deepEqual({ ok: inherit.ok, inherited: inherit.inherited }, { ok: true, inherited: true });

  // plan 变化（追加 argv eval）→ 新 hash 不在 allowlist → 升级
  const changed = makePlan([
    { id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 300 },
    { id: 'new-argv', role: 'invariant', command: ['node', '--test', 'x.test.mjs'], timeout_seconds: 120 },
  ]);
  const denied = checkPlanAgainstGrant(makeGrant(), {
    plan: changed.plan, planHash: changed.execution_plan_hash, parentPlanHash: parentHash,
  });
  assert.deepEqual({ ok: denied.ok, reason: denied.reason, escalate: denied.escalate },
    { ok: false, reason: 'plan_not_authorized', escalate: true });

  // 精确授权后通过
  const allowed = checkPlanAgainstGrant(
    makeGrant({ execution: { policy: 'exact', inherit_parent_plans: false, allowed_plan_hashes: [changed.execution_plan_hash] } }),
    { plan: changed.plan, planHash: changed.execution_plan_hash, parentPlanHash: parentHash },
  );
  assert.deepEqual({ ok: allowed.ok, listed: allowed.listed }, { ok: true, listed: true });

  // inherit 关闭时父 plan 也不能复用
  const noInherit = checkPlanAgainstGrant(
    makeGrant({ execution: { policy: 'exact', inherit_parent_plans: false, allowed_plan_hashes: [] } }),
    { plan, planHash: parentHash, parentPlanHash: parentHash },
  );
  assert.equal(noInherit.reason, 'plan_not_authorized');
});

test('limits 与网络能力机械检查：越界一律升级', () => {
  const { plan, execution_plan_hash } = makePlan();
  const base = { plan, planHash: execution_plan_hash, parentPlanHash: execution_plan_hash };

  const tooMany = checkPlanAgainstGrant(
    makeGrant({ limits: { max_commands: 0, max_total_seconds: 3600, network: 'best_effort_not_denied' } }),
    base,
  );
  // schema minimum 是 1，此处直接构造运行时对象绕过创建入口来测判定器本身
  assert.equal(tooMany.reason, 'too_many_commands');

  const tooLong = checkPlanAgainstGrant(
    makeGrant({ limits: { max_commands: 8, max_total_seconds: 100, network: 'best_effort_not_denied' } }),
    base,
  );
  assert.equal(tooLong.reason, 'total_timeout_exceeded');

  // 声明 denied 但 runner 无法机械执行 → 升级，不把声明当隔离
  const denied = checkPlanAgainstGrant(
    makeGrant({ limits: { max_commands: 8, max_total_seconds: 3600, network: 'denied' } }),
    base,
  );
  assert.deepEqual({ reason: denied.reason, escalate: denied.escalate },
    { reason: 'network_policy_unsupported', escalate: true });
});

test('outcome 判定与 Decision Record 引用形态', () => {
  const grant = makeGrant();
  assert.equal(checkOutcomeAllowed(grant, 'accept').ok, true);
  assert.equal(checkOutcomeAllowed(grant, 'revise').ok, true);
  assert.deepEqual(checkOutcomeAllowed(grant, 'abandon'),
    { ok: false, reason: 'outcome_not_allowed', escalate: true });
});
