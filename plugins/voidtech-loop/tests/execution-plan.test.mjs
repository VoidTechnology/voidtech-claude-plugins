// Task 3.1：canonical Execution Plan 与 execution_plan_hash（技术设计 §5.1，P2-04）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionPlan, renderExecutionPlan } from '../scripts/lib/executionplan.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';

const FULL = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const COMMIT = 'f'.repeat(40);

function normalizedSpec(overrides = {}) {
  const v = validateSpecObject({
    schema_version: 1,
    goal_id: 'payment-tests',
    task: 'Fix failing tests',
    base_commit: FULL,
    budgets: { max_iterations: 10 },
    setup: ['npm ci'],
    evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 600 },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    ],
    ...overrides,
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return v.normalized;
}

test('plan 覆盖 setup/argv/shell 三类命令与全部执行语义', () => {
  const { plan } = buildExecutionPlan(normalizedSpec(), COMMIT);
  assert.equal(plan.candidate_commit, COMMIT);
  assert.deepEqual(plan.commands.map((c) => [c.phase, c.id, c.kind]), [
    ['setup', 'setup-1', 'shell'],
    ['eval', 'contract-tests', 'argv'],
    ['eval', 'e2e-shell', 'shell'],
  ]);
  const argv = plan.commands[1];
  assert.equal(argv.executable, 'npm');
  assert.deepEqual(argv.args, ['test', '--', 'contract']);
  for (const c of plan.commands) {
    assert.ok(c.environment_policy && c.network_policy && c.filesystem_policy, '策略字段进入 plan');
    assert.ok(Number.isInteger(c.timeout_seconds));
  }
});

test('任一执行语义变化改变 execution_plan_hash（argv 与 shell 同权）', () => {
  const base = buildExecutionPlan(normalizedSpec(), COMMIT).execution_plan_hash;

  const mutations = [
    ['改 argv 参数', normalizedSpec({ evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'payment'], timeout_seconds: 600 },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    ] })],
    ['改 timeout', normalizedSpec({ evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 601 },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    ] })],
    ['改 cwd', normalizedSpec({ evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 600, cwd: 'packages/a' },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    ] })],
    ['改 shell 原文', normalizedSpec({ evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 600 },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e', timeout_seconds: 900 },
    ] })],
    ['改 setup', normalizedSpec({ setup: ['npm ci --ignore-scripts'] })],
    ['改 repeat', normalizedSpec({ evals: [
      { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 600, repeat: 2 },
      { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    ] })],
  ];
  for (const [name, spec] of mutations) {
    assert.notEqual(buildExecutionPlan(spec, COMMIT).execution_plan_hash, base, name);
  }

  // commit 绑定：同 spec 不同 commit → 不同 hash
  assert.notEqual(buildExecutionPlan(normalizedSpec(), 'e'.repeat(40)).execution_plan_hash, base);

  // 顺序进入 hash：交换两条 eval → 不同 hash
  const swapped = normalizedSpec({ evals: [
    { id: 'e2e-shell', role: 'target', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 900 },
    { id: 'contract-tests', role: 'target', command: ['npm', 'test', '--', 'contract'], timeout_seconds: 600 },
  ] });
  assert.notEqual(buildExecutionPlan(swapped, COMMIT).execution_plan_hash, base);
});

test('相同 spec 与 commit 的 plan hash 稳定（幂等派生，无第二份持久化定义）', () => {
  const a = buildExecutionPlan(normalizedSpec(), COMMIT);
  const b = buildExecutionPlan(normalizedSpec(), COMMIT);
  assert.equal(a.execution_plan_hash, b.execution_plan_hash);
});

test('渲染视图：shell 标注高风险，argv 不因绕过 shell 解析而降权', () => {
  const { plan } = buildExecutionPlan(normalizedSpec(), COMMIT);
  const lines = renderExecutionPlan(plan);
  assert.equal(lines.length, 3);
  assert.match(lines.find((l) => l.includes('e2e-shell')), /高风险/);
  assert.doesNotMatch(lines.find((l) => l.includes('contract-tests')), /高风险/);
  assert.match(lines.find((l) => l.includes('setup-1')), /npm ci/);
});
