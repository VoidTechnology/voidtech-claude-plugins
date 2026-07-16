// loop CLI（PRD F8/F9）：goal（启动，默认 detach 守护进程）、status、cancel、accept。
// 两阶段启动（P0-1）：校验、基线、锁、worktree、初始状态全部在前台完成并回显 run ID；
// 后台控制器经 IPC 握手接管已准备完成的 run，宿主会话关闭不影响循环，运行期中断走 cancel。

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildSimpleSpec } from './lib/simplemode.mjs';
import { parseYaml } from './lib/yaml.mjs';
import { preflight } from './lib/preflight.mjs';
import { validateSpecObject } from './lib/validate.mjs';
import { prepareRun, runPreparedLoop, startLoop, getStatus, cancelRun, acceptRun } from './lib/lifecycle.mjs';
import { updateLockMeta, processIdentity } from './lib/statestore.mjs';
import { gitRun } from './lib/gitops.mjs';

const SELF = fileURLToPath(import.meta.url);
const HANDSHAKE_TIMEOUT_MS = 15_000;

const HELP = `用法：loop <命令> [参数]

  goal "<任务>" --check "<命令>" --max-iterations N [选项]
                              启动简单模式循环（默认后台守护）
  goal --spec <file.yaml>     从 Goal Spec 文件启动
  status [runId]              查看项目锁或指定 run 状态
  cancel <runId>              取消运行中的循环（幂等）
  accept <runId>              将 EVALS_PASSED 的 run 标记为 ACCEPTED

goal 选项：
  --base <commit>             指定 base commit（默认当前 HEAD）
  --max-iterations N          迭代上限（简单模式必填）
  --max-duration S            墙钟秒数上限（默认 3600）
  --allow-shell               确认执行 spec 中的 shell eval 与 setup 命令（安全门）
  --foreground                前台运行不 detach（调试用）
`;

function parseGoalArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = argv[++i];
    else if (a === '--spec') opts.spec = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--max-iterations') opts.maxIterations = Number(argv[++i]);
    else if (a === '--max-duration') opts.maxDuration = Number(argv[++i]);
    else if (a === '--allow-shell') opts.allowShell = true;
    else if (a === '--foreground') opts.foreground = true;
    else opts.positional.push(a);
  }
  return opts;
}

