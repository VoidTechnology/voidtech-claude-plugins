// eval runner（PRD F6 / 4.2.5–7）：在 candidate SHA 的一次性 detached worktree 中执行 Eval Pack，
// 产生截断且绑定 SHA 的硬证据。执行器同时被 baseline 复用——超时与进程组清理逻辑只存在这一份。
// 证据协议（技术设计 §5/PRD 4.2.7）：每条流保存前 256KiB + 后 256KiB + 总字节数 + 完整流 SHA-256；
// 注入 worker 的规范化摘要每条 eval 不超过 8KiB、总量由控制器约束在 32KiB 内。

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gitRun, removeWorktree } from './gitops.mjs';

const HEAD_CAP = 256 * 1024;
const TAIL_CAP = 256 * 1024;
const PER_EVAL_SUMMARY_CAP = 8 * 1024;
export const WORKER_SUMMARY_TOTAL_CAP = 32 * 1024;

// 子进程环境白名单（技术设计 §4）：凭据类环境变量不继承，eval 断开全局 git 配置。
export function whitelistEnv() {
  const out = { TERM: 'dumb', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

export async function runEvalPack(normalizedSpec, { repo, candidateSha, goalHash, evidenceDir, cloneDeps = [] }) {
  const rev = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${candidateSha}^{commit}`]);
  if (rev.status !== 0) {
    return { passed: false, error: 'invalid_candidate', message: `candidate 不是有效 commit：${candidateSha}` };
  }
  const sha = rev.stdout.trim();
  const worktree = mkdtempSync(join(tmpdir(), 'loop-verify-'));

  try {
    const add = gitRun(repo, ['worktree', 'add', '--detach', '--force', worktree, sha]);
    if (add.status !== 0) {
      return { passed: false, error: 'worktree_failed', message: add.stderr.trim() };
    }

    for (const dep of cloneDeps) {
      const src = join(repo, dep);
      const clone = spawnSync('cp', ['-c', '-R', src, join(worktree, dep)], { encoding: 'utf8' });
      if (clone.status !== 0) spawnSync('cp', ['-R', src, join(worktree, dep)], { encoding: 'utf8' });
    }

    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    const results = [];
    for (const evalDef of normalizedSpec.evals) {
      results.push(await execEval(evalDef, worktree, { evidenceDir, candidateSha: sha, goalHash }));
    }

    const failed = results.filter((r) => !r.pass);
    return {
      passed: failed.length === 0,
      candidate_sha: sha,
      goal_hash: goalHash,
      worktree,
      results,
      failed,
    };
  } finally {
    removeWorktree(repo, worktree);
  }
}

// 执行单条 eval（含 repeat）；baseline 也走这里。
// env：默认凭据清理白名单（eval 跑不可信代码）；worker 调用传入继承环境（claude -p 需认证）。
export async function execEval(evalDef, worktree, { evidenceDir = null, candidateSha = null, goalHash = null, env = null } = {}) {
  const runEnv = env ?? whitelistEnv();
  const runs = [];
  for (let n = 1; n <= evalDef.repeat; n++) {
    const run = await runOnce(evalDef, worktree, runEnv);
    if (evidenceDir) {
      const path = join(evidenceDir, `${evalDef.id}-run${n}.log`);
      writeEvidenceFile(path, evalDef, run, n, { candidateSha, goalHash });
      run.evidence = {
        path,
        total_bytes: run.stream.total,
        sha256: run.stream.sha256,
        truncated: run.stream.truncated,
      };
    }
    runs.push(run);
    if (run.timed_out) break;
  }
  const pass = runs.length === evalDef.repeat && runs.every((r) => !r.timed_out && r.exit === evalDef.expected_exit);
  const summary = buildSummary(evalDef, runs);
  for (const r of runs) delete r.stream; // 原始缓冲不进状态与报告
  return {
    id: evalDef.id,
    role: evalDef.role,
    expected_exit: evalDef.expected_exit,
    runs,
    pass,
    timed_out: runs.some((r) => r.timed_out),
    summary,
  };
}

function buildSummary(evalDef, runs) {
  const last = runs[runs.length - 1];
  const status = last.timed_out
    ? `timeout>${evalDef.timeout_seconds}s`
    : last.spawn_error
      ? `spawn_error:${last.spawn_error}`
      : `exit=${last.exit}`;
  const cleanedTail = stripNoise(last.stream?.summaryText() ?? '');
  const budget = PER_EVAL_SUMMARY_CAP - 256;
  const text = `[${evalDef.id}] ${status} expected_exit=${evalDef.expected_exit} duration_ms=${last.duration_ms}\n${cleanedTail.slice(-budget)}`;
  return text.slice(-PER_EVAL_SUMMARY_CAP);
}

// 剥离 ANSI 与时间戳类噪声（技术设计 §5 的通用退化摘要）
function stripNoise(s) {
  return s
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>');
}

function writeEvidenceFile(path, evalDef, run, runNo, { candidateSha, goalHash }) {
  const header = [
    `# eval: ${evalDef.id} (run ${runNo}/${evalDef.repeat})`,
    `# candidate_commit: ${candidateSha ?? 'n/a'}`,
    `# goal_hash: ${goalHash ?? 'n/a'}`,
    `# command: ${evalDef.shell ? evalDef.command : JSON.stringify(evalDef.command)}`,
    `# exit: ${run.timed_out ? 'timeout' : run.exit} expected: ${evalDef.expected_exit} duration_ms: ${run.duration_ms}`,
    `# total_bytes: ${run.stream.total} sha256: ${run.stream.sha256}`,
    '',
  ].join('\n');
  const body = run.stream.truncated
    ? `${run.stream.headText()}\n\n===== TRUNCATED: ${run.stream.total - run.stream.head.length - run.stream.tail.length} bytes omitted =====\n\n${run.stream.tailText()}`
    : run.stream.headText();
  writeFileSync(path, header + body);
}

function runOnce(evalDef, worktree, runEnv) {
  return new Promise((resolvePromise) => {
    const cwd = join(worktree, evalDef.cwd);
    const [cmd, args] = evalDef.shell
      ? ['/bin/bash', ['-c', evalDef.command]]
      : [evalDef.command[0], evalDef.command.slice(1)];

    const stream = makeStreamCapture();
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: runEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      stream.finalize();
      resolvePromise({ exit: null, signal: null, duration_ms: 0, timed_out: false, spawn_error: String(err), stream });
      return;
    }

    child.stdout.on('data', stream.push);
    child.stderr.on('data', stream.push);

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 组可能已退出 */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ }
      }, 2000).unref();
    }, evalDef.timeout_seconds * 1000);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      stream.finalize();
      resolvePromise({ exit: null, signal: null, duration_ms: Date.now() - started, timed_out: false, spawn_error: String(err), stream });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 残留兜底 */ }
      stream.finalize();
      resolvePromise({ exit: code, signal, duration_ms: Date.now() - started, timed_out: timedOut, stream });
    });
  });
}

