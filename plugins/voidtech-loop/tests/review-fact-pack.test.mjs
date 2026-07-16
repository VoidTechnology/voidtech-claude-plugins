// Task 4.1：Review Fact Pack manifest 构建、hash 绑定与 fail closed（技术设计 §7.1）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { buildReviewFactPack, persistFactPack, readFactPack, computeInputManifestHash } from '../scripts/lib/reviewfactpack.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// 真实 repo：base commit + candidate commit（一处文本改动 + 一个新文件）
function makeRepoWithCandidate() {
  const fixture = makeTestRepo({ prefix: 'factpack-', files: { 'src/app.js': 'console.log(1)\n', 'README.md': 'hello\n' } });
  const { repo, git } = fixture;
  writeFileSync(join(repo, 'src/app.js'), 'console.log(2)\n');
  writeFileSync(join(repo, 'src/new.js'), 'export const x = 1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD').stdout.trim();
  return { repo, base: fixture.sha, candidate, git };
}

async function withSeededTerminalRun(callback, { evidenceContent = 'eval output\n', mutateState = null } = {}) {
  await withDataRoot(async () => {
    const { repo, base, candidate } = makeRepoWithCandidate();
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const evidenceRel = join('evidence', 'iteration-1', 'check-run1.log');
      mkdirSync(join(stateDir, 'evidence', 'iteration-1'), { recursive: true });
      writeFileSync(join(stateDir, evidenceRel), evidenceContent);

      const state = {
        state_version: STATE_VERSION,
        run_id: RUN,
        status: 'EVALS_PASSED',
        goal_hash: hex64('a'),
        base_commit: base,
        last_checkpoint: candidate,
        candidate_commit: candidate,
        branch: 'loop/payment-tests',
        worktree: '/tmp/wt',
        iteration: 1,
        started_at: '2026-07-16T10:00:00Z',
        updated_at: '2026-07-16T10:30:00Z',
        spec: {
          schema_version: 1, goal_id: 'payment-tests', task: 'fix', base_commit: base,
          budgets: { max_iterations: 5, max_duration_seconds: 3600 },
          evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
          protected_paths: [], manual_review: [], out_of_scope: [],
        },
        rounds: [{
          iteration: 1,
          worker: { exit: 0, timed_out: false },
          no_change: false,
          checkpoint: candidate,
          eval: {
            passed: true, failed_ids: [],
            results: [{
              id: 'check', role: 'target', pass: true, timed_out: false,
              runs: [{ exit: 0, timed_out: false, duration_ms: 100, evidence: { path: evidenceRel, total_bytes: 999, sha256: hex64('e'), truncated: true } }],
            }],
          },
        }],
        cost: { total_usd: 0, unavailable: true },
      };
      if (mutateState) mutateState(state);
      writeState(stateDir, state);
      await callback({ repo, projectDir, stateDir, base, candidate, evidenceRel, evidenceContent });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('manifest 完整索引：spec/diff/rounds/evidence 均有 locator+bytes+hash，且绑定 state/goal/candidate', () => withSeededTerminalRun(async ({ repo, projectDir, base, candidate, evidenceRel, evidenceContent }) => {
  const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.equal(built.ok, true, JSON.stringify(built));
  const m = built.manifest;

  assert.equal(m.base_commit, base);
  assert.equal(m.candidate_commit, candidate);
  assert.equal(m.goal_hash, hex64('a'));
  assert.match(m.state_checksum, /^[0-9a-f]{64}$/);

  // diff：两个改动文件；正文不入 manifest，只有 bytes+hash
  assert.deepEqual(m.diff.files.map((f) => f.path).sort(), ['src/app.js', 'src/new.js']);
  assert.ok(m.diff.total_bytes > 0);
  assert.equal(m.diff.sha256, sha256(built.diff_text));

  // evidence：磁盘文件与原始流双元数据
  assert.equal(m.evidence.length, 1);
  assert.equal(m.evidence[0].locator, evidenceRel);
  assert.equal(m.evidence[0].file_sha256, sha256(evidenceContent));
  assert.equal(m.evidence[0].stream_total_bytes, 999);
  assert.equal(m.evidence[0].truncated, true);

  // terminal state projection：round 明细不进投影
  assert.equal(m.terminal_state.status, 'EVALS_PASSED');
  assert.equal(m.terminal_state.rounds_total, 1);
  assert.equal(m.terminal_state.evidence_total, 1);
  assert.equal('rounds' in m.terminal_state, false);

  // rounds 摘要
  assert.deepEqual(m.rounds[0], {
    iteration: 1, locator: 'round-1', no_change: false,
    checkpoint: candidate, eval_passed: true, failed_ids: [],
  });
}));

test('input_manifest_hash = canonical manifest SHA-256；持久化后读回一致', () => withSeededTerminalRun(async ({ repo, projectDir }) => {
  const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.equal(built.input_manifest_hash, computeInputManifestHash(built.manifest));

  persistFactPack(projectDir, RUN, built.manifest);
  const read = readFactPack(projectDir, RUN, built.manifest.fact_pack_id);
  assert.equal(read.ok, true);
  assert.equal(read.input_manifest_hash, built.input_manifest_hash);

  // snapshot 绑定改变 manifest → hash 变化（proposal 引用绑定后的值）
  const bound = { ...built.manifest, snapshot: { snapshot_id: 'snapshot-001', tracked_files_manifest_hash: hex64('f') } };
  assert.notEqual(computeInputManifestHash(bound), built.input_manifest_hash);
}));

test('fail closed：evidence 文件缺失时不产出 pack，报告缺失来源', () => withSeededTerminalRun(async ({ repo, projectDir, stateDir, evidenceRel }) => {
  rmSync(join(stateDir, evidenceRel));
  const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.deepEqual({ ok: built.ok, reason: built.reason }, { ok: false, reason: 'evidence_missing' });
  assert.equal(built.missing[0].source, 'evidence');
}));

test('fail closed：state 损坏与非终态均拒绝', () => withSeededTerminalRun(async ({ repo, projectDir, stateDir }) => {
  // 非终态
  const running = buildReviewFactPack({ repo, projectDir, runId: 'no-such-run' });
  assert.equal(running.ok, false);

  writeFileSync(join(stateDir, 'state.json'), '{"broken":');
  const corrupt = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.deepEqual({ ok: corrupt.ok, reason: corrupt.reason }, { ok: false, reason: 'state_unreadable' });
}), { });

test('非终态 run 拒绝构建', () => withSeededTerminalRun(async ({ repo, projectDir }) => {
  const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.deepEqual({ ok: built.ok, reason: built.reason, status: built.status },
    { ok: false, reason: 'not_terminal', status: 'RUNNING' });
}, { mutateState: (s) => { s.status = 'RUNNING'; } }));

test('STOPPED run 以最后 checkpoint 为 candidate 构建', () => withSeededTerminalRun(async ({ repo, projectDir, candidate }) => {
  const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.manifest.candidate_commit, candidate);
  assert.equal(built.manifest.terminal_state.status, 'STOPPED');
  assert.equal(built.manifest.terminal_state.stop_reason, 'exhausted');
}, { mutateState: (s) => { s.status = 'STOPPED'; s.stop_reason = 'exhausted'; s.candidate_commit = null; } }));
