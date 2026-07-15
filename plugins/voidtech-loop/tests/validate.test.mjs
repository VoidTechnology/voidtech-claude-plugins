// validate 单元测试：覆盖 PRD V1（预算默认值）、V2（拒绝规则）与 goal_hash 稳定性（V3 的哈希部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecText } from '../scripts/lib/validate.mjs';

const VALID_SPEC = `
schema_version: 1
goal_id: payment-tests
task: Fix failing tests in the payment module
base_commit: 0123456789abcdef
budgets:
  max_iterations: 25
  max_duration_seconds: 3600
protected_paths:
  - tests/payment/acceptance/**
evals:
  - id: payment-tests
    role: target
    command: [npm, test, --, payment]
    cwd: .
    expected_exit: 0
    timeout_seconds: 600
    repeat: 1
manual_review:
  - Confirm the public payment API remains source-compatible
out_of_scope:
  - Performance tuning beyond passing tests
`;

test('PRD 3.1 示例 spec 校验通过并产出稳定 goal_hash', () => {
  const r = validateSpecText(VALID_SPEC);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.goal_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.flags.shell, false);
});

test('goal_hash 对键序与注释不敏感，对内容敏感', () => {
  const base = validateSpecText(VALID_SPEC);
  const reordered = validateSpecText(
    VALID_SPEC.replace('schema_version: 1\ngoal_id: payment-tests', 'goal_id: payment-tests # 注释\nschema_version: 1'),
  );
  assert.equal(reordered.ok, true, JSON.stringify(reordered.errors));
  assert.equal(reordered.goal_hash, base.goal_hash);

  const changed = validateSpecText(VALID_SPEC.replace('max_iterations: 25', 'max_iterations: 26'));
  assert.notEqual(changed.goal_hash, base.goal_hash);
});

test('V1：缺 max_iterations 拒绝并指出字段', () => {
  const r = validateSpecText(VALID_SPEC.replace('  max_iterations: 25\n', ''));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('max_iterations')), JSON.stringify(r.errors));
});

test('V1：缺 max_duration_seconds 规范化为 3600 且通过', () => {
  const r = validateSpecText(VALID_SPEC.replace('  max_duration_seconds: 3600\n', ''));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.normalized.budgets.max_duration_seconds, 3600);
});

test('V2：未知字段拒绝', () => {
  const r = validateSpecText(VALID_SPEC.replace('task:', 'capabilities: none\ntask:'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes('capabilities')), JSON.stringify(r.errors));
});

test('V2：缺少 target 拒绝', () => {
  const r = validateSpecText(VALID_SPEC.replace('role: target', 'role: invariant'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('target')), JSON.stringify(r.errors));
});

test('V2：相对基线比较器给出定向拒绝', () => {
  const r = validateSpecText(VALID_SPEC.replace('    repeat: 1\n', '    repeat: 1\n    baseline: 10\n'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('相对基线比较器')), JSON.stringify(r.errors));
});

test('V2：无超时 eval 拒绝', () => {
  const r = validateSpecText(VALID_SPEC.replace('    timeout_seconds: 600\n', ''));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('timeout_seconds')), JSON.stringify(r.errors));
});

test('V2：非法 cwd（.. 逃逸与绝对路径）拒绝', () => {
  for (const bad of ['../outside', '/etc']) {
    const r = validateSpecText(VALID_SPEC.replace('cwd: .', `cwd: ${bad}`));
    assert.equal(r.ok, false, `cwd=${bad} 应被拒绝`);
  }
});

test('V2：protected_paths 含 ! 否定模式拒绝', () => {
  const r = validateSpecText(
    VALID_SPEC.replace('tests/payment/acceptance/**', '"!tests/payment/acceptance/**"'),
  );
  assert.equal(r.ok, false);
});

test('eval id 重复拒绝', () => {
  const dup = VALID_SPEC.replace(
    'manual_review:',
    `  - id: payment-tests
    role: invariant
    command: [npm, run, lint]
    timeout_seconds: 60
manual_review:`,
  );
  const r = validateSpecText(dup);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('重复')), JSON.stringify(r.errors));
});

test('shell 与 command 形态必须一致', () => {
  const shellArgv = VALID_SPEC.replace('    repeat: 1\n', '    repeat: 1\n    shell: true\n');
  const r1 = validateSpecText(shellArgv);
  assert.equal(r1.ok, false, 'shell: true + argv 数组应被拒绝');

  const stringNoShell = VALID_SPEC.replace('command: [npm, test, --, payment]', 'command: npm test');
  const r2 = validateSpecText(stringNoShell);
  assert.equal(r2.ok, false, '未声明 shell 的字符串 command 应被拒绝');
});

test('疑似凭据字面量拒绝', () => {
  const r = validateSpecText(VALID_SPEC.replace('Fix failing tests in the payment module', 'Use token ghp_abcdefghijklmnop1234'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('凭据')), JSON.stringify(r.errors));
});

test('YAML 危险语法被拒绝：锚点、块标量、flow 映射、tab、多文档', () => {
  const cases = [
    'a: &anchor 1',
    'a: |\n  text',
    'a: {b: 1}',
    '\ta: 1',
    '---\na: 1',
  ];
  for (const text of cases) {
    const r = validateSpecText(text);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(text)}`);
    assert.ok(r.errors[0].message.includes('YAML'), r.errors[0].message);
  }
});

test('command 数组含未加引号的数字/布尔时给出定向提示', () => {
  const r = validateSpecText(VALID_SPEC.replace('command: [npm, test, --, payment]', 'command: [sleep, 30]'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes('请加引号')), JSON.stringify(r.errors));
});

test('规范化填齐 eval 默认值', () => {
  const minimalEval = VALID_SPEC
    .replace('    cwd: .\n', '')
    .replace('    expected_exit: 0\n', '')
    .replace('    repeat: 1\n', '');
  const r = validateSpecText(minimalEval);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const e = r.normalized.evals[0];
  assert.equal(e.cwd, '.');
  assert.equal(e.expected_exit, 0);
  assert.equal(e.repeat, 1);
  assert.equal(e.shell, false);
});
