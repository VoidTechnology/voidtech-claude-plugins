// Task 5.4：一次批准与 coding Revise 全链路（技术设计 §6，P2-12/P2-13/P2-16）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { runSuggestionReview } from '../scripts/lib/reviewflow.mjs';
import { approveRevision, createRevisionDraft, REVISION_DRAFT_ID, emitYaml } from '../scripts/lib/reviewapproval.mjs';
import { saveDraftVersion } from '../scripts/lib/approvalbundle.mjs';
import { verifyCommittedBundle } from '../scripts/lib/revisionstore.mjs';
import { readCommittedDecision } from '../scripts/lib/decisionstore.mjs';
import { validateSpecText } from '../scripts/lib/validate.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, readState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir, committedDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';

// stub reviewer：revise + 追加一条在 candidate 上会失败的 target（api-check.sh 退出 1 → baseline startable）
function makeReviseStub() {
  const dir = mkdtempSync(join(tmpdir(), 'approve-stub-'));
  const path = join(dir, 'stub.sh');
  const judgment = {
    recommended_outcome: 'revise',
    findings: [
      {
        id: 'missing-api-check', category: 'eval-coverage', severity: 'blocking',
        summary: 'Public API compatibility is not covered by any eval.', evidence_refs: ['diff:src/app.js'],
      },
      {
        id: 'naming-taste', category: 'style', severity: 'info',
        summary: 'Function naming could be clearer; needs human taste.', evidence_refs: ['diff:src/app.js'],
      },
    ],
    agent_review_results: [],
    escalations: [],
    revision: {
      appended_evals: [{ id: 'api-compat-check', role: 'target', command: ['bash', 'api-check.sh'], timeout_seconds: 60 }],
      appended_agent_review: [],
      finding_mapping: { 'missing-api-check': ['api-compat-check'] },
    },
  };
  const envelope = JSON.stringify({
    result: JSON.stringify(judgment), session_id: 'stub-revise-01', total_cost_usd: 0.1, num_turns: 1,
  });
  writeFileSync(path, `#!/bin/bash\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`, { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

async function withReviseScenario(callback) {
  await withDataRoot(async () => {
    const fixture = makeTestRepo({
      prefix: 'approve-',
      files: {
        'src/app.js': 'v1\n',
        // STOPPED 父 run 场景：parent target 在 candidate 上仍未满足 → coding revise 路由 + baseline startable
        'check.sh': { content: '#!/bin/bash\nexit 1\n', mode: 0o755 },
        'api-check.sh': { content: '#!/bin/bash\nexit 1\n', mode: 0o755 },
      },
    });
    const { repo, git } = fixture;
    writeFileSync(join(repo, 'src/app.js'), 'v2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD').stdout.trim();
    const stub = makeReviseStub();
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const evidenceRel = join('evidence', 'iteration-1', 'check-run1.log');
      mkdirSync(join(stateDir, 'evidence', 'iteration-1'), { recursive: true });
      writeFileSync(join(stateDir, evidenceRel), 'ok\n');
      writeState(stateDir, {
        state_version: STATE_VERSION, run_id: RUN, status: 'STOPPED', stop_reason: 'exhausted',
        goal_hash: hex64('a'), base_commit: fixture.sha, last_checkpoint: candidate, candidate_commit: null,
        branch: 'b', worktree: '/tmp/wt', iteration: 1, started_at: '2026-07-16T10:00:00Z',
        spec: {
          schema_version: 1, goal_id: 'payment-tests', task: 'Fix payment tests', base_commit: fixture.sha,
          budgets: { max_iterations: 5, max_duration_seconds: 3600 },
          evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
          protected_paths: [], manual_review: [], out_of_scope: [],
        },
        rounds: [{
          iteration: 1, worker: { exit: 0, timed_out: false }, no_change: false, checkpoint: candidate,
          eval: { passed: false, failed_ids: ['check'], results: [{ id: 'check', role: 'target', pass: false, timed_out: false, runs: [{ exit: 1, timed_out: false, duration_ms: 5, evidence: { path: evidenceRel, total_bytes: 3, sha256: hex64('e'), truncated: false } }] }] },
        }],
        cost: { total_usd: 0, unavailable: true },
      });
      await callback({ repo, projectDir, stateDir, stub, candidate });
    } finally {
      rmSync(stub.dir, { recursive: true, force: true });
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
}

test('全链路：review 产出草稿 → 展示 → 批准 → baseline → 原子冻结 → 只输出启动命令', () => withReviseScenario(async ({ repo, projectDir, stateDir }) => {
  const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: makeReviseStub().argv });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.deepEqual(reviewed.draft, { draft_id: REVISION_DRAFT_ID, draft_version: 1 });
  assert.equal(reviewed.proposal.revision_draft.draft_version, 1);

  // 展示：来源/原始意图/变化摘要/未映射/Execution Plan/不承诺声明，且无 hash
  assert.match(reviewed.summary, /原始意图（task 原文，逐字节保留）：Fix payment tests/);
  assert.match(reviewed.summary, /\+ eval api-compat-check（target）/);
  assert.match(reviewed.summary, /未映射内容（未被任何新检查覆盖/);
  assert.match(reviewed.summary, /naming-taste/);
  assert.match(reviewed.summary, /Execution Plan/);
  assert.match(reviewed.summary, /不能证明模型抽取了你的全部真实意图/);
  assert.doesNotMatch(reviewed.summary, /[0-9a-f]{64}/);

  // 只展示不执行
  const shown = await approveRevision({ repo, runId: RUN });
  assert.equal(shown.displayed, true);
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false);

  // 批准执行：真实 coding baseline（api-compat-check 在 candidate 上失败 → startable）
  const approved = await approveRevision({ repo, runId: RUN, approveExecution: true });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.frozen, true);
  assert.match(approved.start_command, /loop\.mjs goal --spec/);

  // 冻结完整性 + 决策 + 旧 run 执行事实不变
  const verified = verifyCommittedBundle(projectDir, RUN);
  assert.deepEqual({ ok: verified.ok, kind: verified.kind }, { ok: true, kind: 'revision' });
  assert.equal(readCommittedDecision(projectDir, RUN).record.outcome, 'revise');
  assert.equal(readState(stateDir).state.status, 'STOPPED', 'Revise 不修改旧 run 执行事实');

  // 冻结的 YAML 可被完整 parser 复原为同一 goal_hash，且 v2 字段齐全
  const yaml = readFileSync(join(committedDir(projectDir, RUN), 'revision', 'goal-spec.yaml'), 'utf8');
  const parsed = validateSpecText(yaml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.normalized.schema_version, 2);
  assert.equal(parsed.normalized.provenance.parent_run.run_id, RUN);
  assert.equal(parsed.normalized.evals.length, 2);

  // slot 已占：其后 abandon 冲突（STOPPED run 的另一决定入口）
  const { abandonRun } = await import('../scripts/lib/lifecycle.mjs');
  const ab = await abandonRun({ repo, runId: RUN });
  assert.deepEqual({ ok: ab.ok, reason: ab.reason }, { ok: false, reason: 'review_conflict' });
}));

test('语义失败不冻结可重提案；基础设施失败保留草稿精确重试', () => withReviseScenario(async ({ repo, projectDir, stub }) => {
  const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(reviewed.ok, true);

  // 语义失败：不冻结，提示重提案（草稿保留）
  const semantic = await approveRevision({
    repo, runId: RUN, approveExecution: true,
    baselineRunner: async () => ({ verdict: 'all_targets_met', message: '全部 target 已满足' }),
  });
  assert.deepEqual({ ok: semantic.ok, reason: semantic.reason }, { ok: false, reason: 'baseline_semantic_failed' });
  assert.match(semantic.message, /--direction/);
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false);

  // 基础设施失败：可对相同版本精确重试
  const infra = await approveRevision({
    repo, runId: RUN, approveExecution: true,
    baselineRunner: async () => ({ verdict: 'infra_error', message: 'worktree 创建失败' }),
  });
  assert.deepEqual({ ok: infra.ok, retryable: infra.retryable }, { ok: false, retryable: true });

  const retried = await approveRevision({
    repo, runId: RUN, approveExecution: true,
    baselineRunner: async () => ({ verdict: 'startable', message: 'ok' }),
  });
  assert.equal(retried.ok, true, JSON.stringify(retried));
}));

