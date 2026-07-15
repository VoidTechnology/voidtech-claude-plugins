// F10 测试：V19（全部终态生成字段完整报告）、V21（固定声明与 best_effort/凭据披露齐全）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, FIXED_DECLARATIONS } from '../scripts/lib/report.mjs';

function baseState(overrides = {}) {
  return {
    state_version: 1,
    run_id: 'demo-abcd1234',
    goal_hash: 'a'.repeat(64),
    spec: {
      goal_id: 'demo',
      task: 'Fix the thing',
      manual_review: ['Confirm API compatibility'],
      out_of_scope: ['Performance tuning'],
      protected_paths: ['tests/acceptance/**'],
    },
    base_commit: 'b'.repeat(40),
    branch: 'loop/demo-abcd',
    worktree: '/tmp/loop-wt',
    status: 'RUNNING',
    stop_reason: null,
    stop_detail: null,
    iteration: 2,
    started_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:05:00Z',
    last_checkpoint: 'c'.repeat(40),
    candidate_commit: null,
    cost: { total_usd: null, unavailable: true },
    audit_recorded: [],
    rounds: [
      { iteration: 1, worker: { exit: 0, timed_out: false }, no_change: false, checkpoint: 'd'.repeat(40), eval: { passed: false, failed_ids: ['check'], results: [{ id: 'check', role: 'target', pass: false, runs: [{ exit: 1, timed_out: false, evidence: { path: '/tmp/ev/check.log' } }] }] } },
    ],
    ...overrides,
  };
}

const TERMINAL_STATES = [
  { status: 'EVALS_PASSED', stop_reason: null, candidate_commit: 'e'.repeat(40) },
  { status: 'ACCEPTED', stop_reason: null, candidate_commit: 'e'.repeat(40) },
  { status: 'STOPPED', stop_reason: 'exhausted', stop_detail: { kind: 'iterations', limit: 25 } },
  { status: 'STOPPED', stop_reason: 'blocked', stop_detail: { kind: 'no_progress', rounds: 3 } },
  { status: 'STOPPED', stop_reason: 'failed', stop_detail: { kind: 'audit_violation', violations: [{ kind: 'ref', item: 'refs/heads/rogue' }] } },
  { status: 'STOPPED', stop_reason: 'interrupted', stop_detail: { kind: 'worker_error', exit: 3 } },
  { status: 'STOPPED', stop_reason: 'canceled', stop_detail: { kind: 'user_stop' } },
];

test('V19：全部终态都生成含固定字段的报告', () => {
  for (const t of TERMINAL_STATES) {
    const md = renderReport(baseState(t));
    // 固定字段（PRD 6.2）
    for (const field of ['run ID', '状态', 'Goal Spec', 'base commit', '循环分支', 'worktree', '迭代数', 'token']) {
      assert.ok(md.includes(field), `${t.status}/${t.stop_reason}：缺字段 ${field}`);
    }
    assert.ok(md.includes(t.status), `应含状态 ${t.status}`);
    if (t.stop_reason) {
      assert.ok(md.includes(t.stop_reason), `应含 stop_reason ${t.stop_reason}`);
      assert.ok(md.includes('终止详情'), '非 happy 终态应含终止详情');
    }
    // 继续工作命令 + manual review + out of scope
    assert.ok(md.includes('--base'), '应给出 --base 继续命令');
    assert.ok(md.includes('Confirm API compatibility'), '应含 manual review');
    assert.ok(md.includes('Performance tuning'), '应含 out of scope');
  }
});

test('V21：报告含 best_effort、工具集、Bash 网络限制与全部固定声明', () => {
  const md = renderReport(baseState({ status: 'EVALS_PASSED', candidate_commit: 'e'.repeat(40) }));
  assert.ok(md.includes('best_effort'));
  assert.ok(md.includes('Read/Grep/Glob/Edit/Write/Bash'));
  assert.ok(md.includes('Bash 网络访问无法由一期完全阻断'));
  for (const decl of FIXED_DECLARATIONS) {
    assert.ok(md.includes(decl), `缺固定声明：${decl.slice(0, 20)}…`);
  }
});

test('EVALS_PASSED 报告提示 accept；token 可用时显示金额', () => {
  const md = renderReport(baseState({
    status: 'EVALS_PASSED',
    candidate_commit: 'e'.repeat(40),
    cost: { total_usd: 1.2345, unavailable: false },
  }));
  assert.ok(md.includes('loop accept demo-abcd1234'));
  assert.ok(md.includes('$1.2345'));
});

test('token 不可用时报告 unavailable，不伪造精确值', () => {
  const md = renderReport(baseState());
  assert.ok(md.includes('unavailable'));
});
