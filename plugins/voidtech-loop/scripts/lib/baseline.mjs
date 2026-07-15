// 基线 eval：在 base commit 的一次性 detached worktree 中执行 Eval Pack，按角色裁定（PRD 4.1 体检第 4 步）。
// 裁定规则：任一 invariant 不成立 → invariant_broken；全部 target 已成立 → all_targets_met；
// 至少一个 target 未成立且全部 invariant 成立 → startable；任一 eval 超时 → timeout（不得交付可启动结论）。
// 执行与加固逻辑复用 evalrunner/gitops，本文件只保留裁定语义。

import { mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gitRun, removeWorktree } from './gitops.mjs';
import { execEval } from './evalrunner.mjs';

export async function runBaseline(normalizedSpec, { repo, cloneDeps = [] }) {
  const repoPath = resolve(repo ?? '.');
  let worktree = null;

  try {
    const common = gitRun(repoPath, ['rev-parse', '--git-common-dir']);
    if (common.status !== 0) {
      return { verdict: 'infra_error', exitCode: 2, message: `不是 Git 仓库：${repoPath}` };
    }

    const rev = gitRun(repoPath, ['rev-parse', '--verify', '--quiet', `${normalizedSpec.base_commit}^{commit}`]);
    if (rev.status !== 0) {
      return {
        verdict: 'invalid_base',
        exitCode: 1,
        message: `base_commit 无法解析为有效 commit：${normalizedSpec.base_commit}`,
      };
    }
    const baseSha = rev.stdout.trim();

    worktree = mkdtempSync(join(tmpdir(), 'goal-spec-baseline-'));
    const add = gitRun(repoPath, ['worktree', 'add', '--detach', '--force', worktree, baseSha]);
    if (add.status !== 0) {
      return { verdict: 'infra_error', exitCode: 2, message: `创建验收 worktree 失败：${add.stderr.trim()}` };
    }

    for (const dep of cloneDeps) {
      const src = join(repoPath, dep);
      if (!existsSync(src)) continue;
      // APFS clonefile；非 APFS 或跨卷时退化为普通拷贝
      const clone = spawnSync('cp', ['-c', '-R', src, join(worktree, dep)], { encoding: 'utf8' });
      if (clone.status !== 0) {
        spawnSync('cp', ['-R', src, join(worktree, dep)], { encoding: 'utf8' });
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
  } finally {
    if (worktree) removeWorktree(repoPath, worktree);
  }
}
