// 基线 eval：在 base commit 的一次性 detached worktree 中执行 Eval Pack，按角色裁定（PRD 4.1 体检第 4 步）。
// 裁定规则：任一 invariant 不成立 → invariant_broken；全部 target 已成立 → all_targets_met；
// 至少一个 target 未成立且全部 invariant 成立 → startable；任一 eval 超时 → timeout（不得交付可启动结论）。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// 控制器与 eval 的加固 Git 配置（技术设计 §6）：防止仓库内配置借我们权限执行代码。
function hardenedGitArgs(emptyHooksDir) {
  return [
    '-c', 'core.fsmonitor=',
    '-c', `core.hooksPath=${emptyHooksDir}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
  ];
}

// 子进程环境白名单（技术设计 §4）：eval 额外断开全局 git 配置，切断 keychain credential helper。
function whitelistEnv() {
  const out = { TERM: 'dumb', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function git(repo, args, emptyHooksDir) {
  const res = spawnSync('git', ['-C', repo, ...hardenedGitArgs(emptyHooksDir), ...args], {
    encoding: 'utf8',
    env: whitelistEnv(),
  });
  return res;
}

export async function runBaseline(normalizedSpec, { repo, cloneDeps = [] }) {
  const repoPath = resolve(repo ?? '.');
  const emptyHooksDir = mkdtempSync(join(tmpdir(), 'goal-spec-hooks-'));
  let worktree = null;

  try {
    const common = git(repoPath, ['rev-parse', '--git-common-dir'], emptyHooksDir);
    if (common.status !== 0) {
      return { verdict: 'infra_error', exitCode: 2, message: `不是 Git 仓库：${repoPath}` };
    }

    const rev = git(repoPath, ['rev-parse', '--verify', '--quiet', `${normalizedSpec.base_commit}^{commit}`], emptyHooksDir);
    if (rev.status !== 0) {
      return {
        verdict: 'invalid_base',
        exitCode: 1,
        message: `base_commit 无法解析为有效 commit：${normalizedSpec.base_commit}`,
      };
    }
    const baseSha = rev.stdout.trim();

    worktree = mkdtempSync(join(tmpdir(), 'goal-spec-baseline-'));
    const add = git(repoPath, ['worktree', 'add', '--detach', '--force', worktree, baseSha], emptyHooksDir);
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
      const result = await runEval(evalDef, worktree);
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
    if (worktree) {
      git(resolve(repo ?? '.'), ['worktree', 'remove', '--force', worktree], emptyHooksDir);
      git(resolve(repo ?? '.'), ['worktree', 'prune'], emptyHooksDir);
      rmSync(worktree, { recursive: true, force: true });
    }
    rmSync(emptyHooksDir, { recursive: true, force: true });
  }
}

async function runEval(evalDef, worktree) {
  const runs = [];
  for (let n = 0; n < evalDef.repeat; n++) {
    runs.push(await runOnce(evalDef, worktree));
    if (runs[runs.length - 1].timed_out) break;
  }
  const pass = runs.every((r) => !r.timed_out && r.exit === evalDef.expected_exit);
  return {
    id: evalDef.id,
    role: evalDef.role,
    expected_exit: evalDef.expected_exit,
    runs,
    pass,
    timed_out: runs.some((r) => r.timed_out),
  };
}

const OUTPUT_CAP = 32 * 1024;

function runOnce(evalDef, worktree) {
  return new Promise((resolvePromise) => {
    const cwd = join(worktree, evalDef.cwd);
    const [cmd, args] = evalDef.shell
      ? ['/bin/bash', ['-c', evalDef.command]]
      : [evalDef.command[0], evalDef.command.slice(1)];

    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: whitelistEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({ exit: null, signal: null, duration_ms: 0, timed_out: false, spawn_error: String(err) });
      return;
    }

    let tail = '';
    const collect = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 进程组可能已退出 */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ }
      }, 2000).unref();
    }, evalDef.timeout_seconds * 1000);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolvePromise({ exit: null, signal: null, duration_ms: Date.now() - started, timed_out: false, spawn_error: String(err) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 残留子进程兜底，组已退出则忽略 */ }
      resolvePromise({
        exit: code,
        signal,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        output_tail: tail.slice(-4096),
      });
    });
  });
}
