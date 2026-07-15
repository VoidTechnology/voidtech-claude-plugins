// loop CLI（PRD F8/F9）：goal（启动，默认 detach 守护进程）、status、cancel、accept。
// detach 模型（技术设计 §11）：goal 完成体检后派生脱离会话的控制器并立即返回；
// 宿主会话关闭不影响循环，运行期中断走 cancel。

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildSimpleSpec } from './lib/simplemode.mjs';
import { parseYaml } from './lib/yaml.mjs';
import { preflight } from './lib/preflight.mjs';
import { startLoop, getStatus, cancelRun, acceptRun } from './lib/lifecycle.mjs';
import { gitRun } from './lib/gitops.mjs';

const SELF = fileURLToPath(import.meta.url);

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

  // detach 守护：派生脱离会话的控制器进程后立即返回
  const child = spawn(process.execPath, [SELF, '__run'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, LOOP_RUN_CONFIG: JSON.stringify({ repo, rawSpec: built.raw }) },
  });
  child.unref();
  console.log(`循环已在后台启动（pid ${child.pid}）。`);
  console.log('用 `loop status` 查看进度，`loop cancel <runId>` 取消。');
  return 0;
}

async function cmdRun() {
  const config = JSON.parse(process.env.LOOP_RUN_CONFIG ?? '{}');
  await startLoop({ repo: config.repo, rawSpec: config.rawSpec, skipPreflight: true });
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
  if (command === '__run') { await cmdRun(); return 0; }

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
