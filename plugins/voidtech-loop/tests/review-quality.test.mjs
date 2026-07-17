// Task 6.2：分层质量指标与发布门（PRD §13，P2-17）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQualityReport, renderQualityReport } from '../scripts/review-quality.mjs';

const hex64 = (c) => c.repeat(64);

let n = 0;
function blindCase({
  contaminated = false, inEnvelope = true, delegateEligible = false,
  outcome = 'accept', escalated = false, coverage = 'complete',
  mustEscalate = false, adjudication = baseAdjudication(), referenceAfterReveal = false,
} = {}) {
  n += 1;
  return {
    schema_version: 1,
    case_id: `case-${String(n).padStart(3, '0')}`,
    run_id: `run-${n}`,
    kind: 'blind_dogfood',
    support_envelope: { in_envelope: inEnvelope, delegate_eligible: delegateEligible },
    seeded: null,
    enrolled_at: '2026-07-17T09:00:00Z',
    reference: {
      locked_at: referenceAfterReveal ? '2026-07-17T11:00:00Z' : '2026-07-17T10:00:00Z',
      outcome: 'accept', must_escalate: mustEscalate, blocking_findings: [], escalations: [],
    },
    agent_result: {
      locked_at: '2026-07-17T10:30:00Z', revealed_at: '2026-07-17T10:30:00Z',
      proposal_hash: hex64('p'), input_manifest_hash: hex64('m'),
      outcome, coverage_status: coverage, escalated,
    },
    contaminated,
    contamination_reason: contaminated ? 'test' : null,
    adjudication,
  };
}

function baseAdjudication(overrides = {}) {
  return {
    material_override: false, critical_miss: false,
    reference_marks: [], agent_finding_marks: [],
    ...overrides,
  };
}

test('分层隔离：seeded / boundary / 污染 / 时序违规 case 不进入 blind 分母', () => {
  const cases = [
    blindCase(),
    blindCase({ contaminated: true }),
    blindCase({ referenceAfterReveal: true }),
    { ...blindCase(), kind: 'calibration_seeded', seeded: { labels: ['x'], expected: {} }, adjudication: { seeded: { expected_found: 1, expected_total: 2, outcome_match: true } } },
    { ...blindCase(), kind: 'boundary_synthetic', adjudication: { routing_correct: true } },
  ];
  const r = computeQualityReport(cases);
  assert.equal(r.blind.qualified, 1, '只有正序未污染 blind 计入');
  assert.equal(r.blind.contaminated, 1);
  assert.equal(r.seeded.total, 1);
  assert.equal(r.boundary.total, 1);
  assert.deepEqual(r.seeded.detection, { num: 1, den: 2, value: 0.5 });
  assert.deepEqual(r.boundary.routing_correct, { num: 1, den: 1, value: 1 });
});

test('must-escalate 分母为 0 → INSUFFICIENT，不伪装 100%', () => {
  const r = computeQualityReport([blindCase(), blindCase()]);
  assert.equal(r.gates.must_escalate_recall.status, 'INSUFFICIENT');
  assert.notEqual(r.overall, 'GO');
  assert.match(renderQualityReport(r), /分母为 0/);
});

test('recall 口径：exact + 二人确认 partial；unsupported 两类分别计数', () => {
  const marks = baseAdjudication({
    reference_marks: [
      { id: 'r1', mark: 'exact' },
      { id: 'r2', mark: 'partial', partial_confirmed: true },
      { id: 'r3', mark: 'partial', partial_confirmed: false },
      { id: 'r4', mark: 'missed' },
    ],
    agent_finding_marks: [
      { id: 'a1', unsupported: false },
      { id: 'a2', unsupported: true, unsupported_kind: 'nonexistent' },
      { id: 'a3', unsupported: true, unsupported_kind: 'severity_unsupported' },
    ],
  });
  const r = computeQualityReport([blindCase({ adjudication: marks })]);
  assert.deepEqual(r.blind.blocking_recall, { num: 2, den: 4, value: 0.5 });
  assert.deepEqual(r.blind.unsupported_blocking, { num: 2, den: 3, nonexistent: 1, severity_unsupported: 1 });
});

test('eligible_coverage / budget_limited / 非必要升级 / delegate 观察指标', () => {
  const cases = [
    blindCase(),                                              // concluded
    blindCase({ escalated: true, outcome: 'escalate', adjudication: null }), // 升级（reference 不要求）→ 非必要
    blindCase({ coverage: 'budget_limited', adjudication: null }),           // in-envelope budget limited
    blindCase({ inEnvelope: false, adjudication: null }),                    // out of envelope
    blindCase({ delegateEligible: true }),
  ];
  const r = computeQualityReport(cases);
  assert.equal(r.blind.in_envelope, 4);
  assert.deepEqual(r.blind.eligible_coverage, { num: 2, den: 4, value: 0.5 });
  assert.equal(r.blind.budget_limited_in_envelope_count, 1);
  assert.deepEqual(r.blind.unnecessary_escalation_rate, { num: 1, den: 4, value: 0.25 });
  assert.deepEqual(r.blind.delegate_eligible_rate, { num: 1, den: 5, value: 0.2 });
  assert.equal(r.gates.budget_limited_in_envelope.status, 'FAIL');
});

test('critical miss / material override / 未裁定 各自触发对应门', () => {
  const missed = computeQualityReport([blindCase({ adjudication: baseAdjudication({ critical_miss: true }) })]);
  assert.equal(missed.gates.critical_miss.status, 'FAIL');
  assert.equal(missed.overall, 'NO-GO');

  const overridden = computeQualityReport([
    blindCase({ adjudication: baseAdjudication({ material_override: true }) }),
    ...Array.from({ length: 9 }, () => blindCase()),
  ]);
  assert.deepEqual(overridden.blind.material_override_rate, { num: 1, den: 10, value: 0.1 });
  assert.equal(overridden.gates.material_override_rate.status, 'FAIL', '10% > 5% 上限');

  const unadjudicated = computeQualityReport([blindCase({ adjudication: null })]);
  assert.equal(unadjudicated.gates.adjudication_complete.status, 'FAIL');
});

test('构造达标 corpus → 全门 PASS 与 GO；样本不足 → 明确 NO-GO 路径', () => {
  const good = [
    ...Array.from({ length: 29 }, () => blindCase()),
    blindCase({ mustEscalate: true, escalated: true, outcome: 'escalate', adjudication: baseAdjudication() }),
  ];
  const r = computeQualityReport(good);
  assert.equal(r.blind.qualified, 30);
  assert.equal(r.gates.sample_size.status, 'PASS');
  assert.equal(r.gates.must_escalate_recall.status, 'PASS');
  assert.equal(r.overall, 'GO', JSON.stringify(r.gates));
  assert.match(renderQualityReport(r), /结论：GO/);

  const small = computeQualityReport(good.slice(0, 10));
  assert.equal(small.gates.sample_size.status, 'FAIL');
  assert.equal(small.overall, 'NO-GO');
  assert.match(renderQualityReport(small), /自动落决定保持关闭/);
});

test('must-escalate 漏升级 → recall FAIL', () => {
  const cases = [
    ...Array.from({ length: 30 }, () => blindCase()),
    blindCase({ mustEscalate: true, escalated: false, outcome: 'accept', adjudication: baseAdjudication() }),
  ];
  const r = computeQualityReport(cases);
  assert.deepEqual(r.blind.must_escalate_recall, { num: 0, den: 1, value: 0 });
  assert.equal(r.gates.must_escalate_recall.status, 'FAIL');
  assert.equal(r.overall, 'NO-GO');
});
