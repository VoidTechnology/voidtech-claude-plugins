// Task 5.5：verification-only Revise 三分流（技术设计 §6.1/§3.8，P2-18~P2-22）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { runSuggestionReview } from '../scripts/lib/reviewflow.mjs';
import { approveRevision, loadVerifiedDraft } from '../scripts/lib/reviewapproval.mjs';
import { verifyCommittedBundle, listVerificationAttempts } from '../scripts/lib/revisionstore.mjs';
import { readCommittedDecision } from '../scripts/lib/decisionstore.mjs';
import { acceptRun } from '../scripts/lib/lifecycle.mjs';
import { validateSpecText } from '../scripts/lib/validate.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, readState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir, committedDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';

function makeStub(verifyCommand) {
  const dir = mkdtempSync(join(tmpdir(), 'supp-stub-'));
  const path = join(dir, 'stub.sh');
  const judgment = {
    recommended_outcome: 'revise',
    findings: [{
      id: 'missing-verify', category: 'eval-coverage', severity: 'blocking',
      summary: 'Behavior not verified.', evidence_refs: ['diff:src/app.js'],
    }],
    agent_review_results: [],
    escalations: [],
    revision: {
      appended_evals: [{ id: 'extra-verify', role: 'target', command: verifyCommand, timeout_seconds: 60 }],
      appended_agent_review: [],
      finding_mapping: { 'missing-verify': ['extra-verify'] },
    },
  };
  const envelope = JSON.stringify({ result: JSON.stringify(judgment), session_id: 'stub-supp-01', total_cost_usd: 0.1, num_turns: 1 });
  writeFileSync(path, `#!/bin/bash\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`, { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

// EVALS_PASSED 父 run：parent target 在 candidate 上已通过
async function withPassedRun(callback, { manualReview = [] } = {}) {
  await withDataRoot(async () => {
    const fixture = makeTestRepo({
      prefix: 'supp-',
      files: {
        'src/app.js': 'v1\n',
        'check.sh': { content: '#!/bin/bash\ntrue\n', mode: 0o755 },
        'verify-pass.sh': { content: '#!/bin/bash\ntrue\n', mode: 0o755 },
        'verify-fail.sh': { content: '#!/bin/bash\nexit 1\n', mode: 0o755 },
      },
    });
    const { repo, git } = fixture;
    writeFileSync(join(repo, 'src/app.js'), 'v2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD').stdout.trim();
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const evidenceRel = join('evidence', 'iteration-1', 'check-run1.log');
      mkdirSync(join(stateDir, 'evidence', 'iteration-1'), { recursive: true });
      writeFileSync(join(stateDir, evidenceRel), 'ok\n');
      writeState(stateDir, {
        state_version: STATE_VERSION, run_id: RUN, status: 'EVALS_PASSED',
        goal_hash: hex64('a'), base_commit: fixture.sha, last_checkpoint: candidate, candidate_commit: candidate,
        branch: 'b', worktree: '/tmp/wt', iteration: 1, started_at: '2026-07-16T10:00:00Z',
        spec: {
          schema_version: 1, goal_id: 'payment-tests', task: 'Fix payment tests', base_commit: fixture.sha,
          budgets: { max_iterations: 5, max_duration_seconds: 3600 },
          evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
          protected_paths: [], manual_review: manualReview, out_of_scope: [],
        },
        rounds: [{
          iteration: 1, worker: { exit: 0, timed_out: false }, no_change: false, checkpoint: candidate,
          eval: { passed: true, failed_ids: [], results: [{ id: 'check', role: 'target', pass: true, timed_out: false, runs: [{ exit: 0, timed_out: false, duration_ms: 5, evidence: { path: evidenceRel, total_bytes: 3, sha256: hex64('e'), truncated: false } }] }] },
        }],
        cost: { total_usd: 0, unavailable: true },
      });
      await callback({ repo, projectDir, stateDir, candidate });
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
}

test('P2-18/P2-22：补充验证通过 → 接受原 run，不创建新 run、无启动命令，双 hash 追溯', () => withPassedRun(async ({ repo, projectDir, stateDir, candidate }) => {
  const stub = makeStub(['bash', 'verify-pass.sh']);
  try {
    const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));

    // 路由：EVALS_PASSED + 仅追加 eval → supplemental_verification
    assert.equal(loadVerifiedDraft(projectDir, RUN).validation_kind, 'supplemental_verification');

    const approved = await approveRevision({ repo, runId: RUN, approveExecution: true });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.outcome, 'verification_passed');
    assert.equal('start_command' in approved, false, '不生成启动命令');

    // 原 run 已接受；无新 run（runs/ 下仍只有一个 run 目录）
    assert.equal(readState(stateDir).state.status, 'ACCEPTED');
    assert.deepEqual(readdirSync(join(projectDir, 'runs')), [RUN]);

    // Supplemental Accept Bundle 完整且双 hash 可追溯
    const verified = verifyCommittedBundle(projectDir, RUN);
    assert.deepEqual({ ok: verified.ok, kind: verified.kind }, { ok: true, kind: 'supplemental_verification' });
    const record = readCommittedDecision(projectDir, RUN).record;
    assert.equal(record.outcome, 'accept');
    assert.equal(record.basis.original_goal_hash, hex64('a'));
    assert.equal(record.basis.supplemental_verification.commit, candidate);
    assert.equal(record.basis.supplemental_verification.result, 'passed');

    // 冻结的补充 v2 spec 可复原且不替换旧 spec（P2-19 语义隔离：同一事实两种解释）
    const yaml = readFileSync(join(committedDir(projectDir, RUN), 'supplemental-verification', 'goal-spec.yaml'), 'utf8');
    const parsed = validateSpecText(yaml);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.goal_hash, record.basis.supplemental_verification.goal_hash);
    assert.equal(readState(stateDir).state.goal_hash, hex64('a'), '旧 run 冻结 spec 未被替换');

    // 报告呈现双 hash 追溯
    const report = readFileSync(join(stateDir, 'report.md'), 'utf8');
    assert.match(report, /补充验证/);
    assert.match(report, /旧 Goal Spec 未被修改/);

    // 其后人工 accept：幂等返回既有决定
    const acc = await acceptRun({ repo, runId: RUN });
    assert.deepEqual({ ok: acc.ok, already: acc.already }, { ok: true, already: true });
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }
}));

test('P2-20/P2-21：补充验证失败 → correction 草稿（coding、失败为 target），Accept 被阻断，批准后走完整 baseline', () => withPassedRun(async ({ repo, projectDir }) => {
  const stub = makeStub(['bash', 'verify-fail.sh']);
  try {
    const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
    assert.equal(reviewed.ok, true);

    const failed = await approveRevision({ repo, runId: RUN, approveExecution: true });
    assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: 'correction_required' });
    assert.deepEqual(failed.failed_ids, ['extra-verify']);
    assert.equal(failed.correction_draft.draft_version, 2);
    assert.equal(readCommittedDecision(projectDir, RUN).exists, false, '失败不占 decision slot');

    // attempt append-only 记录
    const attempts = listVerificationAttempts(projectDir, RUN, 'verification-v1');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].result, 'correction_required');

    // P2-21：普通 Accept 被阻断
    const blocked = await acceptRun({ repo, runId: RUN });
    assert.deepEqual({ ok: blocked.ok, reason: blocked.reason }, { ok: false, reason: 'supplemental_verification_blocking' });

    // correction 草稿：kind coding、失败检查为 target（不自动提升 invariant，P2-20）
    const correction = loadVerifiedDraft(projectDir, RUN);
    assert.equal(correction.validation_kind, 'coding_baseline');
    const extra = correction.normalized.evals.find((e) => e.id === 'extra-verify');
    assert.equal(extra.role, 'target');

    // 批准 correction：coding baseline（parent 满足、correction target 未满足 → startable）→ 冻结 + 启动命令
    const approved = await approveRevision({ repo, runId: RUN, approveExecution: true });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.frozen, true);
    assert.match(approved.start_command, /goal --spec/);
    assert.equal(verifyCommittedBundle(projectDir, RUN).kind, 'revision');
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }
}));

