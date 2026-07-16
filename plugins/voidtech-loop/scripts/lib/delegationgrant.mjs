// Delegation Grant 存储与机械判定原语（二期技术设计 §5.2/§10，Task 3.2）。
// grant 在 reviewer 启动前冻结、之后只读；Decision Record 与 Feedback Pack 只引用
// grant ID/hash，不复制授权内容。expiration 只在 claim 时刻检查一次：claim 成功后
// （operation journal 已记录 grant 引用），恢复同一 operation 不再受过期约束，
// 长验证不会被中途作废；one-shot 消费以 operation journal 为事实来源。

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './statestore.mjs';
import { delegationGrantPath, validateReviewArtifact, artifactHash } from './reviewstore.mjs';
import { listOperations } from './reviewoperation.mjs';
import { decisionIdempotencyKey } from './decisionstore.mjs';

// 一期 runner 的真实网络能力：无法机械执行 denied（见 executionplan.mjs 策略常量）。
const RUNNER_NETWORK_CAPABILITY = 'best_effort_not_denied';

export function createDelegationGrant(projectDir, grant) {
  const validation = validateReviewArtifact('delegation_grant', grant);
  if (!validation.ok) return { ok: false, reason: 'invalid_grant', errors: validation.errors };
  const path = delegationGrantPath(projectDir, grant.grant_id);
  if (existsSync(path)) return { ok: false, reason: 'grant_exists' };
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(grant, null, 2));
  return { ok: true, grant, grant_hash: artifactHash(grant) };
}

export function readDelegationGrant(projectDir, grantId) {
  const path = delegationGrantPath(projectDir, grantId);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let grant;
  try {
    grant = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const validation = validateReviewArtifact('delegation_grant', grant);
  if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
  return { ok: true, grant, grant_hash: artifactHash(grant) };
}

// claim 判定（调用方须持 run review lock）：
// - matching operation（相同幂等键且引用同一 grant）→ 恢复，不是第二次消费，不再查过期；
// - 其他 operation 已引用该 grant → one-shot 已被消费，拒绝；
// - 无任何引用 → 首次 claim：检查 run 匹配与 expires_at（唯一一次过期检查）。
export function evaluateGrantClaim(projectDir, runId, grant, { decision, now = new Date() }) {
  if (grant.run_id !== runId) return { ok: false, reason: 'wrong_run' };
  const key = decisionIdempotencyKey(decision);
  const referencing = listOperations(projectDir, runId)
    .filter((e) => e.ok && e.operation.grant?.grant_id === grant.grant_id)
    .map((e) => e.operation);

  const matching = referencing.find((op) => decisionIdempotencyKey(op.decision_payload.decision) === key);
  if (matching) return { ok: true, recovery: true, operation: matching };
  if (referencing.length > 0) return { ok: false, reason: 'grant_consumed', by: referencing[0].operation_id };

  if (new Date(grant.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'grant_expired' };
  }
  return { ok: true, recovery: false };
}

export function checkOutcomeAllowed(grant, outcome) {
  return grant.scope.outcomes.includes(outcome)
    ? { ok: true }
    : { ok: false, reason: 'outcome_not_allowed', escalate: true };
}

// exact plan gate（§5.2/§10 规则 8-9）：argv 与 shell 走同一判定；
// 只有"规范化字节未变的父 plan + inherit_parent_plans"或"精确列于 allowed_plan_hashes"
// 两条通过路径；不支持任何模式匹配。limits 与网络能力越界一律升级。
export function checkPlanAgainstGrant(grant, { plan, planHash, parentPlanHash }) {
  const inherited = planHash === parentPlanHash && grant.execution.inherit_parent_plans === true;
  const listed = grant.execution.allowed_plan_hashes.includes(planHash);
  if (!inherited && !listed) {
    return { ok: false, reason: 'plan_not_authorized', escalate: true };
  }
  if (plan.commands.length > grant.limits.max_commands) {
    return { ok: false, reason: 'too_many_commands', escalate: true };
  }
  const totalSeconds = plan.commands.reduce((sum, c) => sum + c.timeout_seconds * c.repeat, 0);
  if (totalSeconds > grant.limits.max_total_seconds) {
    return { ok: false, reason: 'total_timeout_exceeded', escalate: true };
  }
  // 声明 denied 不等于已隔离：runner 无法机械执行 denied 时必须升级（§5.1）
  if (grant.limits.network === 'denied' && RUNNER_NETWORK_CAPABILITY !== 'denied') {
    return { ok: false, reason: 'network_policy_unsupported', escalate: true };
  }
  return { ok: true, inherited, listed };
}