function currentHead(repo) {
  const r = gitRun(repo, ['rev-parse', '--verify', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

function buildRawSpec(repo, opts) {
  if (opts.spec) {
    if (!existsSync(opts.spec)) return { ok: false, message: `spec 文件不存在：${opts.spec}` };
    let raw;
    try {
      raw = parseYaml(readFileSync(opts.spec, 'utf8'));
    } catch (err) {
      return { ok: false, message: `spec 解析失败：${err.message}` };
    }
    if (opts.base) raw.base_commit = opts.base;
    return { ok: true, raw };
  }
  // 简单模式
  const task = opts.positional[0];
  if (!task) return { ok: false, message: '缺少任务描述' };
  if (!opts.check) return { ok: false, message: '简单模式需要 --check' };
  if (!Number.isInteger(opts.maxIterations)) return { ok: false, message: '简单模式需要 --max-iterations' };
  const base = opts.base ?? currentHead(repo);
  if (!base) return { ok: false, message: '无法解析 base commit' };
  const built = buildSimpleSpec({
    task, check: opts.check, maxIterations: opts.maxIterations,
    maxDuration: opts.maxDuration, baseCommit: base,
  });
  if (!built.ok) return { ok: false, message: built.error };
  return { ok: true, raw: built.spec };
}

// shell 确认门（P0-4，PRD 安全承诺“完整展示并单独确认”）：
// spec 含 shell eval 或 setup 命令（同为任意 shell 字符串）时，完整展示并要求 --allow-shell。
function shellGate(raw, opts) {
  const v = validateSpecObject(raw);
  if (!v.ok) return { ok: true }; // 结构问题交给 prepareRun 统一报告
  const shellEvals = v.normalized.evals.filter((e) => e.shell);
  const setupCmds = v.normalized.setup ?? [];
  if (shellEvals.length === 0 && setupCmds.length === 0) return { ok: true };
  if (opts.allowShell) return { ok: true };
  console.error('Goal Spec 含将以 shell 执行的任意命令，需要单独确认后才能启动：');
  for (const e of shellEvals) console.error(`  [eval ${e.id}] ${e.command}`);
  for (const c of setupCmds) console.error(`  [setup] ${c}`);
  console.error('确认以上命令无误后，加 --allow-shell 重新启动。');
  return { ok: false };
}

// 等待后台控制器的 ready/error 握手（P0-1）
function awaitHandshake(child) {
  return new Promise((res) => {
    const timer = setTimeout(() => res({ ok: false, reason: `控制器 ${HANDSHAKE_TIMEOUT_MS / 1000}s 内未回执` }), HANDSHAKE_TIMEOUT_MS);
    const done = (v) => { clearTimeout(timer); res(v); };
    child.once('message', (m) => done(m?.ok ? m : { ok: false, reason: m?.reason ?? '控制器拒绝接管' }));
    child.once('error', (err) => done({ ok: false, reason: String(err) }));
    child.once('exit', (code, signal) => done({ ok: false, reason: `控制器提前退出（${signal ?? `exit ${code}`}）` }));
  });
}

async function cmdGoal(repo, argv) {
  const opts = parseGoalArgs(argv);
  const pf = preflight();
  if (!pf.ok) {
    for (const p of pf.problems) console.error(`体检失败：${p.message}`);
    return 2;
  }
  const built = buildRawSpec(repo, opts);
  if (!built.ok) {
    console.error(built.message);
    return 2;
  }
  if (!shellGate(built.raw, opts).ok) return 2;

  if (opts.foreground) {
    const res = await startLoop({ repo, rawSpec: built.raw, skipPreflight: true });
    if (!res.ok) {
      console.error(`启动失败（${res.stage}）：${res.message ?? JSON.stringify(res.errors ?? res.problems)}`);
      return 1;
    }
    console.log(`run ${res.runId} 终态：${res.final.status}${res.final.stop_reason ? `(${res.final.stop_reason})` : ''}`);
    console.log(`分支：${res.branch}`);
    console.log(`报告：${resolve(res.stateDir, 'report.md')}`);
    return 0;
  }

  // detach 守护（P0-1 两阶段）：阶段一在前台完成全部会失败的准备，失败即刻回显真实错误
  const prep = await prepareRun({ repo, rawSpec: built.raw, skipPreflight: true });
  if (!prep.ok) {
    console.error(`启动失败（${prep.stage}）：${prep.message ?? JSON.stringify(prep.errors ?? prep.problems)}`);
    return 1;
  }

  // 阶段二：派生脱离会话的控制器接管已准备完成的 run，握手成功才向用户报告“已启动”
  const child = spawn(process.execPath, [SELF, '__run'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, LOOP_RUN_CONFIG: JSON.stringify(prep) },
  });
  const hs = await awaitHandshake(child);
  if (!hs.ok) {
    console.error(`后台控制器启动失败：${hs.reason}`);
    console.error(`run ${prep.runId} 已准备但未运行；可用 loop status ${prep.runId} 检视。`);
    return 1;
  }
  child.unref();
  console.log(`循环已在后台启动：run ${prep.runId}（pid ${child.pid}）`);
  console.log(`分支：${prep.branch}`);
  console.log(`进度：loop status ${prep.runId}　取消：loop cancel ${prep.runId}`);
  console.log(`报告（终态后）：${resolve(prep.stateDir, 'report.md')}`);
  return 0;
}

async function cmdRun() {
  const prep = JSON.parse(process.env.LOOP_RUN_CONFIG ?? '{}');
  // detach 守护的信号处理（技术设计 §11）：SIGTERM/SIGINT 翻转停止标志，
  // 控制器在检查点与 in-flight 子进程两处响应，收尾为 STOPPED(canceled) 并释放锁。
  let stopRequested = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { stopRequested = true; });
  }
  // 接管锁所有权（判活身份换成控制器自身），成功后回执握手；失败则拒绝接管
  const lock = updateLockMeta(prep.projectDir, prep.runId, processIdentity());
  if (!lock.ok) {
    if (process.send) { try { process.send({ ok: false, reason: `锁接管失败：${lock.reason}` }); } catch { /* 父进程可能已退出 */ } }
    process.exitCode = 1;
    return;
  }
  if (process.send) {
    try { process.send({ ok: true, runId: prep.runId }); } catch { /* 父进程可能已退出 */ }
    process.disconnect?.();
  }
  await runPreparedLoop(prep, {
    shouldStop: () => stopRequested,
    overrideArgv: prep.overrideArgv ?? null,
  });
}

function cmdStatus(repo, argv) {
  const runId = argv[0] ?? null;
  const r = getStatus({ repo, runId });
  if (!r.ok && runId) {
    console.error(`状态不可读：${r.reason}`);
    return 1;
  }
  if (runId) {
    const s = r.state;
    console.log(`run ${s.run_id}：${s.status}${s.stop_reason ? `(${s.stop_reason})` : ''}`);
    console.log(`迭代 ${s.iteration}，最近 checkpoint ${s.last_checkpoint}`);
    if (s.candidate_commit) console.log(`candidate ${s.candidate_commit}`);
  } else if (r.lock.status === 'alive') {
    console.log(`活动循环：run ${r.lock.meta?.run_id}（pid ${r.lock.meta?.pid}）`);
  } else {
    console.log(`无活动循环（锁状态：${r.lock.status}）`);
  }
  return 0;
}

function cmdCancel(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop cancel <runId>'); return 2; }
  const r = cancelRun({ repo, runId });
  if (!r.ok) { console.error(r.message); return 1; }
  console.log(r.already ? `run ${runId} 已处于终态（${r.status}）` : `已向 run ${runId} 发送取消信号`);
  return 0;
}

function cmdAccept(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop accept <runId>'); return 2; }
  const r = acceptRun({ repo, runId });
  if (!r.ok) { console.error(r.message); return 1; }
  console.log(`run ${runId} 已接受（ACCEPTED）`);
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '__run') { await cmdRun(); return process.exitCode ?? 0; }

  const repo = process.cwd();
  switch (command) {
    case 'goal': return cmdGoal(repo, rest);
    case 'status': return cmdStatus(repo, rest);
    case 'cancel': return cmdCancel(repo, rest);
    case 'accept': return cmdAccept(repo, rest);
    case undefined:
    case '-h':
    case '--help':
      console.log(HELP);
      return command === undefined ? 2 : 0;
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`内部错误：${err.stack ?? err}`);
  process.exit(2);
});
