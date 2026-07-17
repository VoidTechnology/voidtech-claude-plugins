// 预登记 case registry 与盲评时序协议（二期 PRD §13.1/§15，Task 6.1，P2-23）。
// 时序固定：enroll（冻结 kind 与 support envelope）→ reference lock → agent result lock
// → reveal → adjudication。只有 `reference_locked_at < agent_result_revealed_at` 且未污染的
// blind case 可进入委托开放门；kind 与 envelope 在揭示后不可修改；已看过 agent 结果的人
// 不能再提交盲评 reference（机械规则：揭示后一律拒绝并记录污染）。
// seeded 标签与预期结论必须在执行前冻结；corpus 不得含未脱敏秘密（复用 spec 同一规则）。

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './statestore.mjs';
import { scanSecretLiterals } from './validate.mjs';

export const CASE_KINDS = ['blind_dogfood', 'calibration_seeded', 'boundary_synthetic'];

export function corpusDir(projectDir) {
  return join(projectDir, 'review-corpus');
}

function casePath(projectDir, caseId) {
  return join(corpusDir(projectDir), `${caseId}.json`);
}

function save(projectDir, record) {
  mkdirSync(corpusDir(projectDir), { recursive: true });
  atomicWrite(casePath(projectDir, record.case_id), JSON.stringify(record, null, 2));
  return { ok: true, record };
}

export function readCase(projectDir, caseId) {
  const path = casePath(projectDir, caseId);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, record: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

export function listCases(projectDir) {
  const dir = corpusDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => readCase(projectDir, n.slice(0, -'.json'.length)))
    .filter((r) => r.ok).map((r) => r.record);
}

// enroll：agent review 之前登记；kind、support envelope 与 seeded 预期一次冻结。
// envelope 由独立机械分类器输入（diff 体积、二进制、可用来源、delegate eligibility），
// 不读取 agent 自报结果（P2-29）。
export function enrollCase(projectDir, {
  caseId, runId, kind, envelope, seeded = null, now = new Date(),
}) {
  if (!CASE_KINDS.includes(kind)) return { ok: false, reason: 'unknown_kind' };
  if (readCase(projectDir, caseId).ok) return { ok: false, reason: 'case_exists' };
  if (kind === 'calibration_seeded' && (!seeded || !Array.isArray(seeded.labels) || !seeded.expected)) {
    return { ok: false, reason: 'seeded_expectation_required' };
  }
  const record = {
    schema_version: 1,
    case_id: caseId,
    run_id: runId,
    kind,
    support_envelope: envelope,
    seeded,
    enrolled_at: now.toISOString(),
    reference: null,
    agent_result: null,
    contaminated: false,
    contamination_reason: null,
    adjudication: null,
  };
  const secrets = scanSecretLiterals(record);
  if (secrets.length > 0) return { ok: false, reason: 'secret_literal', hits: secrets };
  return save(projectDir, record);
}

// reference lock：必须发生在 agent 结果揭示之前。揭示后提交 → 拒绝并把 case 标记污染
// （提交者已可能看过 agent 结论，该 case 永久失去盲评资格，但计数公开）。
export function lockReference(projectDir, caseId, reference, { now = new Date() } = {}) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  const record = read.record;
  if (record.reference) return { ok: false, reason: 'reference_already_locked' };
  if (record.agent_result?.revealed_at) {
    record.contaminated = true;
    record.contamination_reason = 'reference_after_reveal';
    save(projectDir, record);
    return { ok: false, reason: 'reference_after_reveal', contaminated: true };
  }
  const entry = {
    locked_at: now.toISOString(),
    by: reference.by ?? { kind: 'local_user', claimed_id: null, identity_verified: false },
    outcome: reference.outcome,
    must_escalate: reference.must_escalate === true,
    blocking_findings: reference.blocking_findings ?? [],
    escalations: reference.escalations ?? [],
  };
  const secrets = scanSecretLiterals(entry);
  if (secrets.length > 0) return { ok: false, reason: 'secret_literal', hits: secrets };
  record.reference = entry;
  return save(projectDir, record);
}

// agent 结果锁定与揭示：建议模式 CLI 展示即揭示，两个时间戳可同刻。
// 只保存引用（proposal hash / manifest hash / outcome / coverage），不复制 proposal 正文。
export function recordAgentResult(projectDir, caseId, {
  proposalHash, inputManifestHash, outcome, coverageStatus, escalated, now = new Date(), revealed = true,
}) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  const record = read.record;
  if (record.agent_result?.revealed_at) return { ok: false, reason: 'already_revealed' };
  record.agent_result = {
    locked_at: now.toISOString(),
    revealed_at: revealed ? now.toISOString() : null,
    proposal_hash: proposalHash,
    input_manifest_hash: inputManifestHash,
    outcome,
    coverage_status: coverageStatus,
    escalated: escalated === true,
  };
  return save(projectDir, record);
}

export function revealAgentResult(projectDir, caseId, { now = new Date() } = {}) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  const record = read.record;
  if (!record.agent_result) return { ok: false, reason: 'no_agent_result' };
  if (record.agent_result.revealed_at) return { ok: true, record, already: true };
  record.agent_result.revealed_at = now.toISOString();
  return save(projectDir, record);
}

export function markContaminated(projectDir, caseId, reason) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  read.record.contaminated = true;
  read.record.contamination_reason = reason;
  return save(projectDir, read.record);
}

// adjudication（Task 6.2 的人工裁定落点）：揭示之后才允许；kind/envelope 永不可改。
export function recordAdjudication(projectDir, caseId, adjudication) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  const record = read.record;
  if (!record.agent_result?.revealed_at) return { ok: false, reason: 'not_revealed' };
  record.adjudication = adjudication;
  return save(projectDir, record);
}

// kind 与 envelope 在揭示后不可修改：唯一的更新入口显式拒绝。
export function updateEnvelope(projectDir, caseId, envelope) {
  const read = readCase(projectDir, caseId);
  if (!read.ok) return read;
  const record = read.record;
  if (record.agent_result?.revealed_at) return { ok: false, reason: 'frozen_after_reveal' };
  if (record.reference) return { ok: false, reason: 'frozen_after_reference' };
  record.support_envelope = envelope;
  return save(projectDir, record);
}

// 委托开放门资格（P2-23）：仅预登记、未污染、reference 先于揭示的 blind case。
export function isGateEligible(record) {
  return record.kind === 'blind_dogfood'
    && record.contaminated !== true
    && Boolean(record.reference?.locked_at)
    && Boolean(record.agent_result?.revealed_at)
    && record.reference.locked_at < record.agent_result.revealed_at;
}
