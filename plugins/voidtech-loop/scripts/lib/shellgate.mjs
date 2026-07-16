// 任意命令执行的统一确认门（二期技术设计 §5.3，Task 3.3）。
// 所有会执行 Goal Spec 的入口都必须复用这里，避免新增 CLI 时只接入执行器、漏掉用户风险确认。
// 二期语义：`--allow-shell` 只是一期兼容的 UX 信号；确认对象是从 normalized spec 派生的
// 完整 canonical Execution Plan（shell + argv + setup），确认被转换为绑定精确
// execution_plan_hash 的 approved_execution，执行入口不得持久化或直接信任裸布尔值。

import { buildExecutionPlan, renderExecutionPlan } from './executionplan.mjs';

export function shellExecutionGate(validation, { allowShell = false } = {}) {
  if (!validation?.ok) return { ok: true, required: false, commands: [], message: '' };

  const { plan, execution_plan_hash: planHash } = buildExecutionPlan(
    validation.normalized, validation.normalized.base_commit,
  );

  // 触发条件保持一期语义：只有 shell eval 或 setup（任意 shell 字符串）需要单独确认；
  // 纯 argv 的简单模式一行命令即视为启动确认，不追加交互（一期 PRD 4.1.3）。
  const commands = plan.commands
    .filter((c) => c.kind === 'shell')
    .map((c) => ({ label: c.phase === 'setup' ? 'setup' : `eval ${c.id}`, command: c.command }));

  if (commands.length === 0) {
    return {
      ok: true, required: false, commands, plan, execution_plan_hash: planHash,
      approved_execution: { execution_plan_hash: planHash, implicit: true }, message: '',
    };
  }

  const lines = [
    'Goal Spec 含将执行的任意命令，完整 Execution Plan 如下（shell 命令已标注高风险；argv 同样是执行能力）：',
    ...renderExecutionPlan(plan).map((line) => `  ${line}`),
    `  execution_plan_hash: ${planHash}`,
    '确认以上执行计划无误后，加 --allow-shell 重新执行；该确认即批准这份精确计划（approve_execution），计划任何变化都需要重新确认。',
  ];
  return {
    ok: allowShell,
    required: true,
    commands,
    plan,
    execution_plan_hash: planHash,
    approved_execution: allowShell
      ? { execution_plan_hash: planHash, approved_at: new Date().toISOString(), implicit: false }
      : null,
    message: lines.join('\n'),
  };
}
