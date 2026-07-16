// Canonical Execution Plan（二期技术设计 §5.1，Task 3.1，P2-04）。
// shell 与 argv 都是执行能力：plan 由 normalized Goal Spec 单源派生，不落第二份可漂移的
// 持久化命令定义——持久化的只有 execution_plan_hash，视图按需重新派生展示给用户确认。
// policy 字段是可验证的授权意图，取值如实反映一期 runner 的 best-effort 现状，
// 不得伪装成 OS 级隔离（§5.1：不能把"声明 denied"当成"已经隔离"）。

import { artifactHash } from './reviewstore.mjs';
import { SETUP_TIMEOUT_SECONDS } from './evalrunner.mjs';

// 一期 runner 的真实执行策略（whitelistEnv/withEphemeralWorktree/无网络阻断）。
// 变更 runner 语义时必须同步这里——它们进入 plan hash，是授权的一部分。
const RUNNER_POLICIES = {
  environment_policy: 'credential_stripped_whitelist',
  network_policy: 'best_effort_not_denied',
  filesystem_policy: 'ephemeral_candidate_worktree_best_effort',
};

// 从 normalized spec（v1/v2 均可）与执行目标 commit 派生 canonical plan。
// 覆盖顺序、phase、id、kind、executable/args 或 shell 原文、cwd、timeout、expected exit、
// repeat、执行策略与 commit；任一执行语义变化都改变 execution_plan_hash。
export function buildExecutionPlan(normalizedSpec, commit) {
  const commands = [];
  for (const [idx, command] of (normalizedSpec.setup ?? []).entries()) {
    commands.push({
      phase: 'setup',
      id: `setup-${idx + 1}`,
      kind: 'shell',
      command,
      cwd: '.',
      timeout_seconds: SETUP_TIMEOUT_SECONDS,
      expected_exit: 0,
      repeat: 1,
      ...RUNNER_POLICIES,
    });
  }
  for (const evalDef of normalizedSpec.evals) {
    const shell = evalDef.shell === true;
    commands.push({
      phase: 'eval',
      id: evalDef.id,
      kind: shell ? 'shell' : 'argv',
      ...(shell
        ? { command: evalDef.command }
        : { executable: evalDef.command[0], args: evalDef.command.slice(1) }),
      cwd: evalDef.cwd,
      timeout_seconds: evalDef.timeout_seconds,
      expected_exit: evalDef.expected_exit,
      repeat: evalDef.repeat,
      ...RUNNER_POLICIES,
    });
  }
  const plan = { schema_version: 1, candidate_commit: commit, commands };
  return { plan, execution_plan_hash: artifactHash(plan) };
}

// 供确认门与审批界面渲染：一行一命令，shell 额外标注高风险（argv 同样需要授权，只是不加注）。
export function renderExecutionPlan(plan) {
  const lines = [];
  for (const c of plan.commands) {
    const cmd = c.kind === 'shell' ? c.command : [c.executable, ...c.args].join(' ');
    const risk = c.kind === 'shell' ? '（shell，经 /bin/sh 解析，高风险）' : '';
    lines.push(`[${c.phase}] ${c.id}: ${cmd}${risk}　cwd=${c.cwd} timeout=${c.timeout_seconds}s repeat=${c.repeat}`);
  }
  return lines;
}
