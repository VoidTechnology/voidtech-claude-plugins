// Task 2.1：v1 goal_hash golden 兼容集（技术设计 §4.2，P2-02）。
// fixture 由一期实现（0.2.0，HEAD 68cbad3 之后的 M1 基线）生成并锁定：
// 相同 YAML 原文经完整 parser/validator 得到的 normalized canonical JSON 和 goal_hash
// 必须与 fixture 逐字节一致，不得以"语义等价"放宽。改动 yaml.mjs/validate.mjs/schema 任何
// 一层导致本测试失败时，必须视为 v1 兼容性破坏，先修实现而不是更新 fixture。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpecText, canonicalJson } from '../scripts/lib/validate.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/goal-spec-v1-golden.json', import.meta.url), 'utf8'));

test('golden 集非空且覆盖约定场景', () => {
  const names = GOLDEN.map((c) => c.name);
  for (const required of [
    'simple-target-defaults', 'complex-full-fields', 'uppercase-short-sha',
    'key-order-and-comments', 'scalar-quoting-edges',
  ]) {
    assert.ok(names.includes(required), `缺少 golden case：${required}`);
  }
});

for (const c of GOLDEN) {
  test(`v1 golden：${c.name} 的 canonical JSON 与 goal_hash 逐字节不变`, () => {
    const v = validateSpecText(c.yaml);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(canonicalJson(v.normalized), c.expected_canonical, 'normalized canonical JSON 漂移');
    assert.equal(v.goal_hash, c.expected_goal_hash, 'goal_hash 漂移');
  });
}

test('键序与注释不影响 hash：与基准 case 完全一致', () => {
  const reordered = GOLDEN.find((c) => c.name === 'key-order-and-comments');
  const base = GOLDEN.find((c) => c.name === reordered.same_hash_as);
  assert.equal(reordered.expected_goal_hash, base.expected_goal_hash);
  assert.equal(reordered.expected_canonical, base.expected_canonical);
});

test('大写短 SHA：normalize 只小写化，完整化由 lifecycle 负责（另见 p1-goal-hash-full-sha）', () => {
  const c = GOLDEN.find((x) => x.name === 'uppercase-short-sha');
  const v = validateSpecText(c.yaml);
  assert.equal(v.normalized.base_commit, 'a1b2c3d');
});

test('标量类型边角：带引号数字/布尔保持字符串进入 canonical 形态', () => {
  const c = GOLDEN.find((x) => x.name === 'scalar-quoting-edges');
  const v = validateSpecText(c.yaml);
  assert.deepEqual(v.normalized.evals[0].command, ['node', 'script.js', '1', 'true', '007']);
  assert.match(c.expected_canonical, /"1","true","007"/);
});
