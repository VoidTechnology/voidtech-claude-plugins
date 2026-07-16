// L6 回归测试（QA 发现）：状态含 undefined 值的字段时，写读往返不得被误判为 corrupt。
// canonicalJson 须跳过 undefined 键，与 JSON.stringify 落盘语义一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeState, readState } from '../scripts/lib/statestore.mjs';
import { canonicalJson } from '../scripts/lib/validate.mjs';

test('L6: canonicalJson 跳过 undefined 值的键（与落盘一致）', () => {
  const withUndef = canonicalJson({ a: 1, b: undefined, c: 2 });
  const without = canonicalJson({ a: 1, c: 2 });
  assert.equal(withUndef, without);
});

test('L6: 含 undefined 字段的状态写读往返不被误判 corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l6-state-'));
  try {
    writeState(dir, { state_version: 1, run_id: 'r', status: 'RUNNING', optional_field: undefined, iteration: 1 });
    const r = readState(dir);
    assert.equal(r.ok, true, `不应被误判 corrupt：${r.reason}`);
    assert.equal(r.state.run_id, 'r');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
