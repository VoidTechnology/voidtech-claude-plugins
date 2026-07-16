// eval runner（PRD F6 / 4.2.5–7）：在 candidate SHA 的一次性 detached worktree 中执行 Eval Pack，
// 产生截断且绑定 SHA 的硬证据。执行器同时被 baseline 复用——超时与进程组清理逻辑只存在这一份。
// 证据协议（技术设计 §5/PRD 4.2.7）：每条流保存前 256KiB + 后 256KiB + 总字节数 + 完整流 SHA-256；
// 注入 worker 的规范化摘要每条 eval 不超过 8KiB、总量由控制器约束在 32KiB 内。

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveCommit, withEphemeralWorktree } from './gitops.mjs';

const HEAD_CAP = 256 * 1024;
const TAIL_CAP = 256 * 1024;
const PER_EVAL_SUMMARY_CAP = 8 * 1024;
export const WORKER_SUMMARY_TOTAL_CAP = 32 * 1024;
// captureStdout 的完整 stdout 上限：worker 的 --output-format json 必须整体可解析，
// 8KiB 摘要截断会让大 result 字段恒解析失败（M2）；超过此上限同样按解析失败降级为 unavailable。
const CAPTURE_STDOUT_CAP = 8 * 1024 * 1024;
// 每条 setup 命令的固定超时（P0-3）：覆盖常见依赖安装（npm ci 等）；spec 不提供 per-setup 超时字段。
export const SETUP_TIMEOUT_SECONDS = 900;

