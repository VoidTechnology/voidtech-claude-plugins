// Initial Review Context 组装（二期技术设计 §7.2/§7.3，Task 4.3，P2-07）。
// 硬预算：initial 128 KiB；inline diff ≤48 KiB；round/eval matrix ≤24 KiB；
// evidence summaries ≤24 KiB；spec + terminal state projection + Delegation Grant + 索引
// 至少保留 32 KiB——必需内容超出 128 KiB 时拒绝 review，不截断规格。
// 裁剪顺序确定性；任何未注入内容都在 manifest 中可见并进入 coverage 统计，不静默丢弃。

import { canonicalJson } from './validate.mjs';

export const INITIAL_CONTEXT_CAP = 128 * 1024;
export const INLINE_DIFF_CAP = 48 * 1024;
export const ROUNDS_MATRIX_CAP = 24 * 1024;
export const EVIDENCE_SUMMARY_CAP = 24 * 1024;

const bytes = (text) => Buffer.byteLength(text, 'utf8');

function section(title, body) {
  return `## ${title}\n${body}\n`;
}

function clip(text, cap) {
  if (bytes(text) <= cap) return { text, omitted: false };
  const sliced = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
  return { text: `${sliced}\n…[clipped: 其余内容经 manifest 按需读取]`, omitted: true };
}

// evidenceSummaries: [{ id, summary }]，由调用方从磁盘读取（builder 不直接触盘，保持可测）。
export function buildInitialReviewContext({ manifest, spec, grant = null, diffText = '', evidenceSummaries = [] }) {
  // 优先级 1：必需区（不可截断，超限即拒绝 review）
  const required = [
    section('Frozen Goal Spec (canonical)', canonicalJson(spec)),
    section('Terminal State Projection', JSON.stringify(manifest.terminal_state, null, 2)),
    section('Delegation Grant', grant ? JSON.stringify(grant, null, 2) : '（建议模式：无授权，全部决定由人批准）'),
    section('Fact Pack Index', JSON.stringify({
      fact_pack_id: manifest.fact_pack_id,
      run_id: manifest.run_id,
      goal_hash: manifest.goal_hash,
      base_commit: manifest.base_commit,
      candidate_commit: manifest.candidate_commit,
      diff: { total_bytes: manifest.diff.total_bytes, sha256: manifest.diff.sha256, files_total: manifest.diff.files.length },
      rounds_total: manifest.rounds.length,
      evidence_total: manifest.evidence.length,
      snapshot: manifest.snapshot,
    }, null, 2)),
  ].join('\n');
  const requiredBytes = bytes(required);
  if (requiredBytes > INITIAL_CONTEXT_CAP) {
    return { ok: false, reason: 'required_context_overflow', required_bytes: requiredBytes, cap: INITIAL_CONTEXT_CAP };
  }

  const omitted = [];
  const parts = [required];
  let used = requiredBytes;

  // 优先级 2：changed paths、diffstat 与 round/eval/evidence 元数据（matrix ≤24 KiB）
  const matrix = clip([
    section('Changed Files (diffstat)', manifest.diff.files
      .map((f) => `${f.path}\t+${f.additions ?? 'bin'}\t-${f.deletions ?? 'bin'}${f.binary ? '\t[binary]' : ''}`)
      .join('\n') || '（无文件变化）'),
    section('Rounds / Eval Matrix', JSON.stringify(manifest.rounds, null, 2)),
    section('Evidence Metadata', JSON.stringify(manifest.evidence, null, 2)),
  ].join('\n'), ROUNDS_MATRIX_CAP);
  if (matrix.omitted) omitted.push('rounds_matrix_clipped');
  if (used + bytes(matrix.text) <= INITIAL_CONTEXT_CAP) {
    parts.push(matrix.text);
    used += bytes(matrix.text);
  } else {
    omitted.push('rounds_matrix');
  }

  // 优先级 3/5：inline diff（≤48 KiB 且不超总预算）
  const diffBudget = Math.min(INLINE_DIFF_CAP, INITIAL_CONTEXT_CAP - used);
  if (diffText.length > 0 && diffBudget > 512) {
    const diff = clip(diffText, diffBudget - 256);
    if (diff.omitted) omitted.push('diff_clipped');
    const block = section(`Candidate Diff (${manifest.base_commit.slice(0, 10)}..${manifest.candidate_commit.slice(0, 10)})`, diff.text);
    parts.push(block);
    used += bytes(block);
  } else if (diffText.length > 0) {
    omitted.push('diff');
  }

  // 优先级 4：失败 / 最终通过 / setup evidence 摘要（≤24 KiB）
  if (evidenceSummaries.length > 0) {
    const summaryBudget = Math.min(EVIDENCE_SUMMARY_CAP, INITIAL_CONTEXT_CAP - used);
    if (summaryBudget > 512) {
      const body = clip(
        evidenceSummaries.map((e) => `### evidence ${e.id}\n${e.summary}`).join('\n\n'),
        summaryBudget - 256,
      );
      if (body.omitted) omitted.push('evidence_summaries_clipped');
      const block = section('Evidence Summaries', body.text);
      parts.push(block);
      used += bytes(block);
    } else {
      omitted.push('evidence_summaries');
    }
  }

  if (omitted.length > 0) {
    parts.push(section('Omitted From Initial Context', `${omitted.join(', ')}\n以上内容未注入初始上下文，但全部在 Fact Pack manifest 中可见，可经按需读取获取。`));
  }

  const context = parts.join('\n');
  return {
    ok: true,
    context,
    total_bytes: bytes(context),
    required_bytes: requiredBytes,
    omitted,
  };
}
