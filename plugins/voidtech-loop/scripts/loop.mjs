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
import { shellExecutionGate } from './lib/shellgate.mjs';
import { adoptPreparedRun, failPreparedRun, prepareRun, runPreparedLoop, startLoop, getStatus, cancelRun, acceptRun, abandonRun } from './lib/lifecycle.mjs';
import { runSuggestionReview } from './lib/reviewflow.mjs';
import { approveRevision } from './lib/reviewapproval.mjs';
import { processIdentity } from './lib/statestore.mjs';
import { resolveCommit } from './lib/gitops.mjs';

const SELF = fileURLToPath(import.meta.url);
const HANDSHAKE_TIMEOUT_MS = 15_000;

const HELP = `用法：loop <命令> [参数]

  goal "<任务>" --check "<命令>" --max-iterations N [选项]
                              启动简单模式循环（默认后台守护）
  goal --spec <file.yaml>     从 Goal Spec 文件启动
  status [runId]              查看项目锁或指定 run 状态
  cancel <runId>              取消运行中的循环（幂等）
  accept <runId>              将 EVALS_PASSED 的 run 标记为 ACCEPTED
  abandon <runId>             放弃终态 run（不修改执行事实，追加 Decision Record）
  review <runId>              对终态 run 启动独立审查 agent（建议模式，不自动执行任何决定）
    --direction "<text>"      不同意上次建议时带方向意见重提案（每 run 最多一次）
  approve <runId>             展示当前 Revision Draft（来源、变化摘要、未映射内容、执行计划）
    --approve-execution       批准当前展示版本并执行 baseline 与原子冻结；成功只输出启动命令

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
  const resolved = resolveCommit(repo, 'HEAD');
  return resolved.ok ? resolved.sha : null;
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

// 等待后台控制器的 ready/error 握手（P0-1）
function awaitHandshake(child) {
  return new Promise((res) => {
    let settled = false;
    const onMessage = (m) => done(m?.ok ? m : { ok: false, reason: m?.reason ?? '控制器拒绝接管' });
    const onError = (err) => done({ ok: false, reason: String(err) });
    const onExit = (code, signal) => done({ ok: false, reason: `控制器提前退出（${signal ?? `exit ${code}`}）` });
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      res(value);
    };
    const timer = setTimeout(() => done({ ok: false, reason: `控制器 ${HANDSHAKE_TIMEOUT_MS / 1000}s 内未回执` }), HANDSHAKE_TIMEOUT_MS);
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateController(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }
  if (await waitForExit(2000)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  await waitForExit(2000);
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
  const shellGate = shellExecutionGate(validateSpecObject(built.raw), { allowShell: opts.allowShell });
  if (!shellGate.ok) {
    console.error(shellGate.message);
    return 2;
  }

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
    await terminateController(child);
    failPreparedRun(prep, { kind: 'handshake_failed', reason: hs.reason });
    console.error(`后台控制器启动失败：${hs.reason}`);
    console.error(`run ${prep.runId} 已终止；可用 loop status ${prep.runId} 检视报告。`);
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
  const adoption = adoptPreparedRun(prep, processIdentity());
  if (!adoption.ok) {
    failPreparedRun(prep, { kind: 'handshake_failed', reason: adoption.reason });
    if (process.send) { try { process.send({ ok: false, reason: adoption.reason }); } catch { /* 父进程可能已退出 */ } }
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
    if (r.review) {
      console.log(`run_integrity ${r.review.run_integrity}，review_integrity ${r.review.review_integrity}${r.review.outcome ? `（${r.review.outcome}）` : ''}`);
    }
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

// 临时 CLI 契约（完整审批交互属 Task 5.3）：spec 含 manual_review 时必须显式 --manual-passed
// 逐项确认已通过；未给出时列出待办项并拒绝，不静默替人打勾。
async function cmdAccept(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop accept <runId> [--manual-passed] [--note <text>]'); return 2; }
  const noteIdx = argv.indexOf('--note');
  const note = noteIdx >= 0 ? (argv[noteIdx + 1] ?? null) : null;
  const manualPassed = argv.includes('--manual-passed');

  const status = getStatus({ repo, runId });
  if (!status.ok) { console.error(`状态不可读：${status.reason}`); return 1; }
  const required = status.state.spec?.manual_review ?? [];
  if (required.length > 0 && !manualPassed) {
    console.error(`该 run 有 ${required.length} 项 manual review 待人工确认：`);
    for (const item of required) console.error(`  - ${item}`);
    console.error(`逐项确认无误后执行：loop accept ${runId} --manual-passed`);
    return 1;
  }
  const manualReviewResults = manualPassed ? required.map((item) => ({ item, passed: true })) : [];

  const r = await acceptRun({ repo, runId, manualReviewResults, note });
  if (!r.ok) { console.error(r.message ?? r.reason); return 1; }
  if (r.legacy) { console.log(`run ${runId} 为一期 legacy ACCEPTED，不补造 Decision Record`); return 0; }
  console.log(`run ${runId} 已接受（ACCEPTED）${r.idempotent ? '（幂等：返回已有决定）' : ''}，decision ${r.decision.decision_id}`);
  return 0;
}

async function cmdReview(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop review <runId> [--direction "<text>"]'); return 2; }
  const dirIdx = argv.indexOf('--direction');
  const direction = dirIdx >= 0 ? (argv[dirIdx + 1] ?? null) : null;

  console.log('正在启动独立审查 session（fresh、无工具、只读冻结事实）……');
  const r = await runSuggestionReview({ repo, runId, direction });
  if (!r.ok) { console.error(r.message ?? r.reason); return 1; }
  if (r.already_decided) {
    console.log(r.legacy
      ? `run ${runId} 已是一期 legacy ACCEPTED，无待决事项`
      : `run ${runId} 已有 finalized decision（${r.record.outcome}，${r.record.decision_id}），review 返回既有结果`);
    return 0;
  }
  console.log('');
  console.log(r.summary);
  console.log('');
  console.log(`（审计视图：本次 session 成本 $${r.audit.cost_usd ?? 'unavailable'}，耗时 ${Math.round((r.audit.duration_ms ?? 0) / 1000)}s；proposal 与 hash 见插件数据区 reviews/${runId}/proposals/）`);
  return 0;
}

async function cmdApprove(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop approve <runId> [--approve-execution] [--manual-passed]'); return 2; }

  // verification-only 通过即接受原 run：manual review 与 accept 同规，须显式确认
  let manualReviewResults = [];
  if (argv.includes('--manual-passed')) {
    const status = getStatus({ repo, runId });
    if (!status.ok) { console.error(`状态不可读：${status.reason}`); return 1; }
    manualReviewResults = (status.state.spec?.manual_review ?? []).map((item) => ({ item, passed: true }));
  }

  const r = await approveRevision({
    repo, runId, approveExecution: argv.includes('--approve-execution'), manualReviewResults,
  });
  if (!r.ok) { console.error(r.message ?? r.reason); return 1; }
  if (r.displayed) {
    console.log(r.view);
    return 0;
  }
  if (r.outcome === 'verification_passed') {
    console.log(r.message);
    return 0;
  }
  console.log(`Revision Bundle 已原子冻结（decision ${r.decision.decision_id}）。`);
  console.log('新 run 不会自动启动；确认后显式执行：');
  console.log(`  ${r.start_command}`);
  return 0;
}

async function cmdAbandon(repo, argv) {
  const runId = argv[0];
  if (!runId) { console.error('用法：loop abandon <runId> [--reason <text>]'); return 2; }
  const reasonIdx = argv.indexOf('--reason');
  const note = reasonIdx >= 0 ? (argv[reasonIdx + 1] ?? null) : null;
  const r = await abandonRun({ repo, runId, note });
  if (!r.ok) { console.error(r.message ?? r.reason); return 1; }
  console.log(`run ${runId} 已放弃${r.idempotent ? '（幂等：返回已有决定）' : ''}，decision ${r.decision.decision_id}；run 执行事实未被修改`);
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
    case 'abandon': return cmdAbandon(repo, rest);
    case 'review': return cmdReview(repo, rest);
    case 'approve': return cmdApprove(repo, rest);
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