test('P2-13：baseline 期间草稿被替换 → 结果作废不冻结', () => withReviseScenario(async ({ repo, projectDir, stub }) => {
  const reviewed = await runSuggestionReview({ repo, runId: RUN, overrideArgv: stub.argv });
  assert.equal(reviewed.ok, true);

  const raced = await approveRevision({
    repo, runId: RUN, approveExecution: true,
    baselineRunner: async () => {
      const cur = (await import('../scripts/lib/approvalbundle.mjs')).readDraftVersion(projectDir, RUN, REVISION_DRAFT_ID, 1);
      saveDraftVersion(projectDir, RUN, REVISION_DRAFT_ID, {
        parent_run_id: cur.bundle.parent_run_id, proposal_hash: cur.bundle.proposal_hash,
        feedback_pack_hash: cur.bundle.feedback_pack_hash, goal_spec_hash: hex64('9'),
        base_commit: cur.bundle.base_commit, execution_plan_hash: cur.bundle.execution_plan_hash,
        delegation_grant_hash: null, evidence_snapshot_hash: cur.bundle.evidence_snapshot_hash,
        validation_plan_hash: cur.bundle.validation_plan_hash,
      });
      return { verdict: 'startable', message: 'ok' };
    },
  });
  assert.equal(raced.ok, false);
  assert.match(raced.reason, /post_baseline_draft_superseded/);
  assert.equal(readCommittedDecision(projectDir, RUN).exists, false, '结果作废不冻结');
}));

