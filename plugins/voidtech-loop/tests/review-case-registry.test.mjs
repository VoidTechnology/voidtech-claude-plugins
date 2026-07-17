// Task 6.1：预登记 case registry 盲评时序协议（P2-23）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  enrollCase, lockReference, recordAgentResult, revealAgentResult,
  markContaminated, recordAdjudication, updateEnvelope, readCase, listCases, isGateEligible,
} from '../scripts/lib/reviewcaseregistry.mjs';

const hex64 = (c) => c.repeat(64);
const RUN = 'payment-tests-a1b2c3d4';

const ENVELOPE = {
  in_envelope: true, delegate_eligible: false,
  diff_bytes: 1200, binary_changes: 0, sources_complete: true,
  computed_from: hex64('m'),
};

function enroll(projectDir, overrides = {}) {
  return enrollCase(projectDir, {
    caseId: overrides.caseId ?? 'case-001',
    runId: RUN,
    kind: overrides.kind ?? 'blind_dogfood',
    envelope: ENVELOPE,
    seeded: overrides.seeded ?? null,
    now: new Date('2026-07-17T10:00:00Z'),
  });
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'corpus-'));
  try {
    return callback(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

test('盲评正序：enroll → reference lock → agent lock/reveal → 合格进入 gate', () => withProject((projectDir) => {
  assert.equal(enroll(projectDir).ok, true);
  assert.equal(lockReference(projectDir, 'case-001', {
    outcome: 'revise', must_escalate: false,
    blocking_findings: [{ id: 'ref-f1', category: 'eval-coverage', summary: 'API not covered', refs: ['diff:src/api.ts'] }],
  }, { now: new Date('2026-07-17T10:30:00Z') }).ok, true);
  assert.equal(recordAgentResult(projectDir, 'case-001', {
    proposalHash: hex64('p'), inputManifestHash: hex64('m'),
    outcome: 'revise', coverageStatus: 'complete', escalated: false,
    now: new Date('2026-07-17T10:40:00Z'),
  }).ok, true);

  const record = readCase(projectDir, 'case-001').record;
  assert.ok(record.reference.locked_at < record.agent_result.revealed_at);
  assert.equal(isGateEligible(record), true);
}));

test('两阶段揭示：先 lock（未揭示）后 reveal，reveal 幂等', () => withProject((projectDir) => {
  enroll(projectDir);
  lockReference(projectDir, 'case-001', { outcome: 'accept' }, { now: new Date('2026-07-17T10:30:00Z') });
  recordAgentResult(projectDir, 'case-001', {
    proposalHash: hex64('p'), inputManifestHash: hex64('m'),
    outcome: 'accept', coverageStatus: 'complete', escalated: false,
    now: new Date('2026-07-17T10:40:00Z'), revealed: false,
  });
  assert.equal(readCase(projectDir, 'case-001').record.agent_result.revealed_at, null);
  assert.equal(isGateEligible(readCase(projectDir, 'case-001').record), false, '未揭示不进入 gate');

  assert.equal(revealAgentResult(projectDir, 'case-001', { now: new Date('2026-07-17T10:50:00Z') }).ok, true);
  assert.equal(revealAgentResult(projectDir, 'case-001').already, true);
  assert.equal(isGateEligible(readCase(projectDir, 'case-001').record), true);
}));

test('时序违规：揭示后提交 reference 被拒并永久污染', () => withProject((projectDir) => {
  enroll(projectDir);
  recordAgentResult(projectDir, 'case-001', {
    proposalHash: hex64('p'), inputManifestHash: hex64('m'),
    outcome: 'accept', coverageStatus: 'complete', escalated: false,
    now: new Date('2026-07-17T10:10:00Z'),
  });
  const late = lockReference(projectDir, 'case-001', { outcome: 'revise' }, { now: new Date('2026-07-17T11:00:00Z') });
  assert.deepEqual({ ok: late.ok, reason: late.reason }, { ok: false, reason: 'reference_after_reveal' });

  const record = readCase(projectDir, 'case-001').record;
  assert.equal(record.contaminated, true);
  assert.equal(record.contamination_reason, 'reference_after_reveal');
  assert.equal(isGateEligible(record), false, '污染 case 排除出 gate，但保留计数');
}));

test('揭示后 kind/envelope 冻结；reference 锁定后 envelope 同样冻结', () => withProject((projectDir) => {
  enroll(projectDir);
  lockReference(projectDir, 'case-001', { outcome: 'accept' }, { now: new Date('2026-07-17T10:30:00Z') });
  assert.equal(updateEnvelope(projectDir, 'case-001', { ...ENVELOPE, in_envelope: false }).reason, 'frozen_after_reference');

  enroll(projectDir, { caseId: 'case-002' });
  recordAgentResult(projectDir, 'case-002', {
    proposalHash: hex64('p'), inputManifestHash: hex64('m'),
    outcome: 'accept', coverageStatus: 'complete', escalated: false,
  });
  assert.equal(updateEnvelope(projectDir, 'case-002', ENVELOPE).reason, 'frozen_after_reveal');
}));

test('seeded case：预期结论必须在执行前冻结；缺预期拒绝登记', () => withProject((projectDir) => {
  const missing = enroll(projectDir, { caseId: 'case-s1', kind: 'calibration_seeded' });
  assert.equal(missing.reason, 'seeded_expectation_required');

  const seeded = enroll(projectDir, {
    caseId: 'case-s2', kind: 'calibration_seeded',
    seeded: {
      labels: ['prompt_injection', 'eval_gaming'],
      expected: { outcome: 'revise', blocking_finding_ids: ['eval-gaming', 'api-break'] },
    },
  });
  assert.equal(seeded.ok, true);
  assert.equal(isGateEligible(seeded.record), false, 'seeded 永不进入 blind gate');
}));

test('adjudication 只能在揭示后记录；未揭示拒绝', () => withProject((projectDir) => {
  enroll(projectDir);
  assert.equal(recordAdjudication(projectDir, 'case-001', { material_override: false }).reason, 'not_revealed');

  recordAgentResult(projectDir, 'case-001', {
    proposalHash: hex64('p'), inputManifestHash: hex64('m'),
    outcome: 'accept', coverageStatus: 'complete', escalated: false,
  });
  assert.equal(recordAdjudication(projectDir, 'case-001', {
    material_override: false, critical_miss: false,
    finding_marks: [],
  }).ok, true);
}));

test('corpus 不含未脱敏秘密：enroll 与 reference 均拒绝', () => withProject((projectDir) => {
  // 假凭据用运行时拼接构造：避免仓库明文密钥扫描误报，同时仍触发 registry 的入库检查
  const fakeOpenAiKey = ['sk', 'abcdefghijklmnop1234'].join('-');
  const fakeAwsKey = `AKIA${'ABCDEFGHIJKLMNOP'}`;
  const leaky = enrollCase(projectDir, {
    caseId: 'case-leak', runId: RUN, kind: 'blind_dogfood',
    envelope: { ...ENVELOPE, note: `token ${fakeOpenAiKey}` },
  });
  assert.equal(leaky.reason, 'secret_literal');

  enroll(projectDir);
  const leakyRef = lockReference(projectDir, 'case-001', {
    outcome: 'revise',
    blocking_findings: [{ id: 'f', summary: `uses ${fakeAwsKey} in config` }],
  });
  assert.equal(leakyRef.reason, 'secret_literal');
}));

test('重复登记、未知类型、列表与人工污染标记', () => withProject((projectDir) => {
  enroll(projectDir);
  assert.equal(enroll(projectDir).reason, 'case_exists');
  assert.equal(enroll(projectDir, { caseId: 'x', kind: 'freestyle' }).reason, 'unknown_kind');

  enroll(projectDir, { caseId: 'case-002' });
  markContaminated(projectDir, 'case-002', 'initiator_saw_agent_outcome');
  assert.equal(readCase(projectDir, 'case-002').record.contaminated, true);
  assert.deepEqual(listCases(projectDir).map((c) => c.case_id), ['case-001', 'case-002']);
}));
