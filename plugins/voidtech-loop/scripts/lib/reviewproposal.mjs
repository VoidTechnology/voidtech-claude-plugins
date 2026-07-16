// Review Proposal 校验与持久化（二期技术设计 §8.2，Task 4.4，P2-09）。
// proposal 是 agent 判断而非决定：与 Decision Record 物理分离（reviews/ vs decisions/），
// 不含可执行命令/路径写入/权限字段（schema 层封闭），evidence ref 必须解析到冻结 Fact Pack。
// ref 语法（封闭集合）：spec | diff | diff:<path> | evidence:<id> | round:<iteration> | repo:<path>。

import { existsSync, readFileSync } from 'node:fs';
import { proposalPath, validateReviewArtifact, artifactHash } from './reviewstore.mjs';
import { atomicWrite } from './statestore.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function resolveEvidenceRef(ref, manifest, trackedSet = null) {
  if (ref === 'spec' || ref === 'diff') return { ok: true, kind: ref };
  if (ref.startsWith('diff:')) {
    const path = ref.slice('diff:'.length);
    return manifest.diff.files.some((f) => f.path === path)
      ? { ok: true, kind: 'diff_file', path }
      : { ok: false, reason: 'unknown_diff_path', ref };
  }
  if (ref.startsWith('evidence:')) {
    const id = ref.slice('evidence:'.length);
    return manifest.evidence.some((e) => e.id === id)
      ? { ok: true, kind: 'evidence', id }
      : { ok: false, reason: 'unknown_evidence_id', ref };
  }
  if (ref.startsWith('round:')) {
    const iteration = Number(ref.slice('round:'.length));
    return manifest.rounds.some((r) => r.iteration === iteration)
      ? { ok: true, kind: 'round', iteration }
      : { ok: false, reason: 'unknown_round', ref };
  }
  if (ref.startsWith('repo:')) {
    const path = ref.slice('repo:'.length);
    if (trackedSet && trackedSet.has(path)) return { ok: true, kind: 'repo', path };
    return { ok: false, reason: trackedSet ? 'not_in_snapshot' : 'snapshot_unavailable', ref };
  }
  return { ok: false, reason: 'unknown_ref_scheme', ref };
}

// 完整校验：schema → input manifest 绑定 → grant hash 绑定 → 全部 evidence ref 可解析 →
// agent_review_results 的 id 必须来自 spec 声明的 agent_review（v1 spec 无该字段则必须为空）。
export function validateReviewProposal(proposal, { manifest, inputManifestHash, spec, trackedSet = null }) {
  const schema = validateReviewArtifact('review_proposal', proposal);
  if (!schema.ok) return { ok: false, reason: 'schema', errors: schema.errors };

  if (proposal.input_manifest_hash !== inputManifestHash) {
    return { ok: false, reason: 'manifest_hash_mismatch' };
  }
  if (proposal.delegation_grant_hash !== manifest.delegation_grant_hash) {
    return { ok: false, reason: 'grant_hash_mismatch' };
  }

  const badRefs = [];
  const collectRefs = (items) => items.flatMap((item) => item.evidence_refs.map((ref) => ({ owner: item.id, ref })));
  for (const { owner, ref } of [...collectRefs(proposal.findings), ...collectRefs(proposal.agent_review_results)]) {
    const resolved = resolveEvidenceRef(ref, manifest, trackedSet);
    if (!resolved.ok) badRefs.push({ owner, ref, reason: resolved.reason });
  }
  if (badRefs.length > 0) return { ok: false, reason: 'unresolvable_evidence_refs', refs: badRefs };

  const declared = new Set((spec?.agent_review ?? []).map((a) => a.id));
  const undeclared = proposal.agent_review_results.filter((r) => !declared.has(r.id)).map((r) => r.id);
  if (undeclared.length > 0) {
    return { ok: false, reason: 'undeclared_agent_review', ids: undeclared };
  }

  return { ok: true, proposal_hash: artifactHash(proposal) };
}

export function persistProposal(projectDir, runId, proposal) {
  const path = proposalPath(projectDir, runId, proposal.proposal_id);
  if (existsSync(path)) return { ok: false, reason: 'proposal_exists' };
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(proposal, null, 2));
  return { ok: true, path, proposal_hash: artifactHash(proposal) };
}

export function readProposal(projectDir, runId, proposalId) {
  const path = proposalPath(projectDir, runId, proposalId);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let proposal;
  try {
    proposal = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const schema = validateReviewArtifact('review_proposal', proposal);
  if (!schema.ok) return { ok: false, reason: 'invalid', errors: schema.errors };
  return { ok: true, proposal, proposal_hash: artifactHash(proposal) };
}
