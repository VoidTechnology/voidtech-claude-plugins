// Task 4.3：Initial Review Context 预算、确定性裁剪与必需区 fail closed（技术设计 §7.2/§7.3）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitialReviewContext, INITIAL_CONTEXT_CAP, INLINE_DIFF_CAP,
} from '../scripts/lib/reviewcontext.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);

function makeManifest(overrides = {}) {
  return {
    schema_version: 1,
    fact_pack_id: 'fact-pack-001',
    run_id: 'payment-tests-a1b2c3d4',
    goal_hash: hex64('a'),
    state_checksum: hex64('b'),
    base_commit: hex40('1'),
    candidate_commit: hex40('2'),
    terminal_state: {
      status: 'EVALS_PASSED', stop_reason: null, iteration: 2, rounds_total: 2, evals_total: 1,
      evidence_total: 2, last_checkpoint: hex40('2'), started_at: '2026-07-16T10:00:00Z',
      updated_at: '2026-07-16T10:30:00Z', cost_unavailable: true, cost_total_usd: null,
    },
    spec: { locator: 'spec', total_bytes: 100, sha256: hex64('c') },
    diff: { locator: 'diff', total_bytes: 500, sha256: hex64('d'), files: [{ path: 'src/app.js', additions: 3, deletions: 1, binary: false }] },
    rounds: [
      { iteration: 1, locator: 'round-1', no_change: false, checkpoint: hex40('3'), eval_passed: false, failed_ids: ['check'] },
      { iteration: 2, locator: 'round-2', no_change: false, checkpoint: hex40('2'), eval_passed: true, failed_ids: [] },
    ],
    evidence: [
      { id: 'check-i1-r1', locator: 'evidence/iteration-1/check-run1.log', file_bytes: 50, file_sha256: hex64('e'), stream_total_bytes: 50, stream_sha256: hex64('e'), truncated: false },
    ],
    snapshot: { snapshot_id: 'snapshot-001', tracked_files_manifest_hash: hex64('f') },
    delegation_grant_hash: null,
    ...overrides,
  };
}

const SPEC = {
  schema_version: 1, goal_id: 'payment-tests', task: 'fix tests', base_commit: hex40('1'),
  budgets: { max_iterations: 5, max_duration_seconds: 3600 },
  evals: [{ id: 'check', role: 'target', command: ['bash', 'c.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
  protected_paths: [], manual_review: ['Confirm API compatibility'], out_of_scope: [],
};

test('装配确定性：相同输入产出逐字节相同的上下文，优先级 1-4 分区齐全', () => {
  const input = { manifest: makeManifest(), spec: SPEC, diffText: 'diff --git a/src/app.js\n+new line\n', evidenceSummaries: [{ id: 'check-i1-r1', summary: 'assertion failed at line 3' }] };
  const a = buildInitialReviewContext(input);
  const b = buildInitialReviewContext(input);
  assert.equal(a.ok, true);
  assert.equal(a.context, b.context, '裁剪结果必须确定性');

  for (const marker of [
    'Frozen Goal Spec (canonical)', 'Terminal State Projection', 'Delegation Grant',
    'Fact Pack Index', 'Changed Files (diffstat)', 'Rounds / Eval Matrix',
    'Candidate Diff', 'Evidence Summaries',
  ]) {
    assert.match(a.context, new RegExp(marker.replace(/[()/]/g, '\\$&')), `缺少分区：${marker}`);
  }
  assert.ok(a.total_bytes <= INITIAL_CONTEXT_CAP);
  assert.deepEqual(a.omitted, []);
});

test('inline diff 超过 48 KiB 被裁剪并显式登记，不静默丢弃', () => {
  const bigDiff = `diff --git a/x\n${'+'.repeat(200)}\n`.repeat(2000); // 远超 48 KiB
  const r = buildInitialReviewContext({ manifest: makeManifest(), spec: SPEC, diffText: bigDiff, evidenceSummaries: [] });
  assert.equal(r.ok, true);
  assert.ok(r.omitted.includes('diff_clipped'));
  assert.match(r.context, /Omitted From Initial Context/);
  assert.match(r.context, /经 manifest 按需读取/);
  assert.ok(r.total_bytes <= INITIAL_CONTEXT_CAP);
  // diff 区不超过其子配额（含边界余量）
  assert.ok(r.total_bytes - r.required_bytes < INLINE_DIFF_CAP + 32 * 1024);
});

test('必需区超出 128 KiB：拒绝 review，不截断规格', () => {
  const hugeSpec = { ...SPEC, task: 'x'.repeat(INITIAL_CONTEXT_CAP + 1024) };
  const r = buildInitialReviewContext({ manifest: makeManifest(), spec: hugeSpec, diffText: '', evidenceSummaries: [] });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'required_context_overflow' });
  assert.ok(r.required_bytes > INITIAL_CONTEXT_CAP);
});

test('grant 存在时进入必需区；无 grant 时明示建议模式', () => {
  const withGrant = buildInitialReviewContext({
    manifest: makeManifest({ delegation_grant_hash: hex64('9') }),
    spec: SPEC, diffText: '',
    grant: { grant_id: 'review-grant-001', scope: { outcomes: ['accept'] } },
    evidenceSummaries: [],
  });
  assert.match(withGrant.context, /review-grant-001/);

  const suggestion = buildInitialReviewContext({ manifest: makeManifest(), spec: SPEC, diffText: '', evidenceSummaries: [] });
  assert.match(suggestion.context, /建议模式：无授权/);
});
