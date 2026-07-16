// Revision Bundle 与 Supplemental Accept Bundle 原子发布（二期技术设计 §3.7/§3.8，Task 1.6，P2-14）。
// 发布单位是 committed decision 目录：同目录 staging 写全全部资产 → fsync → 整目录原子 rename。
// committed/ 出现即代表 Decision Record、manifest 与 bundle 文件全部 finalized 且 hash 一致；
// 两种 committed 形态（revision / supplemental-verification）互斥；失败或 inconclusive 的
// verification attempt 只追加到 reviews/<run-id>/verifications/，不占 decision slot。

import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite } from './statestore.mjs';
import {
  committedDir, committedRevisionDir, committedSupplementalDir,
  verificationAttemptsDir, validateReviewArtifact,
} from './reviewstore.mjs';
import { submitDecision } from './decisionstore.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 在 staging 内写一个 bundle 子目录：全部文件 + 列出（含 decision-record.json）的 manifest。
function stageBundle(staging, subdir, decision, approvalBundleHash, kind, files) {
  const bundleDir = join(staging, subdir);
  mkdirSync(bundleDir, { recursive: true });
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(bundleDir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    atomicWrite(path, content);
    entries.push({ name: `${subdir}/${name}`, sha256: sha256(content) });
  }
  entries.push({ name: 'decision-record.json', sha256: sha256(JSON.stringify(decision, null, 2)) });
  const manifest = {
    schema_version: 1,
    kind,
    decision_id: decision.decision_id,
    approval_bundle_hash: approvalBundleHash,
    files: entries,
  };
  const validation = validateReviewArtifact('revision_manifest', manifest);
  if (!validation.ok) return { ok: false, reason: 'invalid_manifest', errors: validation.errors };
  atomicWrite(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ok: true };
}

// Revise 发布（§3.7）：committed/{decision-record.json, revision/{manifest,feedback-pack,goal-spec,baseline-result}}。
export function publishRevisionBundle(projectDir, runId, {
  operationId, decision, grant = null, expectedStateChecksum, applyStateUpdate = null,
  approvalBundleHash, feedbackPackYaml, goalSpecYaml, baselineResultJson,
}) {
  return submitDecision(projectDir, runId, {
    operationId, decision, grant, expectedStateChecksum, applyStateUpdate,
    stageFiles: (staging, effective) => stageBundle(staging, 'revision', effective, approvalBundleHash, 'revision', {
      'feedback-pack.yaml': feedbackPackYaml,
      'goal-spec.yaml': goalSpecYaml,
      'baseline-result.json': baselineResultJson,
    }),
  });
}

// verification-only pass 的 Supplemental Accept 发布（§3.8）：同一 decision transaction，
// committed 内容为 supplemental-verification/{manifest,goal-spec,result,evidence/*}。
export function publishSupplementalAccept(projectDir, runId, {
  operationId, decision, grant = null, expectedStateChecksum, applyStateUpdate = null,
  approvalBundleHash, goalSpecYaml, resultJson, evidence = {},
}) {
  const files = { 'goal-spec.yaml': goalSpecYaml, 'result.json': resultJson };
  for (const [name, content] of Object.entries(evidence)) {
    files[`evidence/${name}`] = content;
  }
  return submitDecision(projectDir, runId, {
    operationId, decision, grant, expectedStateChecksum, applyStateUpdate,
    stageFiles: (staging, effective) => stageBundle(
      staging, 'supplemental-verification', effective, approvalBundleHash, 'supplemental_verification', files,
    ),
  });
}

// 校验 committed bundle 完整性：manifest 存在、两种形态互斥、逐文件 sha256 一致。
export function verifyCommittedBundle(projectDir, runId) {
  const committed = committedDir(projectDir, runId);
  if (!existsSync(committed)) return { ok: true, exists: false };

  const hasRevision = existsSync(committedRevisionDir(projectDir, runId));
  const hasSupplemental = existsSync(committedSupplementalDir(projectDir, runId));
  if (hasRevision && hasSupplemental) {
    return { ok: false, reason: 'ambiguous_bundle_kind' };
  }
  if (!hasRevision && !hasSupplemental) {
    // 仅 decision-record 的 Accept/Abandon 发布：没有附加 bundle 需要校验
    return existsSync(join(committed, 'decision-record.json'))
      ? { ok: true, exists: true, kind: 'decision_only' }
      : { ok: false, reason: 'missing_decision_record' };
  }

  const subdir = hasRevision ? 'revision' : 'supplemental-verification';
  const manifestPath = join(committed, subdir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: 'missing_manifest' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt_manifest' };
  }
  const validation = validateReviewArtifact('revision_manifest', manifest);
  if (!validation.ok) return { ok: false, reason: 'invalid_manifest', errors: validation.errors };

  for (const entry of manifest.files) {
    const path = join(committed, entry.name);
    if (!existsSync(path)) return { ok: false, reason: 'missing_file', file: entry.name };
    if (sha256(readFileSync(path, 'utf8')) !== entry.sha256) {
      return { ok: false, reason: 'hash_mismatch', file: entry.name };
    }
  }
  return { ok: true, exists: true, kind: manifest.kind, manifest };
}

// 失败 / inconclusive attempt（§6.1）：append-only，不占 decision slot，不能伪装 finalized bundle。
export function recordVerificationAttempt(projectDir, runId, verificationId, record) {
  const validation = validateReviewArtifact('verification_record', record);
  if (!validation.ok) return { ok: false, reason: 'invalid_record', errors: validation.errors };
  const dir = verificationAttemptsDir(projectDir, runId, verificationId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `attempt-${record.attempt}.json`);
  if (existsSync(path)) return { ok: false, reason: 'attempt_exists' };
  atomicWrite(path, JSON.stringify(record, null, 2));
  return { ok: true, path };
}

export function listVerificationAttempts(projectDir, runId, verificationId) {
  const dir = verificationAttemptsDir(projectDir, runId, verificationId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}
