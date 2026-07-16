// Approval Bundle 与版本化 conditional hash match（二期技术设计 §3.6，Task 1.5，P2-13）。
// 用户操作稳定的 draft_id 与递增 draft_version，批准"当前展示版本"；系统内部把批准绑定到
// 完整 approval_bundle_hash（Pack、Spec、base、Execution Plan、可选 Delegation Grant、
// evidence 快照与验证计划）。任一内容变化生成新版本并使旧批准失效；批准记录不保存 allow_shell。

import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './statestore.mjs';
import { draftDir, validateReviewArtifact, computeApprovalBundleHash } from './reviewstore.mjs';

// 除版本身份（draft_id/draft_version）与派生哈希外的内容字段：变化即需要新版本
const CONTENT_FIELDS = [
  'parent_run_id', 'proposal_hash', 'feedback_pack_hash', 'goal_spec_hash', 'base_commit',
  'execution_plan_hash', 'delegation_grant_hash', 'evidence_snapshot_hash', 'validation_plan_hash',
];

function bundlePath(dir, version) {
  return join(dir, `bundle-v${version}.json`);
}

function approvalPath(dir, version) {
  return join(dir, `approval-v${version}.json`);
}

export function buildApprovalBundle({ draftId, draftVersion, ...content }) {
  const bundle = {
    schema_version: 1,
    draft_id: draftId,
    draft_version: draftVersion,
    ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, content[f]])),
  };
  bundle.approval_bundle_hash = computeApprovalBundleHash(bundle);
  const validation = validateReviewArtifact('approval_bundle', bundle);
  if (!validation.ok) return { ok: false, reason: 'invalid_bundle', errors: validation.errors };
  return { ok: true, bundle };
}

export function latestDraftVersion(projectDir, runId, draftId) {
  const dir = draftDir(projectDir, runId, draftId);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .map((name) => /^bundle-v(\d+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .reduce((max, v) => Math.max(max, Number(v)), 0);
}

export function readDraftVersion(projectDir, runId, draftId, version) {
  const path = bundlePath(draftDir(projectDir, runId, draftId), version);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const validation = validateReviewArtifact('approval_bundle', bundle);
  if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
  // 落盘内容与自带哈希必须自洽，否则视为被篡改
  if (computeApprovalBundleHash(bundle) !== bundle.approval_bundle_hash) {
    return { ok: false, reason: 'bundle_tampered' };
  }
  return { ok: true, bundle };
}

// 保存草稿：内容与最新版本一致时幂等返回（不虚增版本）；任一内容字段变化则递增 draft_version。
export function saveDraftVersion(projectDir, runId, draftId, content) {
  const dir = draftDir(projectDir, runId, draftId);
  const latest = latestDraftVersion(projectDir, runId, draftId);
  if (latest > 0) {
    const current = readDraftVersion(projectDir, runId, draftId, latest);
    if (current.ok && CONTENT_FIELDS.every((f) => current.bundle[f] === content[f])) {
      return { ok: true, bundle: current.bundle, unchanged: true };
    }
  }
  const built = buildApprovalBundle({ draftId, draftVersion: latest + 1, ...content });
  if (!built.ok) return built;
  mkdirSync(dir, { recursive: true });
  atomicWrite(bundlePath(dir, built.bundle.draft_version), JSON.stringify(built.bundle, null, 2));
  return { ok: true, bundle: built.bundle, unchanged: false };
}

// 人批准"当前展示版本"：界面不要求阅读 hash，记录里保存精确 approval_bundle_hash 与 actor。
export function recordApproval(projectDir, runId, draftId, version, { approveExecution = true } = {}) {
  const read = readDraftVersion(projectDir, runId, draftId, version);
  if (!read.ok) return { ok: false, reason: `draft_${read.reason}` };
  const approval = {
    schema_version: 1,
    draft_id: draftId,
    draft_version: version,
    approval_bundle_hash: read.bundle.approval_bundle_hash,
    approved_at: new Date().toISOString(),
    approved_by: { kind: 'local_user', claimed_id: null, identity_verified: false },
    approve_execution: approveExecution === true,
  };
  atomicWrite(approvalPath(draftDir(projectDir, runId, draftId), version), JSON.stringify(approval, null, 2));
  return { ok: true, approval, bundle: read.bundle };
}

export function readApproval(projectDir, runId, draftId, version) {
  const path = approvalPath(draftDir(projectDir, runId, draftId), version);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, approval: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

// conditional hash match（P2-13）：validation 前与冻结前都重算并匹配。
// 检出三类失效：草稿被篡改（哈希不自洽）、批准指向旧哈希、草稿已有更新版本（旧批准作废）。
export function verifyApprovedBundle(projectDir, runId, draftId, approval) {
  const latest = latestDraftVersion(projectDir, runId, draftId);
  if (latest > approval.draft_version) {
    return { ok: false, reason: 'draft_superseded', latest_version: latest };
  }
  const read = readDraftVersion(projectDir, runId, draftId, approval.draft_version);
  if (!read.ok) return { ok: false, reason: read.reason === 'bundle_tampered' ? 'bundle_tampered' : `draft_${read.reason}` };
  if (read.bundle.approval_bundle_hash !== approval.approval_bundle_hash) {
    return { ok: false, reason: 'approval_stale' };
  }
  if (approval.approve_execution !== true) {
    return { ok: false, reason: 'execution_not_approved' };
  }
  return { ok: true, bundle: read.bundle };
}