// 子进程环境白名单（技术设计 §4）：凭据类环境变量不继承，eval 断开全局 git 配置。
export function whitelistEnv() {
  const out = { TERM: 'dumb', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

export async function runEvalPack(normalizedSpec, { repo, candidateSha, goalHash, evidenceDir, cloneDeps = [], shouldStop = null, deadlineAt = null }) {
  const resolved = resolveCommit(repo, candidateSha);
  if (!resolved.ok) {
    return { passed: false, error: 'invalid_candidate', message: `candidate 不是有效 commit：${candidateSha}` };
  }
  const sha = resolved.sha;
  const ephemeral = await withEphemeralWorktree(repo, sha, {
    prefix: 'loop-verify-', cloneDeps,
  }, async (worktree) => {
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

    // setup（P0-3）：一次性 worktree 从 candidate 干净检出，spec.setup 先补齐运行依赖；
    // 失败按 setup_failed 上报——环境没准备好必须与“目标未满足”区分，不得混入 eval 裁定。
    if (normalizedSpec.setup?.length) {
      const setup = await runSetup(normalizedSpec.setup, worktree, {
        evidenceDir, candidateSha: sha, goalHash, shouldStop, deadlineAt,
      });
      if (!setup.ok) {
        return { passed: false, error: setup.canceled ? 'canceled' : 'setup_failed', message: setup.message };
      }
    }

    const results = [];
    for (const evalDef of normalizedSpec.evals) {
      if (shouldStop?.()) {
        return { passed: false, error: 'canceled', message: '收到取消信号，Eval Pack 提前终止' };
      }
      results.push(await execEval(evalDef, worktree, { evidenceDir, candidateSha: sha, goalHash, shouldStop, deadlineAt }));
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
  });
  if (!ephemeral.ok) {
    return { passed: false, error: 'worktree_failed', message: ephemeral.message };
  }
  return ephemeral.value;
}

// setup 命令执行（P0-3）：spec.setup 依次以 shell 在 worktree 内执行，用于补齐一次性检出缺失的依赖。
// 复用 execEval 的超时、进程组清理与证据协议；任一命令非零退出即失败，环境错误不得混入 eval 裁定。
export async function runSetup(commands, worktree, { evidenceDir = null, candidateSha = null, goalHash = null, shouldStop = null, deadlineAt = null } = {}) {
  for (const [idx, command] of commands.entries()) {
    if (shouldStop?.()) return { ok: false, canceled: true, message: '收到取消信号，setup 提前终止' };
    const evalDef = {
      id: `setup-${idx + 1}`,
      role: 'setup',
      command,
      shell: true,
      cwd: '.',
      expected_exit: 0,
      timeout_seconds: SETUP_TIMEOUT_SECONDS,
      repeat: 1,
    };
    const result = await execEval(evalDef, worktree, { evidenceDir, candidateSha, goalHash, shouldStop, deadlineAt });
    if (!result.pass) {
      return {
        ok: false,
        canceled: result.runs.some((r) => r.canceled) || Boolean(shouldStop?.()),
        message: `setup 命令失败（${command}）：${result.summary.slice(0, 512)}`,
      };
    }
  }
  return { ok: true };
}

// 执行单条 eval（含 repeat）；baseline 与 setup 也走这里。
// env：默认凭据清理白名单（eval/setup 跑不可信代码）；worker 调用传入继承环境（claude -p 需认证）。
// captureStdout：worker 调用需要完整 stdout 解析 --output-format json（M2），常规 eval 不开启。
// shouldStop：轮询到 true 时主动终止 in-flight 子进程组，使 cancel 及时生效（L2/P0-2）。
// deadlineAt：run 级墙钟截止时间戳（ms）；单次执行超时取 min(eval 超时, 剩余墙钟)，到点即截断（P0-2）。
export async function execEval(evalDef, worktree, { evidenceDir = null, candidateSha = null, goalHash = null, env = null, captureStdout = false, shouldStop = null, deadlineAt = null } = {}) {
  const runEnv = env ?? whitelistEnv();
  const runs = [];
  for (let n = 1; n <= evalDef.repeat; n++) {
    if (n > 1 && shouldStop?.()) break;
    const run = await runOnce(evalDef, worktree, runEnv, captureStdout, shouldStop, deadlineAt);
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
    if (run.timed_out || run.canceled) break;
  }
  const pass = runs.length === evalDef.repeat && runs.every((r) => !r.timed_out && !r.canceled && r.exit === evalDef.expected_exit);
  const summary = buildSummary(evalDef, runs);
  const stdout = captureStdout ? (runs[runs.length - 1].stdout ?? '') : undefined;
  for (const r of runs) {
    delete r.stream; // 原始缓冲不进状态与报告
    delete r.stdout;
  }
  const result = {
    id: evalDef.id,
    role: evalDef.role,
    expected_exit: evalDef.expected_exit,
    runs,
    pass,
    timed_out: runs.some((r) => r.timed_out),
    summary,
  };
  if (captureStdout) result.stdout = stdout;
  return result;
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
    ? `${run.stream.headText()}\n\n===== TRUNCATED: ${Math.max(0, run.stream.total - run.stream.head.length - run.stream.tail.length)} bytes omitted =====\n\n${run.stream.tailText()}`
    : run.stream.headText();
  writeFileSync(path, header + body);
}

function runOnce(evalDef, worktree, runEnv, captureStdout = false, shouldStop = null, deadlineAt = null) {
  return new Promise((resolvePromise) => {
    const cwd = join(worktree, evalDef.cwd);
    const [cmd, args] = evalDef.shell
      ? ['/bin/bash', ['-c', evalDef.command]]
      : [evalDef.command[0], evalDef.command.slice(1)];

    // 墙钟硬上限（P0-2）：单次执行超时取 min(eval 超时, 剩余墙钟)；deadline 已过则不启动子进程
    const timeoutMs = deadlineAt === null
      ? evalDef.timeout_seconds * 1000
      : Math.min(evalDef.timeout_seconds * 1000, deadlineAt - Date.now());
    if (timeoutMs <= 0) {
      const stream = makeStreamCapture();
      stream.finalize();
      resolvePromise({ exit: null, signal: null, duration_ms: 0, timed_out: true, deadline_exceeded: true, canceled: false, stream, stdout: captureStdout ? '' : undefined });
      return;
    }

    const stream = makeStreamCapture();
    // 与 head/tail 截断证据分离：captureStdout 单独保留完整 stdout（不混入 stderr），供 JSON 整体解析
    const stdoutChunks = captureStdout ? [] : null;
    let stdoutBytes = 0;
    const fullStdout = () => (stdoutChunks ? Buffer.concat(stdoutChunks).toString('utf8') : undefined);
    const started = Date.now();
    // spawn 失败时 Node 会先后发出 'error' 与 'close' 两个事件：finalize/resolve 必须幂等，
    // 否则第二次 digest 抛 ERR_CRYPTO_HASH_FINALIZED 成为 uncaughtException（M5 spike 发现）。
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      stream.finalize();
      resolvePromise(payload);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: runEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      settle({ exit: null, signal: null, duration_ms: 0, timed_out: false, spawn_error: String(err), stream, stdout: fullStdout() });
      return;
    }

    child.stdout.on('data', (chunk) => {
      stream.push(chunk);
      if (stdoutChunks && stdoutBytes < CAPTURE_STDOUT_CAP) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', stream.push);

    let timedOut = false;
    let deadlineExceeded = false;
    let canceled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      deadlineExceeded = deadlineAt !== null && timeoutMs < evalDef.timeout_seconds * 1000;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 组可能已退出 */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ }
      }, 2000).unref();
    }, timeoutMs);

    // cancel 轮询：worker 长时间运行期间收到 stop 请求时，及时终止其进程组（L2）
    const stopPoll = shouldStop
      ? setInterval(() => {
        if (!shouldStop()) return;
        canceled = true;
        clearInterval(stopPoll);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 组可能已退出 */ }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ }
        }, 2000).unref();
      }, 300)
      : null;
    stopPoll?.unref?.();

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (stopPoll) clearInterval(stopPoll);
      settle({ exit: null, signal: null, duration_ms: Date.now() - started, timed_out: false, canceled, spawn_error: String(err), stream, stdout: fullStdout() });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (stopPoll) clearInterval(stopPoll);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 残留兜底 */ }
      settle({ exit: code, signal, duration_ms: Date.now() - started, timed_out: timedOut, deadline_exceeded: deadlineExceeded, canceled, stream, stdout: fullStdout() });
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
      // head 装不下即截断；(HEAD_CAP, HEAD_CAP+TAIL_CAP] 区间 head/tail 有重叠，但尾部不得静默丢弃
      state.truncated = state.total > HEAD_CAP;
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
