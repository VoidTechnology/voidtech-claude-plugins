// Review 资产的 schema、路径与内容 hash 单一来源（二期技术设计 §2/§3，Task 1.1）。
// 路径职责边界：runs/ 沿用一期语义；decisions/<run-id>/ 保存 operation journal、staging 与
// finalized committed/；reviews/<run-id>/ 保存 fact pack、proposal、draft 与 verification attempt；
// delegation-grants/ 保存 reviewer 启动前冻结的授权。finalized 与 staging 物理分离；
// review lock 挂在 run 目录下（per-run 串行），与项目锁互不占用。

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from './validate.mjs';
import { validateSchema } from './schema.mjs';

const SCHEMA_FILES = {
  decision_record: 'decision-record.schema.json',
  review_operation: 'review-operation.schema.json',
  feedback_pack: 'feedback-pack.schema.json',
  approval_bundle: 'approval-bundle.schema.json',
  revision_manifest: 'revision-manifest.schema.json',
  verification_record: 'verification-record.schema.json',
  delegation_grant: 'delegation-grant.schema.json',
  review_fact_pack: 'review-fact-pack.schema.json',
  review_proposal: 'review-proposal.schema.json',
};

const schemaCache = new Map();

export function loadReviewSchema(kind) {
  const file = SCHEMA_FILES[kind];
  if (!file) throw new Error(`未知 review artifact 类型：${kind}`);
  if (!schemaCache.has(kind)) {
    schemaCache.set(kind, JSON.parse(readFileSync(new URL(`../../schemas/${file}`, import.meta.url), 'utf8')));
  }
  return schemaCache.get(kind);
}

export function validateReviewArtifact(kind, value) {
  const errors = validateSchema(value, loadReviewSchema(kind));
  // operation 的 decision_payload.decision 是嵌套完整 Decision Record；
  // 通用解释器无 $ref，这里显式二次校验，保证 journal 里的 payload 可恢复且合法。
  if (kind === 'review_operation' && errors.length === 0) {
    errors.push(...validateSchema(value.decision_payload.decision, loadReviewSchema('decision_record'), '$.decision_payload.decision'));
  }
  return { ok: errors.length === 0, errors };
}

// ---------- 内容 hash（技术设计 §3.6：hash 只证明内容绑定） ----------

export function artifactHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// approval_bundle_hash = 除自身外全部 bundle 字段的 canonical JSON SHA-256（§3.6）。
export function computeApprovalBundleHash(bundle) {
  const body = { ...bundle };
  delete body.approval_bundle_hash;
  return artifactHash(body);
}

// decision_hash 对完整 canonical Decision Record 计算；operation journal 据此恢复同一决定（§3.2）。
export function computeDecisionHash(record) {
  return artifactHash(record);
}

// ---------- 路径（单一来源，调用方不得自行拼接子路径） ----------

export function runDir(projectDir, runId) {
  return join(projectDir, 'runs', runId);
}

// per-run review lock（§3.4）：位于 run 目录内，复用一期 mkdir/tombstone 协议。
export function runReviewLockParent(projectDir, runId) {
  return runDir(projectDir, runId);
}

export function decisionsDir(projectDir, runId) {
  return join(projectDir, 'decisions', runId);
}

export function operationsDir(projectDir, runId) {
  return join(decisionsDir(projectDir, runId), 'operations');
}

export function operationPath(projectDir, runId, operationId) {
  return join(operationsDir(projectDir, runId), `${operationId}.json`);
}

// finalized 决定的唯一落点：committed/ 出现即占用 decision slot（§3.7）。
export function committedDir(projectDir, runId) {
  return join(decisionsDir(projectDir, runId), 'committed');
}

export function committedDecisionRecordPath(projectDir, runId) {
  return join(committedDir(projectDir, runId), 'decision-record.json');
}

export function committedRevisionDir(projectDir, runId) {
  return join(committedDir(projectDir, runId), 'revision');
}

export function committedSupplementalDir(projectDir, runId) {
  return join(committedDir(projectDir, runId), 'supplemental-verification');
}

// staging 不属于 finalized 事实（§2）；与 committed 同父目录以满足原子 rename 的同卷前提（§3.7）。
export function stagingDir(projectDir, runId, transactionId) {
  return join(decisionsDir(projectDir, runId), 'staging', transactionId);
}

export function reviewsDir(projectDir, runId) {
  return join(projectDir, 'reviews', runId);
}

export function factPackDir(projectDir, runId, factPackId) {
  return join(reviewsDir(projectDir, runId), 'fact-packs', factPackId);
}

export function proposalPath(projectDir, runId, proposalId) {
  return join(reviewsDir(projectDir, runId), 'proposals', `${proposalId}.json`);
}

export function draftDir(projectDir, runId, draftId) {
  return join(reviewsDir(projectDir, runId), 'drafts', draftId);
}

export function verificationAttemptsDir(projectDir, runId, verificationId) {
  return join(reviewsDir(projectDir, runId), 'verifications', verificationId, 'attempts');
}

export function delegationGrantPath(projectDir, grantId) {
  return join(projectDir, 'delegation-grants', `${grantId}.json`);
}
