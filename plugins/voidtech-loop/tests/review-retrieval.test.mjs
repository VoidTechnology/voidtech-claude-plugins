// Task 4.3：controller retrieval 工具面、预算计账与 coverage（技术设计 §7.5，P2-27）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDataRoot, makeTestRepo } from './helpers.mjs';
import { createReviewSnapshot, destroyReviewSnapshot } from '../scripts/lib/reviewsnapshot.mjs';
import { buildReviewFactPack } from '../scripts/lib/reviewfactpack.mjs';
import { createRetrievalSession, SINGLE_READ_CAP } from '../scripts/lib/reviewretrieval.mjs';
import { gitCommonDir } from '../scripts/lib/gitops.mjs';
import { projectDataDir, writeState, STATE_VERSION } from '../scripts/lib/statestore.mjs';
import { runDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';

async function withSession(callback, { budgetLimit = undefined, evidenceContent = 'line1\nline2\nfailed assertion here\n' } = {}) {
  await withDataRoot(async () => {
    const fixture = makeTestRepo({
      prefix: 'retrieval-',
      files: { 'src/app.js': 'const value = 1\n', 'bin/blob.bin': 'x\0y\0z' },
    });
    const { repo, git } = fixture;
    writeFileSync(join(repo, 'src/app.js'), 'const value = 2\nconst extra = true\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD').stdout.trim();

    let snapshot = null;
    try {
      const projectDir = projectDataDir(gitCommonDir(repo));
      const stateDir = runDir(projectDir, RUN);
      const evidenceRel = join('evidence', 'iteration-1', 'check-run1.log');
      mkdirSync(join(stateDir, 'evidence', 'iteration-1'), { recursive: true });
      writeFileSync(join(stateDir, evidenceRel), evidenceContent);

      const spec = {
        schema_version: 1, goal_id: 'g', task: 't', base_commit: fixture.sha,
        budgets: { max_iterations: 5, max_duration_seconds: 3600 },
        evals: [{ id: 'check', role: 'target', command: ['bash', 'c.sh'], shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1 }],
        protected_paths: [], manual_review: [], out_of_scope: [],
      };
      writeState(stateDir, {
        state_version: STATE_VERSION, run_id: RUN, status: 'EVALS_PASSED',
        goal_hash: hex64('a'), base_commit: fixture.sha, last_checkpoint: candidate, candidate_commit: candidate,
        branch: 'b', worktree: '/tmp/wt', iteration: 1, started_at: '2026-07-16T10:00:00Z',
        spec,
        rounds: [{
          iteration: 1, worker: { exit: 0, timed_out: false }, no_change: false, checkpoint: candidate,
          eval: { passed: true, failed_ids: [], results: [{ id: 'check', role: 'target', pass: true, timed_out: false, runs: [{ exit: 0, timed_out: false, duration_ms: 5, evidence: { path: evidenceRel, total_bytes: 99, sha256: hex64('e'), truncated: false } }] }] },
        }],
        cost: { total_usd: 0, unavailable: true },
      });

      const built = buildReviewFactPack({ repo, projectDir, runId: RUN });
      assert.equal(built.ok, true, JSON.stringify(built));
      const created = createReviewSnapshot(repo, candidate);
      snapshot = created.snapshot;

      const tools = createRetrievalSession({
        snapshot, manifest: built.manifest, diffText: built.diff_text,
        projectDir, runId: RUN, spec,
        ...(budgetLimit !== undefined ? { budgetLimit } : {}),
      });
      await callback({ tools, manifest: built.manifest, diffText: built.diff_text, projectDir, stateDir, evidenceRel, repo });
    } finally {
      if (snapshot) destroyReviewSnapshot(snapshot);
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('readFile：内容来自冻结 snapshot，带来源 hash 与截断信息', () => withSession(async ({ tools }) => {
  const r = tools.readFile('src/app.js');
  assert.equal(r.ok, true);
  assert.match(r.content, /const value = 2/);
  assert.equal(r.truncated, false);
  assert.match(r.source.blob_sha256, /^[0-9a-f]{64}$/);

  // 单次读取上限收敛
  const capped = tools.readFile('src/app.js', { limit: SINGLE_READ_CAP * 10 });
  assert.equal(capped.ok, true);
}));

test('二进制拒绝并进入 binary limitation；路径校验走 snapshot 唯一入口', () => withSession(async ({ tools }) => {
  const bin = tools.readFile('bin/blob.bin');
  assert.deepEqual({ ok: bin.ok, reason: bin.reason }, { ok: false, reason: 'binary_limited' });
  assert.equal(tools.readFile('../outside').reason, 'path_traversal');
  assert.equal(tools.readFile('.git/config').reason, 'path_traversal');
  assert.ok(tools.coverage().limitations.includes('binary_limited'));
}));

test('getDiff 只接受 manifest 记录的 base/candidate 对', () => withSession(async ({ tools, manifest }) => {
  const wrong = tools.getDiff(hex64('9').slice(0, 40), manifest.candidate_commit);
  assert.equal(wrong.reason, 'diff_pair_not_in_manifest');

  const right = tools.getDiff(manifest.base_commit, manifest.candidate_commit);
  assert.equal(right.ok, true);
  assert.match(right.content, /const value = 2/);
  assert.equal(right.source.sha256, manifest.diff.sha256);
}));

test('evidence 只按 ID 读取；文件被篡改时 source_limited', () => withSession(async ({ tools, manifest, stateDir, evidenceRel }) => {
  const id = manifest.evidence[0].id;
  const good = tools.readEvidence(id);
  assert.equal(good.ok, true);
  assert.match(good.content, /failed assertion/);

  assert.equal(tools.readEvidence('made-up-id').reason, 'unknown_evidence_id');

  writeFileSync(join(stateDir, evidenceRel), 'TAMPERED\n');
  const tampered = tools.readEvidence(id);
  assert.deepEqual({ ok: tampered.ok, reason: tampered.reason }, { ok: false, reason: 'source_limited' });
  assert.equal(tools.coverage().status, 'source_limited');
}));

test('session 累计预算：超限返回 budget_limited，不静默截断', () => withSession(async ({ tools }) => {
  const first = tools.readFile('src/app.js');
  assert.equal(first.ok, true);
  const second = tools.readFile('src/app.js');
  assert.deepEqual({ ok: second.ok, reason: second.reason }, { ok: false, reason: 'budget_limited' });
  const cov = tools.coverage();
  assert.equal(cov.status, 'budget_limited');
  assert.ok(cov.budget_used_bytes <= cov.budget_limit_bytes);
}, { budgetLimit: 48 }));

test('searchText 限制与 coverage complete 判定', () => withSession(async ({ tools, manifest }) => {
  const found = tools.searchText('const value');
  assert.equal(found.ok, true);
  assert.equal(found.matches[0].path, 'src/app.js');

  const spec = tools.getSpec();
  assert.equal(spec.ok, true);
  assert.match(spec.content, /"goal_id":"g"/);
  assert.equal(spec.source.sha256, manifest.spec.sha256);

  // 覆盖全部 changed files（经 diff）与全部 evidence 后 coverage 才为 complete……
  tools.getDiff(manifest.base_commit, manifest.candidate_commit);
  tools.readEvidence(manifest.evidence[0].id);
  const cov = tools.coverage();
  // 本仓库 diff 无 binary 变化时应为 complete
  assert.equal(cov.status, 'complete', JSON.stringify(cov));
  assert.equal(cov.changed_files_inspected, cov.changed_files_total);
  assert.equal(cov.evidence_items_inspected, cov.evidence_items_total);
}));
