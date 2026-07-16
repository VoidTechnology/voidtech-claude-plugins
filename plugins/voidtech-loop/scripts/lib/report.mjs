// 交接报告（PRD F10 / 6.2）：任何机器终态、暂停、阻塞与取消均生成字段固定的报告。
// 报告是唯一交接物；固定声明段防止读者高估审计强度或误读完成语义。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// PRD 6.2 固定声明：EVALS_PASSED≠ACCEPTED、无 OS 级强隔离、审计快照局限、
// keychain 凭据路径、证据随卸载删除、未自动合入。
const FIXED_DECLARATIONS = [
  '`EVALS_PASSED` 不等于 `ACCEPTED`：机器验收通过不代表任务或产品方向正确。',
  '一期为固定 best-effort 隔离，不提供 OS 级文件系统或网络强隔离。',
  '审计快照只能发现留下痕迹的篡改；改完即还原的瞬态操作不可见。',
  'eval 进程仍可经 keychain 与用户配置文件获取凭据，网络外传不受一期阻断。',
  '报告与证据存于插件数据区，卸载插件会一并删除。',
  '循环从不自动 push、merge、建 PR 或改写用户分支；合入永远由人执行。',
];

export function renderReport(state, review = null) {
  const L = [];
  const push = (s = '') => L.push(s);

  push(`# voidtech-loop 交接报告`);
  push();
  push(`- **run ID**：${state.run_id}`);
  push(`- **状态**：${state.status}${state.stop_reason ? `（${state.stop_reason}）` : ''}`);
  push(`- **Goal Spec**：${state.spec?.goal_id ?? 'n/a'}　hash \`${state.goal_hash}\``);
  push(`- **base commit**：${state.base_commit}`);
  push(`- **candidate / 最近 checkpoint**：${state.candidate_commit ?? state.last_checkpoint}`);
  push(`- **循环分支**：${state.branch}`);
  push(`- **worktree**：${state.worktree}`);
  push(`- **迭代数**：${state.iteration}`);
  push(`- **墙钟**：${state.started_at} → ${state.updated_at ?? 'n/a'}`);
  push(`- **token**：${state.cost?.unavailable ? 'unavailable' : `约 $${(state.cost.total_usd ?? 0).toFixed(4)}`}`);
  push();

  push(`## 任务`);
  push();
  push(state.spec?.task ?? 'n/a');
  push();

  push(`## 每轮与 checkpoint`);
  push();
  push(`| 轮次 | worker 退出 | 变更 | checkpoint | eval |`);
  push(`|------|-------------|------|------------|------|`);
  for (const r of state.rounds ?? []) {
    const evalDesc = r.eval ? (r.eval.passed ? '全部通过' : `失败：${r.eval.failed_ids.join(',') || '—'}`) : '—';
    push(`| ${r.iteration} | ${r.worker?.timed_out ? 'timeout' : r.worker?.exit} | ${r.no_change ? 'no_change' : (r.checkpoint ? r.checkpoint.slice(0, 10) : '—')} | ${r.checkpoint ? r.checkpoint.slice(0, 10) : '—'} | ${evalDesc} |`);
  }
  push();

  const lastEval = [...(state.rounds ?? [])].reverse().find((r) => r.eval)?.eval;
  if (lastEval) {
    push(`## 最近一轮 eval 结果`);
    push();
    push(`| eval | 角色 | 结果 | 退出码 | 证据 |`);
    push(`|------|------|------|--------|------|`);
    for (const e of lastEval.results) {
      const run = e.runs[e.runs.length - 1];
      push(`| ${e.id} | ${e.role} | ${e.pass ? 'pass' : 'fail'} | ${run?.timed_out ? 'timeout' : run?.exit ?? '—'} | ${run?.evidence?.path ?? '—'} |`);
    }
    push();
  }

  if (state.spec?.manual_review?.length) {
    push(`## 需人工复核`);
    push();
    for (const m of state.spec.manual_review) push(`- [ ] ${m}`);
    push();
  }
  if (state.spec?.out_of_scope?.length) {
    push(`## 明确不在范围`);
    push();
    for (const o of state.spec.out_of_scope) push(`- ${o}`);
    push();
  }
  if (state.spec?.protected_paths?.length) {
    push(`## protected paths`);
    push();
    for (const p of state.spec.protected_paths) push(`- ${p}`);
    push();
  }

  push(`## 能力与隔离审计`);
  push();
  push(`- 隔离等级：\`best_effort\`（worker 工具：Read/Grep/Glob/Edit/Write/Bash；禁用 Agent/WebSearch/WebFetch/MCP）`);
  push(`- Bash 网络访问无法由一期完全阻断。`);
  if ((state.audit_recorded ?? []).length) {
    push(`- 记录（不终止）的 refs/remotes 变化 ${state.audit_recorded.length} 项。`);
  }
  push();

  if (state.stop_reason) {
    push(`## 终止详情`);
    push();
    push('```json');
    push(JSON.stringify(state.stop_detail ?? {}, null, 2));
    push('```');
    push();
  }

  push(`## 继续工作`);
  push();
  const resumeBase = state.candidate_commit ?? state.last_checkpoint;
  push(`本循环不提供 resume。以最近 commit 为 base 发起新循环：`);
  push();
  push('```text');
  push(`loop goal "<任务>" --check "<命令>" --max-iterations N --base ${resumeBase}`);
  push('```');
  push();
  if (state.status === 'EVALS_PASSED') {
    push(`或复核后接受：\`loop accept ${state.run_id}\``);
    push();
  }

  // 二期（P2-24）：执行健康与评审健康分开呈现；decision actor 与依据可追溯，不伪装身份认证
  if (review) {
    push(`## Review 决定与健康度`);
    push();
    push(`- **run_integrity**：\`${review.integrity?.run_integrity ?? 'unknown'}\``);
    push(`- **review_integrity**：\`${review.integrity?.review_integrity ?? 'not_started'}\``);
    if (review.decision) {
      const d = review.decision;
      const actor = d.decided_by.kind === 'agent'
        ? `agent（session ${d.decided_by.session_id}，授权 ${d.authorization?.grant_id ?? 'n/a'}）`
        : `local_user（identity_verified: false）`;
      push(`- **decision**：${d.outcome}　\`${d.decision_id}\`　by ${actor}　at ${d.decided_at}`);
      if (d.note) push(`- **note**：${d.note}`);
      if (d.manual_review_results.length) {
        push(`- **manual review 结果**：`);
        for (const m of d.manual_review_results) push(`  - [${m.passed ? 'x' : ' '}] ${m.item}${m.note ? `（${m.note}）` : ''}`);
      }
    }
    push();
  }

  push(`## 固定声明`);
  push();
  for (const d of FIXED_DECLARATIONS) push(`- ${d}`);
  push();

  return L.join('\n');
}

export function writeReport(stateDir, state, review = null) {
  const path = join(stateDir, 'report.md');
  writeFileSync(path, renderReport(state, review));
  return path;
}

export { FIXED_DECLARATIONS };
