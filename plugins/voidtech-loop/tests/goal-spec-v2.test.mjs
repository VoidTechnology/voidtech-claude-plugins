// Task 2.2/2.3：Goal Spec v2 schema、版本路由与共存语义（技术设计 §4，P2-03）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecObject, validateSpecText } from '../scripts/lib/validate.mjs';

const FULL = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const hex64 = (c) => c.repeat(64);

function omit(obj, ...keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

function v2Spec(overrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'payment-tests',
    task: 'Fix failing tests in the payment module',
    base_commit: FULL,
    budgets: { max_iterations: 25 },
    evals: [{ id: 'payment-tests', role: 'target', command: ['npm', 'test'], timeout_seconds: 600 }],
    agent_review: [{
      id: 'public-api-compatibility',
      criterion: 'Verify that public API behavior remains source-compatible.',
      required: true,
      evidence_scope: ['candidate_diff', 'repository', 'eval_results'],
    }],
    review_policy: { default_mode: 'suggestion', bounded_delegate_allowed: false },
    provenance: {
      parent_run: { run_id: 'payment-tests-a1b2c3d4', goal_hash: hex64('a'), source_commit: FULL },
      feedback: [{ feedback_id: 'payment-review-001', feedback_hash: hex64('b') }],
    },
    ...overrides,
  };
}

test('合法 v2 spec 通过校验，v1 默认值同样适用，新字段进入 normalized 与 hash', () => {
  const v = validateSpecObject(v2Spec());
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.normalized.schema_version, 2);
  assert.equal(v.normalized.budgets.max_duration_seconds, 3600, 'v1 默认值适用');
  assert.equal(v.normalized.evals[0].shell, false);
  assert.equal(v.normalized.agent_review[0].id, 'public-api-compatibility');
  assert.equal(v.normalized.review_policy.bounded_delegate_allowed, false);
  assert.equal(v.normalized.provenance.parent_run.run_id, 'payment-tests-a1b2c3d4');

  // agent_review 变化改变 goal_hash（进入冻结契约）
  const without = validateSpecObject(omit(v2Spec(), 'agent_review', 'review_policy', 'provenance'));
  assert.equal(without.ok, true);
  assert.notEqual(without.goal_hash, v.goal_hash);
});

test('v1/v2 不承诺跨版本 hash 相等：schema_version 进入 canonical 内容', () => {
  const shared = {
    goal_id: 'payment-tests',
    task: 'Fix failing tests in the payment module',
    base_commit: FULL,
    budgets: { max_iterations: 25 },
    evals: [{ id: 'payment-tests', role: 'target', command: ['npm', 'test'], timeout_seconds: 600 }],
  };
  const v1 = validateSpecObject({ schema_version: 1, ...shared });
  const v2 = validateSpecObject({ schema_version: 2, ...shared });
  assert.equal(v1.ok, true);
  assert.equal(v2.ok, true);
  assert.notEqual(v1.goal_hash, v2.goal_hash);
});

test('v1 拒绝 v2 字段（agent_review / review_policy / provenance）', () => {
  for (const field of ['agent_review', 'review_policy', 'provenance']) {
    const spec = v2Spec();
    const v1Attempt = { ...spec, schema_version: 1 };
    const v = validateSpecObject(v1Attempt);
    assert.equal(v.ok, false, `${field} 不应被 v1 接受`);
    assert.ok(v.errors.some((e) => e.path.includes(field)), `应指出 ${field} 为未知字段`);
  }
});

test('未知版本 fail closed：数字 3、字符串 "2" 均拒绝且给出定向错误', () => {
  for (const version of [3, '2', 0, null]) {
    const v = validateSpecObject(v2Spec({ schema_version: version }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.path === '$.schema_version'),
      `version=${JSON.stringify(version)} 应在 schema_version 上报错：${JSON.stringify(v.errors)}`,
    );
  }
});

test('v2 严格拒绝未知字段', () => {
  const v = validateSpecObject({ ...v2Spec(), execution_plan: {} });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === '$.execution_plan'));
});

test('agent_review 语义规则：id 重复与 eval id 冲突均拒绝', () => {
  const dup = v2Spec({
    agent_review: [
      { id: 'same-check', criterion: 'a', required: true, evidence_scope: ['candidate_diff'] },
      { id: 'same-check', criterion: 'b', required: false, evidence_scope: ['repository'] },
    ],
  });
  assert.equal(validateSpecObject(dup).ok, false);

  const clash = v2Spec({
    agent_review: [{ id: 'payment-tests', criterion: 'clashes with eval', required: true, evidence_scope: ['candidate_diff'] }],
  });
  const v = validateSpecObject(clash);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes('冲突')));
});

test('v2 YAML 文本入口与对象入口一致', () => {
  const yaml = `schema_version: 2
goal_id: payment-tests
task: Fix failing tests in the payment module
base_commit: ${FULL}
budgets:
  max_iterations: 25
evals:
  - id: payment-tests
    role: target
    command: [npm, test]
    timeout_seconds: 600
agent_review:
  - id: public-api-compatibility
    criterion: Verify that public API behavior remains source-compatible.
    required: true
    evidence_scope: [candidate_diff, repository, eval_results]
review_policy:
  default_mode: suggestion
  bounded_delegate_allowed: false
`;
  const fromText = validateSpecText(yaml);
  assert.equal(fromText.ok, true, JSON.stringify(fromText.errors));
  assert.equal(fromText.normalized.schema_version, 2);

  const fromObject = validateSpecObject(omit(v2Spec(), 'provenance'));
  assert.equal(fromText.goal_hash, fromObject.goal_hash);
});

test('相对基线比较器与 secret 扫描等 v1 语义规则对 v2 同样生效', () => {
  const relative = v2Spec({
    evals: [{ id: 't', role: 'target', command: ['x'], timeout_seconds: 60, baseline: 'main' }],
  });
  assert.equal(validateSpecObject(relative).ok, false);

  const secret = v2Spec({ task: 'use sk-abcdefghijklmnop to auth' });
  assert.equal(validateSpecObject(secret).ok, false);
});