test('P2-21：inconclusive 不 Accept、不输出 start，完全相同 bundle 可精确重试', () => withPassedRun(async ({ repo, projectDir }) => {
  const stub = makeStub(['bash', 'verify-pass.sh']);
  try {
    const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
    assert.equal(reviewed.ok, true);

    // 注入超时形态的 evalRunner → inconclusive
    const inconclusive = await approveRevision({
      repo, runId: RUN, approveExecution: true,
      evalRunner: async () => ({ passed: false, results: [{ id: 'extra-verify', role: 'target', pass: false, timed_out: true, runs: [] }] }),
    });
    assert.deepEqual(
      { ok: inconclusive.ok, reason: inconclusive.reason, retryable: inconclusive.retryable },
      { ok: false, reason: 'verification_inconclusive', retryable: true },
    );
    assert.equal(readCommittedDecision(projectDir, RUN).exists, false);
    assert.equal(listVerificationAttempts(projectDir, RUN, 'verification-v1')[0].result, 'inconclusive');

    // Accept 被阻断
    const blocked = await acceptRun({ repo, runId: RUN });
    assert.equal(blocked.reason, 'supplemental_verification_blocking');

    // 完全相同 bundle 精确重试（真实执行，verify-pass 通过）→ verification_passed
    const retried = await approveRevision({ repo, runId: RUN, approveExecution: true });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.outcome, 'verification_passed');
    // passed 结果进入 Supplemental Accept Bundle，不追加 attempt（§3.8：仅失败/不确定 append-only 记录）
    assert.equal(listVerificationAttempts(projectDir, RUN, 'verification-v1').length, 1);
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }
}));

test('manual review 不被补充验证绕过：缺确认时拒绝，补确认后通过', () => withPassedRun(async ({ repo }) => {
  const stub = makeStub(['bash', 'verify-pass.sh']);
  try {
    const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
    assert.equal(reviewed.ok, true);

    const denied = await approveRevision({ repo, runId: RUN, approveExecution: true });
    assert.deepEqual({ ok: denied.ok, reason: denied.reason }, { ok: false, reason: 'manual_review_incomplete' });

    const approved = await approveRevision({
      repo, runId: RUN, approveExecution: true,
      manualReviewResults: [{ item: 'Confirm API compatibility', passed: true }],
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.decision.manual_review_results[0].passed_by.kind, 'local_user');
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }
}, { manualReview: ['Confirm API compatibility'] }));
