// Task 4.4：Review Proposal schema、evidence ref 解析与 Proposal/Decision 物理分离（P2-09）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { validateReviewProposal, persistProposal, readProposal, resolveEvidenceRef } from '../scripts/lib/reviewproposal.mjs';
import { proposalPath, decisionsDir, loadReviewSchema } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';

const MANIFEST = {
  fact_pack_id: 'fact-pack-001',
  base_commit: hex40('1'),
  candidate_commit: hex40('2'),
  diff: { files: [{ path: 'src/api.ts', additions: 3, deletions: 1, binary: false }] },
  evidence: [{ id: 'check-i1-r1' }],
  rounds: [{ iteration: 1 }],
  delegation_grant_hash: null,
};
const INPUT_HASH = hex64('a');
const SPEC_V2 = { agent_review: [{ id: 'api-compat', criterion: 'c', required: true, evidence_scope: ['candidate_diff'] }] };

function coverage() {
  return {
    status: 'complete', changed_files_total: 1, changed_files_inspected: 1,
    evidence_items_total: 1, evidence_items_inspected: 1,
    budget_used_bytes: 1000, budget_limit_bytes: 524288, limitations: [],
  };
}

function makeProposal(overrides = {}) {
  return {
    schema_version: 1,
    proposal_id: 'review-proposal-001',
    review_session_id: 'review-session-123',
    input_manifest_hash: INPUT_HASH,
    delegation_grant_hash: null,
    recommended_outcome: 'revise',
    findings: [{
      id: 'finding-001', category: 'eval-coverage', severity: 'blocking',
      summary: 'Public API compatibility is not covered by any eval.',
      evidence_refs: ['diff:src/api.ts', 'spec'],
    }],
    agent_review_results: [{
      id: 'api-compat', verdict: 'fail',
      evidence_refs: ['evidence:check-i1-r1'],
      rationale: 'One exported symbol was removed.',
    }],
    coverage: coverage(),
    escalations: [{ id: 'esc-001', reason_category: 'missing-context', summary: 'Business intent unclear.' }],
    revision_draft: { draft_id: 'review-draft-1', draft_version: 2 },
    ...overrides,
  };
}

test('合法 proposal 通过完整校验并产出 proposal_hash', () => {
  const r = validateReviewProposal(makeProposal(), { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: SPEC_V2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.proposal_hash, /^[0-9a-f]{64}$/);
});

test('schema 封闭：未知字段、可执行字段注入均拒绝', () => {
  assert.equal(loadReviewSchema('review_proposal').additionalProperties, false);
  for (const injected of [
    { command: 'rm -rf /' },
    { allowed_tools: ['Bash'] },
    { authorization: 'granted' },
  ]) {
    const r = validateReviewProposal(makeProposal(injected), { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: SPEC_V2 });
    assert.equal(r.ok, false, JSON.stringify(injected));
    assert.equal(r.reason, 'schema');
  }
});

test('input manifest / grant hash 绑定：不匹配即拒绝', () => {
  const wrongManifest = validateReviewProposal(makeProposal(), { manifest: MANIFEST, inputManifestHash: hex64('b'), spec: SPEC_V2 });
  assert.equal(wrongManifest.reason, 'manifest_hash_mismatch');

  const claimedGrant = validateReviewProposal(
    makeProposal({ delegation_grant_hash: hex64('c') }),
    { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: SPEC_V2 },
  );
  assert.equal(claimedGrant.reason, 'grant_hash_mismatch', 'proposal 声称有授权不产生权限（§8.3）');
});

test('evidence ref 必须解析到 Fact Pack；repo: 需要 snapshot tracked 集', () => {
  const cases = [
    ['diff:src/api.ts', true], ['spec', true], ['diff', true],
    ['evidence:check-i1-r1', true], ['round:1', true],
    ['diff:not/changed.ts', false], ['evidence:ghost', false], ['round:9', false],
    ['file:///etc/passwd', false], ['repo:src/api.ts', false],
  ];
  for (const [ref, ok] of cases) {
    assert.equal(resolveEvidenceRef(ref, MANIFEST).ok, ok, ref);
  }
  assert.equal(resolveEvidenceRef('repo:src/api.ts', MANIFEST, new Set(['src/api.ts'])).ok, true);

  const bad = validateReviewProposal(
    makeProposal({ findings: [{ id: 'f', category: 'x', severity: 'blocking', summary: 's', evidence_refs: ['evidence:ghost'] }] }),
    { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: SPEC_V2 },
  );
  assert.equal(bad.reason, 'unresolvable_evidence_refs');
});

test('agent_review_results 只能对应 spec 声明的 agent_review；v1 spec 必须为空', () => {
  const undeclared = validateReviewProposal(
    makeProposal({ agent_review_results: [{ id: 'invented-check', verdict: 'pass', evidence_refs: ['spec'], rationale: 'r' }] }),
    { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: SPEC_V2 },
  );
  assert.equal(undeclared.reason, 'undeclared_agent_review');

  const v1 = validateReviewProposal(makeProposal(), { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: {} });
  assert.equal(v1.reason, 'undeclared_agent_review');

  const v1Empty = validateReviewProposal(
    makeProposal({ agent_review_results: [] }),
    { manifest: MANIFEST, inputManifestHash: INPUT_HASH, spec: {} },
  );
  assert.equal(v1Empty.ok, true);
});

test('持久化与物理分离：proposal 落 reviews/，不进 decisions/，且不可覆盖', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'proposal-'));
  try {
    const proposal = makeProposal();
    const saved = persistProposal(projectDir, RUN, proposal);
    assert.equal(saved.ok, true);
    assert.ok(saved.path.includes(`${sep}reviews${sep}`));
    assert.ok(!saved.path.startsWith(decisionsDir(projectDir, RUN)));
    assert.equal(proposalPath(projectDir, RUN, proposal.proposal_id), saved.path);

    assert.equal(persistProposal(projectDir, RUN, proposal).reason, 'proposal_exists');

    const read = readProposal(projectDir, RUN, proposal.proposal_id);
    assert.equal(read.ok, true);
    assert.equal(read.proposal_hash, saved.proposal_hash);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
