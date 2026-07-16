// Review 资产保留与 GC（二期 Task 5.6）。原则：保守删除，finalized 事实永不自动删。
// 保留规则：
//   - finalized Decision Record / committed Revision·Supplemental Bundle：永不自动 GC；
//   - prepared/committed operation journal：保留（恢复与审计依赖）；
//   - draft / approval / proposal：保留（体积小，未决 exact retry 与审计依赖）；
//   - staging：slot 已被 committed 占用 → 立即可删；slot 空闲时仅删超过 TTL 的崩溃残留；
//   - fact pack：run 已决后，删除未被任何 proposal 审计引用的；未决 run 全保留；
//   - delegation grant：仅删"已过期且未被任何 operation 引用"的；有效或已消费的不删；
//   - 一次性 snapshot worktree：正常路径由 session finally 清理；本模块只扫超 TTL 的孤儿。
// 卸载语义（与一期固定声明一致）：全部审计资产存于插件数据目录，卸载插件一并删除；
// GC 与卸载都绝不触碰业务仓库或旧 run 的执行事实（state/evidence/report 不在清理范围）。

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withRunReviewLock } from './runreviewlock.mjs';
import { runDir, decisionsDir, committedDir, reviewsDir, delegationGrantPath } from './reviewstore.mjs';
import { readCommittedDecision } from './decisionstore.mjs';
import { listOperations } from './reviewoperation.mjs';
import { gitRun } from './gitops.mjs';

const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

function ageMs(path, now) {
  try {
    return now.getTime() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// 同一 run 的 staging GC 必须持 run review lock（与决策提交/恢复互斥）。
export async function gcRunReviewAssets(projectDir, runId, { now = new Date(), stagingTtlMs = STAGING_TTL_MS } = {}) {
  const locked = await withRunReviewLock(runDir(projectDir, runId), `gc-${randomBytes(4).toString('hex')}`, async () => {
    const removed = [];
    const kept = [];
    const committed = readCommittedDecision(projectDir, runId);
    const decided = committed.ok && committed.exists;

    // staging：committed 已占 slot → 残留一律可删；否则仅删超 TTL 的崩溃残留
    const stagingRoot = join(decisionsDir(projectDir, runId), 'staging');
    if (existsSync(stagingRoot)) {
      for (const name of readdirSync(stagingRoot)) {
        const path = join(stagingRoot, name);
        if (decided || ageMs(path, now) > stagingTtlMs) {
          rmSync(path, { recursive: true, force: true });
          removed.push(`staging/${name}`);
        } else {
          kept.push(`staging/${name}`);
        }
      }
    }

    // fact pack：已决 run 才清理，且只删未被任何 proposal 审计引用的
    const packsRoot = join(reviewsDir(projectDir, runId), 'fact-packs');
    if (decided && existsSync(packsRoot)) {
      const referenced = referencedFactPackIds(projectDir, runId);
      for (const packId of readdirSync(packsRoot)) {
        if (referenced.has(packId)) {
          kept.push(`fact-packs/${packId}`);
        } else {
          rmSync(join(packsRoot, packId), { recursive: true, force: true });
          removed.push(`fact-packs/${packId}`);
        }
      }
    }

    // operation journal / draft / approval / proposal / committed：一律保留
    kept.push(...listOperations(projectDir, runId).filter((e) => e.ok).map((e) => `operations/${e.operation_id}`));
    if (existsSync(committedDir(projectDir, runId))) kept.push('committed');
    return { removed, kept };
  });
  if (!locked.ok) return { ok: false, reason: `review_lock_${locked.reason}` };
  return { ok: true, ...locked.result };
}

function referencedFactPackIds(projectDir, runId) {
  const out = new Set();
  const proposalsDir = join(reviewsDir(projectDir, runId), 'proposals');
  if (!existsSync(proposalsDir)) return out;
  for (const name of readdirSync(proposalsDir).filter((n) => n.endsWith('.audit.json'))) {
    try {
      const audit = JSON.parse(readFileSync(join(proposalsDir, name), 'utf8'));
      if (audit.fact_pack_id) out.add(audit.fact_pack_id);
    } catch {
      // 损坏审计不作为删除依据：保守保留全部
      return new Set(['__keep_all__', ...listAllPacks(projectDir, runId)]);
    }
  }
  return out;
}

function listAllPacks(projectDir, runId) {
  const packsRoot = join(reviewsDir(projectDir, runId), 'fact-packs');
  return existsSync(packsRoot) ? readdirSync(packsRoot) : [];
}

// grant GC：只删"已过期且未被任何 run 的 operation 引用"的授权；有效或已消费的一律保留。
export function gcDelegationGrants(projectDir, { now = new Date() } = {}) {
  const grantsDir = join(projectDir, 'delegation-grants');
  if (!existsSync(grantsDir)) return { ok: true, removed: [], kept: [] };

  const referenced = new Set();
  const runsDir = join(projectDir, 'runs');
  const runIds = existsSync(runsDir) ? readdirSync(runsDir) : [];
  for (const runId of runIds) {
    for (const entry of listOperations(projectDir, runId)) {
      if (entry.ok && entry.operation.grant?.grant_id) referenced.add(entry.operation.grant.grant_id);
    }
  }

  const removed = [];
  const kept = [];
  for (const name of readdirSync(grantsDir).filter((n) => n.endsWith('.json'))) {
    const grantId = name.slice(0, -'.json'.length);
    const path = delegationGrantPath(projectDir, grantId);
    let grant;
    try {
      grant = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      kept.push(grantId); // 损坏文件不自动删：留给人排障
      continue;
    }
    const expired = new Date(grant.expires_at).getTime() <= now.getTime();
    if (expired && !referenced.has(grantId)) {
      rmSync(path, { force: true });
      removed.push(grantId);
    } else {
      kept.push(grantId);
    }
  }
  return { ok: true, removed, kept };
}

// 孤儿 snapshot worktree：正常由 review session 的 finally 清理；这里只扫超 TTL 的崩溃残留。
// 活动 session 的 snapshot 不会超 TTL（review 单次上限 5 分钟），故"无活动 retrieval 后才清理"由 TTL 保证。
export function sweepOrphanSnapshots({ repo = null, now = new Date(), ttlMs = SNAPSHOT_TTL_MS } = {}) {
  const removed = [];
  const kept = [];
  for (const name of readdirSync(tmpdir()).filter((n) => n.startsWith('loop-review-snapshot-'))) {
    const path = join(tmpdir(), name);
    if (ageMs(path, now) > ttlMs) {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } else {
      kept.push(name);
    }
  }
  // worktree 元数据清理只影响 .git/worktrees 管理区，不触碰业务文件
  if (repo && removed.length > 0) gitRun(repo, ['worktree', 'prune']);
  return { ok: true, removed, kept };
}
