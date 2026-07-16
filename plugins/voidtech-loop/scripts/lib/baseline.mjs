// 基线 eval：在 base commit 的一次性 detached worktree 中执行 Eval Pack，按角色裁定（PRD 4.1 体检第 4 步）。
// 裁定规则：任一 invariant 不成立 → invariant_broken；全部 target 已成立 → all_targets_met；
// 至少一个 target 未成立且全部 invariant 成立 → startable；任一 eval 超时 → timeout（不得交付可启动结论）。
// 执行与加固逻辑复用 evalrunner/gitops，本文件只保留裁定语义。

import { resolve } from 'node:path';
import { gitCommonDir, resolveCommit, withEphemeralWorktree } from './gitops.mjs';
import { execEval, runSetup } from './evalrunner.mjs';

export async function runBaseline(normalizedSpec, { repo, cloneDeps = [] }) {
  const repoPath = resolve(repo ?? '.');
  if (!gitCommonDir(repoPath)) {
    return { verdict: 'infra_error', exitCode: 2, message: `不是 Git 仓库：${repoPath}` };
  }
  const resolved = resolveCommit(repoPath, normalizedSpec.base_commit);
  if (!resolved.ok) {
    return {
      verdict: 'invalid_base',
      exitCode: 1,
      message: `base_commit 无法解析为有效 commit：${normalizedSpec.base_commit}`,
    };
  }
  const baseSha = resolved.sha;
  const ephemeral = await withEphemeralWorktree(repoPath, baseSha, {
    prefix: 'goal-spec-baseline-', cloneDeps,
  }, async (worktree) => {
    // setup（P0-3）：基线 worktree 同样是干净检出，先补齐依赖再裁定；环境失败按 infra_error 上报
    if (normalizedSpec.setup?.length) {
      const setup = await runSetup(normalizedSpec.setup, worktree);
      if (!setup.ok) {
        return { verdict: 'infra_error', exitCode: 2, base_commit: baseSha, message: `基线环境 setup 失败：${setup.message}` };
      }
    }

    const results = [];
    for (const evalDef of normalizedSpec.evals) {
      const result = await execEval(evalDef, worktree);
      results.push(result);
      if (result.timed_out) {
        return {
          verdict: 'timeout',
          exitCode: 5,
          base_commit: baseSha,
          results,
          message: `eval ${evalDef.id} 超时（${evalDef.timeout_seconds}s），不得交付可启动结论`,
        };
      }
    }

    const brokenInvariants = results.filter((r) => r.role === 'invariant' && !r.pass);
    const unmetTargets = results.filter((r) => r.role === 'target' && !r.pass);

    if (brokenInvariants.length > 0) {
      return {
        verdict: 'invariant_broken',
        exitCode: 4,
        base_commit: baseSha,
        results,
        message: `invariant 在基线不成立：${brokenInvariants.map((r) => r.id).join('、')}；请改为 target 或先修复基线`,
      };
    }
    if (unmetTargets.length === 0) {
      return {
        verdict: 'all_targets_met',
        exitCode: 3,
        base_commit: baseSha,
        results,
        message: '全部 target 在基线已满足；目标已达成，建议直接检查现状而非启动循环',
      };
    }
    return {
      verdict: 'startable',
      exitCode: 0,
      base_commit: baseSha,
      results,
      message: `可启动：${unmetTargets.length} 个 target 未满足，全部 invariant 成立`,
    };
  });
  if (!ephemeral.ok) {
    return { verdict: 'infra_error', exitCode: 2, message: `创建验收 worktree 失败：${ephemeral.message}` };
  }
  return ephemeral.value;
}