// 流式截断捕获：前 256KiB + 后 256KiB 环 + 总字节 + 全流 SHA-256；超限直接丢弃，不建磁盘预算系统。
function makeStreamCapture() {
  const hash = createHash('sha256');
  const state = {
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    total: 0,
    sha256: null,
    truncated: false,
    push(chunk) {
      hash.update(chunk);
      state.total += chunk.length;
      if (state.head.length < HEAD_CAP) {
        state.head = Buffer.concat([state.head, chunk]).subarray(0, HEAD_CAP);
      }
      state.tail = Buffer.concat([state.tail, chunk]);
      if (state.tail.length > TAIL_CAP) {
        state.tail = state.tail.subarray(state.tail.length - TAIL_CAP);
      }
    },
    finalize() {
      state.sha256 = hash.digest('hex');
      state.truncated = state.total > HEAD_CAP + TAIL_CAP;
    },
    headText() {
      return state.head.toString('utf8');
    },
    tailText() {
      // 未截断时避免与 head 重复输出
      if (!state.truncated && state.total <= HEAD_CAP) return '';
      return state.tail.toString('utf8');
    },
    // 摘要取材：小输出取全文，大输出取尾部（失败信息通常在尾部）
    summaryText() {
      return state.total <= HEAD_CAP ? state.head.toString('utf8') : state.tail.toString('utf8');
    },
  };
  return state;
}
