// Task 5.3：建议模式 /review 端到端（stub reviewer）——状态矩阵、纠正路径、审计与无 hash 摘要。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { runSuggestionReview } from '../scripts/lib/reviewflow.mjs';
import { acceptRun, abandonRun } from '../scripts/lib/lifecycle.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir, reviewsDir } from '../scripts/lib/reviewstore.mjs';
import { acquireRunReviewLock, releaseRunReviewLock } from '../scripts/lib/runreviewlock.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';

function makeStub(judgmentOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-stub-'));
  const path = join(dir, 'stub.sh');
  const judgment = {
    recommended_outcome: 'accept',
    findings: [{
      id: 'finding-001', category: 'compatibility', severity: 'minor',
      summary: 'Minor API surface change, covered by evals.', evidence_refs: ['diff:src/app.js'],
    }],
    agent_review_results: [],
    escalations: [],
    ...judgmentOverrides,
  };
  const envelope = JSON.stringify({
    result: JSON.stringify(judgment), session_id: `stub-${Math.random().toString(16).slice(2, 10)}`,
    total_cost_usd: 0.08, num_turns: 1,
  });
  writeFileSync(path, `#!/bin/bash\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`, { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

async function withTerminalRun(callback, { status = 'EVALS_PASSED' } = {}) {
  await withDataRoot(async () => {
    const fixture = makeTestRepo({ prefix: 'flow-', files: { 'src/app.js': 'v1\n' } });
    const { repo, git } = fixture;
    writeFileSync(join(repo, 'src/app.js'), 'v2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD').stdout.trim();
    const stub = makeStub();
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const evidenceRel = join('evidence', 'iteration-1', 'check-run1.log');
      mkdirSync(join(stateDir, 'evidence', 'iteration-1'), { recursive: true });
      writeFileSync(join(stateDir, evidenceRel), 'ok\n');
      writeState(stateDir, {
        state_version: STATE_VERSION, run_id: RUN, status,
        stop_reason: status === 'STOPPED' ? 'exhausted' : null,
        goal_hash: hex64('a'), base_commit: fixture.sha, last_checkpoint: candidate, candidate_commit: candidate,
        branch: 'b', worktree: '/tmp/wt', iteration: 1, started_at: '2026-07-16T10:00:00Z',
        spec: {
          schema_version: 1, goal_id: 'payment-tests', task: 'fix', base_commit: fixture.sha,
          budgets: { max_iterations: 5, max_duration_seconds: 3600 },
          evals: [{ id: 'check', role: 'target', command: ['bash', 'c.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
          protected_paths: [], manual_review: [], out_of_scope: [],
        },
        rounds: [{
          iteration: 1, worker: { exit: 0, timed_out: false }, no_change: false, checkpoint: candidate,
          eval: { passed: status === 'EVALS_PASSED', failed_ids: [], results: [{ id: 'check', role: 'target', pass: true, timed_out: false, runs: [{ exit: 0, timed_out: false, duration_ms: 5, evidence: { path: evidenceRel, total_bytes: 3, sha256: hex64('e'), truncated: false } }] }] },
        }],
        cost: { total_usd: 0, unavailable: true },
      });
      await callback({ repo, projectDir, stateDir, stub });
    } finally {
      rmSync(stub.dir, { recursive: true, force: true });
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
}

test('happy path：建议生成、摘要无 hash、审计有 hash，accept 后 review 返回既有决定', () => withTerminalRun(async ({ repo, projectDir, stub }) => {
  const r = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(r.ok, true, JSON.stringify(r));

  // 摘要：建议 + 动作 + coverage，normal path 不出现任何 64 位 hash
  assert.match(r.summary, /Review 建议：ACCEPT/);
  assert.match(r.summary, /loop accept payment-tests-a1b2c3d4/);
  assert.match(r.summary, /loop abandon payment-tests-a1b2c3d4/);
  assert.match(r.summary, /不会自动执行任何一项/);
  assert.doesNotMatch(r.summary, /[0-9a-f]{64}/);

  // 审计视图可展开：hash、成本、manifest 绑定
  const proposalsDir = join(reviewsDir(projectDir, RUN), 'proposals');
  const auditFile = readdirSync(proposalsDir).find((n) => n.endsWith('.audit.json'));
  const audit = JSON.parse(readFileSync(join(proposalsDir, auditFile), 'utf8'));
  assert.match(audit.proposal_hash, /^[0-9a-f]{64}$/);
  assert.match(audit.input_manifest_hash, /^[0-9a-f]{64}$/);
  assert.equal(audit.cost_usd, 0.08);
  assert.equal(audit.correction, false);

  // 人批准：复用同一事务入口
  const acc = await acceptRun({ repo, runId: RUN });
  assert.equal(acc.ok, true);

  // 已决 run：review 返回既有决定，不再烧模型
  const again = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.deepEqual({ ok: again.ok, decided: again.already_decided, outcome: again.record.outcome },
    { ok: true, decided: true, outcome: 'accept' });
}));

test('STOPPED run 可 review；人工 abandon 不经 reviewer 直接落决定', () => withTerminalRun(async ({ repo, stub }) => {
  const r = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(r.ok, true, JSON.stringify(r));

  const ab = await abandonRun({ repo, runId: RUN, note: 'direction changed' });
  assert.equal(ab.ok, true);

  const again = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(again.already_decided, true);
  assert.equal(again.record.outcome, 'abandon');
}, { status: 'STOPPED' }));

test('非终态拒绝 review', () => withTerminalRun(async ({ repo, stateDir, stub }) => {
  const { readState } = await import('../scripts/lib/statestore.mjs');
  const cur = readState(stateDir);
  writeState(stateDir, { ...cur.state, status: 'RUNNING' });
  const r = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'not_terminal' });
}));

test('并发：同 run 已有活动 review session 时拒绝', () => withTerminalRun(async ({ repo, projectDir, stub }) => {
  const dir = reviewsDir(projectDir, RUN);
  mkdirSync(dir, { recursive: true });
  assert.equal(acquireRunReviewLock(dir, 'other-session').ok, true);
  try {
    const r = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'review_in_progress' });
  } finally {
    releaseRunReviewLock(dir, 'other-session');
  }
}));

test('纠正路径：带方向重提案最多一次，原 proposal 保留不回写', () => withTerminalRun(async ({ repo, projectDir, stub }) => {
  const first = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(first.ok, true);

  const corrected = await runSuggestionReview({ repo, runId: RUN, direction: '关注公共 API 兼容性而不是测试覆盖', overrideArgv: stub.argv });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.match(corrected.summary, /带方向重提案/);
  assert.doesNotMatch(corrected.summary, /--direction/, '重提案摘要不再提供二次纠正入口');

  // 原 proposal 与纠正 proposal 并存
  const proposalsDir = join(reviewsDir(projectDir, RUN), 'proposals');
  const proposals = readdirSync(proposalsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.audit.json'));
  assert.equal(proposals.length, 2);
  assert.notEqual(first.proposal.proposal_id, corrected.proposal.proposal_id);

  const third = await runSuggestionReview({ repo, runId: RUN, direction: '再来一次', overrideArgv: stub.argv });
  assert.deepEqual({ ok: third.ok, reason: third.reason }, { ok: false, reason: 'correction_exhausted' });
}));

test('reviewer 失败（parse 不了）不产生任何 proposal 或 decision', () => withTerminalRun(async ({ repo, projectDir }) => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-stub-'));
  const path = join(dir, 'stub.sh');
  writeFileSync(path, '#!/bin/bash\necho \'{"result":"not json judgment","session_id":"s"}\'\n', { mode: 0o755 });
  try {
    const r = await runSuggestionReview({ repo, runId: RUN, overrideArgv: ['bash', path] });
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'proposal_parse_failed' });
    assert.equal(existsSync(join(reviewsDir(projectDir, RUN), 'proposals')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));
