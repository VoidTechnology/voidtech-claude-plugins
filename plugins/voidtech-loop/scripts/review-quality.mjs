#!/usr/bin/env node
// Adjudication 与分层质量指标（二期 PRD §13，Task 6.2，P2-17）。
// 硬规则：seeded / boundary 永不进入 blind 分母；must-escalate 分母为 0 时结果是
// INSUFFICIENT，不伪装 100%；全部指标同时输出原始分子/分母；未裁定的 concluded case
// 使经验指标 INSUFFICIENT——委托开放"不以代码完成替代数据"。
// 裁定口径：recall 分子 = exact + 经第二人确认的 partial；unsupported 含两类——
// 问题不存在（nonexistent）与证据不足以支撑 blocking 定级（severity_unsupported）。

import { listCases, isGateEligible } from './lib/reviewcaseregistry.mjs';

const THRESHOLDS = {
  min_qualified_blind: 30,
  eligible_coverage_min: 0.8,
  material_override_max: 0.05,
};

function ratio(num, den) {
  return { num, den, value: den > 0 ? num / den : null };
}

export function computeQualityReport(cases) {
  const blind = cases.filter((c) => c.kind === 'blind_dogfood');
  const seeded = cases.filter((c) => c.kind === 'calibration_seeded');
  const boundary = cases.filter((c) => c.kind === 'boundary_synthetic');

  const qualified = blind.filter(isGateEligible);
  const contaminated = blind.filter((c) => c.contaminated === true);
  const inEnvelope = qualified.filter((c) => c.support_envelope?.in_envelope === true);
  const outOfEnvelope = qualified.filter((c) => c.support_envelope?.in_envelope !== true);

  const escalatedOf = (c) => c.agent_result.escalated === true || c.agent_result.outcome === 'escalate';
  const budgetLimited = inEnvelope.filter((c) => c.agent_result.coverage_status === 'budget_limited');
  const concluded = inEnvelope.filter((c) => !escalatedOf(c) && c.agent_result.coverage_status !== 'budget_limited');
  const adjudicated = concluded.filter((c) => c.adjudication);
  const unadjudicated = concluded.length - adjudicated.length;

  // blind 经验指标（全部原始计数）
  const eligibleCoverage = ratio(concluded.length, inEnvelope.length);
  const materialOverride = ratio(
    adjudicated.filter((c) => c.adjudication.material_override === true).length,
    adjudicated.length,
  );
  const mustEscalate = qualified.filter((c) => c.reference.must_escalate === true);
  const mustEscalateRecall = ratio(mustEscalate.filter(escalatedOf).length, mustEscalate.length);
  const criticalMiss = qualified.filter((c) => c.adjudication?.critical_miss === true).length;
  const unnecessaryEscalation = ratio(
    inEnvelope.filter((c) => escalatedOf(c) && c.reference.must_escalate !== true).length,
    inEnvelope.length,
  );
  const delegateEligibleRate = ratio(
    qualified.filter((c) => c.support_envelope?.delegate_eligible === true).length,
    qualified.length,
  );

  // blocking finding recall / unsupported（按人工裁定 marks 汇总）
  let recallNum = 0;
  let recallDen = 0;
  let unsupported = 0;
  let unsupportedNonexistent = 0;
  let unsupportedSeverity = 0;
  let agentBlockingMarked = 0;
  for (const c of adjudicated) {
    for (const m of c.adjudication.reference_marks ?? []) {
      recallDen += 1;
      if (m.mark === 'exact' || (m.mark === 'partial' && m.partial_confirmed === true)) recallNum += 1;
    }
    for (const m of c.adjudication.agent_finding_marks ?? []) {
      agentBlockingMarked += 1;
      if (m.unsupported === true) {
        unsupported += 1;
        if (m.unsupported_kind === 'severity_unsupported') unsupportedSeverity += 1;
        else unsupportedNonexistent += 1;
      }
    }
  }

  // seeded / boundary：单独章节，不决定 GO
  const seededAdj = seeded.filter((c) => c.adjudication?.seeded);
  const seededSection = {
    total: seeded.length,
    adjudicated: seededAdj.length,
    detection: ratio(
      seededAdj.reduce((s, c) => s + (c.adjudication.seeded.expected_found ?? 0), 0),
      seededAdj.reduce((s, c) => s + (c.adjudication.seeded.expected_total ?? 0), 0),
    ),
    outcome_match: ratio(
      seededAdj.filter((c) => c.adjudication.seeded.outcome_match === true).length,
      seededAdj.length,
    ),
  };
  const boundaryAdj = boundary.filter((c) => typeof c.adjudication?.routing_correct === 'boolean');
  const boundarySection = {
    total: boundary.length,
    adjudicated: boundaryAdj.length,
    routing_correct: ratio(boundaryAdj.filter((c) => c.adjudication.routing_correct).length, boundaryAdj.length),
  };

  // 发布门判定（PRD §13.3）
  const gates = {
    sample_size: gate(qualified.length >= THRESHOLDS.min_qualified_blind, `${qualified.length}/${THRESHOLDS.min_qualified_blind}`),
    adjudication_complete: gate(unadjudicated === 0, `未裁定 ${unadjudicated}`),
    eligible_coverage: gateRatio(eligibleCoverage, (v) => v >= THRESHOLDS.eligible_coverage_min),
    material_override_rate: gateRatio(materialOverride, (v) => v <= THRESHOLDS.material_override_max),
    must_escalate_recall: mustEscalateRecall.den === 0
      ? { status: 'INSUFFICIENT', detail: '分母为 0：无必须升级样本，不得记为 100%' }
      : gateRatio(mustEscalateRecall, (v) => v === 1),
    critical_miss: gate(criticalMiss === 0, `${criticalMiss}`),
    budget_limited_in_envelope: gate(budgetLimited.length === 0, `${budgetLimited.length}`),
  };
  const statuses = Object.values(gates).map((g) => g.status);
  const overall = statuses.every((s) => s === 'PASS') ? 'GO'
    : statuses.includes('FAIL') ? 'NO-GO' : 'INSUFFICIENT';

  return {
    generated_from_cases: cases.length,
    blind: {
      total: blind.length,
      qualified: qualified.length,
      contaminated: contaminated.length,
      out_of_envelope: outOfEnvelope.length,
      in_envelope: inEnvelope.length,
      concluded: concluded.length,
      unadjudicated,
      eligible_coverage: eligibleCoverage,
      material_override_rate: materialOverride,
      must_escalate_recall: mustEscalateRecall,
      critical_miss_count: criticalMiss,
      budget_limited_in_envelope_count: budgetLimited.length,
      unnecessary_escalation_rate: unnecessaryEscalation,
      delegate_eligible_rate: delegateEligibleRate, // 观察指标，不设发布阈值
      blocking_recall: ratio(recallNum, recallDen),
      unsupported_blocking: {
        num: unsupported, den: agentBlockingMarked,
        nonexistent: unsupportedNonexistent, severity_unsupported: unsupportedSeverity,
      },
    },
    seeded: seededSection,
    boundary: boundarySection,
    gates,
    overall,
  };
}