test('机械阻断：空 revision、映射到未知 id 均拒绝组装', () => withReviseScenario(async ({ projectDir, stateDir }) => {
  const state = readState(stateDir).state;
  const proposal = {
    proposal_id: 'p1',
    findings: [{ id: 'f1', summary: 's', evidence_refs: ['diff'] }],
  };
  const empty = createRevisionDraft({
    projectDir, runId: RUN, state, proposal, proposalHash: hex64('1'),
    revisionRequest: { appended_evals: [], appended_agent_review: [], finding_mapping: {} },
    inputManifestHash: hex64('2'),
  });
  assert.equal(empty.reason, 'empty_revision');

  const unknown = createRevisionDraft({
    projectDir, runId: RUN, state, proposal, proposalHash: hex64('1'),
    revisionRequest: {
      appended_evals: [{ id: 'new-check', role: 'target', command: ['true'], timeout_seconds: 30 }],
      finding_mapping: { f1: ['ghost-check'] },
    },
    inputManifestHash: hex64('2'),
  });
  assert.equal(unknown.reason, 'mapping_to_unknown_ids');

  // 试图"修改"既有条目 = 追加同 id → validator id 冲突拒绝（只追加是构造保证）
  const clash = createRevisionDraft({
    projectDir, runId: RUN, state, proposal, proposalHash: hex64('1'),
    revisionRequest: {
      appended_evals: [{ id: 'check', role: 'target', command: ['true'], timeout_seconds: 1 }],
      finding_mapping: { f1: ['check'] },
    },
    inputManifestHash: hex64('2'),
  });
  assert.equal(clash.reason, 'draft_spec_invalid');
}));

test('emitYaml 往返：spec 与嵌套结构经完整 parser 复原同一 canonical 形态', () => {
  const spec = {
    schema_version: 1,
    goal_id: 'payment-tests',
    task: 'Fix tests: with "quotes" and 中文, plus | pipe',
    base_commit: 'a'.repeat(40),
    budgets: { max_iterations: 5 },
    setup: ['npm ci'],
    evals: [
      { id: 't1', role: 'target', command: ['npm', 'test', '--', '1'], timeout_seconds: 60 },
      { id: 't2', role: 'invariant', shell: true, command: 'npm run e2e | tee log', timeout_seconds: 90 },
    ],
    manual_review: ['Check API'],
    out_of_scope: [],
  };
  const yaml = emitYaml(spec);
  const parsed = validateSpecText(yaml);
  assert.equal(parsed.ok, true, `${yaml}\n${JSON.stringify(parsed.errors)}`);
  assert.equal(parsed.normalized.task, spec.task);
  assert.deepEqual(parsed.normalized.evals[0].command, ['npm', 'test', '--', '1']);
  assert.equal(parsed.normalized.evals[1].command, 'npm run e2e | tee log');
});