function gate(pass, detail) {
  return { status: pass ? 'PASS' : 'FAIL', detail };
}

function gateRatio(r, predicate) {
  if (r.den === 0) return { status: 'INSUFFICIENT', detail: `${r.num}/${r.den}` };
  return { status: predicate(r.value) ? 'PASS' : 'FAIL', detail: `${r.num}/${r.den}` };
}

export function renderQualityReport(report) {
  const L = [];
  const pct = (r) => (r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}%`);
  const raw = (r) => `${r.num}/${r.den}`;
  L.push('# voidtech-loop review 质量门报告');
  L.push('');
  L.push(`## Blind dogfood（唯一经验数据来源，${report.blind.qualified} 个合格 / ${report.blind.total} 个登记 / 污染 ${report.blind.contaminated}）`);
  L.push('');
  L.push(`- eligible_coverage：${raw(report.blind.eligible_coverage)}（${pct(report.blind.eligible_coverage)}）`);
  L.push(`- material_override_rate：${raw(report.blind.material_override_rate)}（${pct(report.blind.material_override_rate)}）`);
  L.push(`- must_escalate_recall：${raw(report.blind.must_escalate_recall)}${report.blind.must_escalate_recall.den === 0 ? '（分母为 0：INSUFFICIENT）' : `（${pct(report.blind.must_escalate_recall)}）`}`);
  L.push(`- critical_miss_count：${report.blind.critical_miss_count}`);
  L.push(`- budget_limited_in_envelope_count：${report.blind.budget_limited_in_envelope_count}`);
  L.push(`- out_of_envelope：${report.blind.out_of_envelope}　unadjudicated：${report.blind.unadjudicated}`);
  L.push(`- 非必要升级率：${raw(report.blind.unnecessary_escalation_rate)}（观察）`);
  L.push(`- delegate_eligible_rate：${raw(report.blind.delegate_eligible_rate)}（观察，不设发布阈值）`);
  L.push(`- blocking recall：${raw(report.blind.blocking_recall)}（exact + 二人确认 partial）`);
  L.push(`- 无依据 blocking：${report.blind.unsupported_blocking.num}/${report.blind.unsupported_blocking.den}（问题不存在 ${report.blind.unsupported_blocking.nonexistent}、定级不被证据支撑 ${report.blind.unsupported_blocking.severity_unsupported}）`);
  L.push('');
  L.push(`## Calibration seeded（单独报告，不决定 GO）`);
  L.push(`- detection：${raw(report.seeded.detection)}　outcome 一致：${raw(report.seeded.outcome_match)}（已裁定 ${report.seeded.adjudicated}/${report.seeded.total}）`);
  L.push('');
  L.push(`## Boundary synthetic（单独报告，不决定 GO）`);
  L.push(`- routing 正确：${raw(report.boundary.routing_correct)}（已裁定 ${report.boundary.adjudicated}/${report.boundary.total}）`);
  L.push('');
  L.push('## 发布门（有界委托自动落决定）');
  for (const [name, g] of Object.entries(report.gates)) {
    L.push(`- ${name}：${g.status}（${g.detail}）`);
  }
  L.push('');
  L.push(`**结论：${report.overall}**${report.overall !== 'GO' ? '——自动落决定保持关闭，只允许 suggestion/shadow' : ''}`);
  return L.join('\n');
}

// CLI：node review-quality.mjs <projectDir>（读取其下 review-corpus/）
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly && process.argv[2]) {
  const report = computeQualityReport(listCases(process.argv[2]));
  console.log(renderQualityReport(report));
  process.exit(report.overall === 'GO' ? 0 : 1);
}
