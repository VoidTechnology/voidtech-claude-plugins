// worker 调用层（PRD F5 / 4.2.1–2）：固定 best-effort 能力的有界 worker invocation。
// 选型（技术设计 §1）：非 bare `claude -p` + allowedTools 白名单 + 循环 worktree 内 PreToolUse 守卫。
// 测试接缝：worker 命令可经配置替换为任意可执行文件（V23/V10 的 stub 注入点）。

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execEval } from './evalrunner.mjs';

const GUARD_SCRIPT = fileURLToPath(new URL('../hooks/worker-guard.sh', import.meta.url));
export const WORKER_ALLOWED_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';
const DEFAULT_MAX_TURNS = 50;

// 在循环 worktree 写入 worker 的项目级配置：PreToolUse 守卫（Bash/Edit/Write/NotebookEdit）。
export function writeWorkerSettings(worktree, { protectedPatternsFile = '' } = {}) {
  const guardCmd = `LOOP_ROOT='${worktree}' LOOP_PROTECTED_FILE='${protectedPatternsFile}' bash '${GUARD_SCRIPT}'`;
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Edit|Write|NotebookEdit',
          hooks: [{ type: 'command', command: guardCmd }],
        },
      ],
    },
  };
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  writeFileSync(join(worktree, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  return settings;
}

// 每轮注入：冻结 Goal Spec 摘要、上一轮失败证据、最近 checkpoint 与纪律约束（PRD 4.2.1–2）。
export function buildWorkerPrompt({ spec, iteration, lastCheckpoint, failedSummaries = [] }) {
  const evalLines = spec.evals
    .map((e) => `- [${e.role}] ${e.id}: ${e.shell ? e.command : JSON.stringify(e.command)} (expect exit ${e.expected_exit}, timeout ${e.timeout_seconds}s)`)
    .join('\n');
  const failedBlock = failedSummaries.length
    ? `\n## 上一轮失败的 eval（按此定位差距）\n\n${failedSummaries.join('\n\n')}\n`
    : '\n## 首轮\n\n还没有 eval 反馈；先搜索理解现状，再选择第一个差距。\n';
  const protectedBlock = spec.protected_paths.length
    ? `\n禁止修改以下 protected paths（验收资产）：\n${spec.protected_paths.map((p) => `- ${p}`).join('\n')}\n`
    : '';
  return `你是 voidtech-loop 的受限 worker，正在第 ${iteration} 轮迭代中工作。

## 任务（不可变 Goal Spec）

${spec.task}

## 验收 eval（由控制器在你之外执行，你无法也不得自行裁定完成）

${evalLines}
${failedBlock}
## 纪律

- 本轮只解决一个明确差距；动手前先搜索相关代码。
- 你没有任何 Git 写权限；不要尝试 add/commit/push，checkpoint 由控制器生成（最近 checkpoint：${lastCheckpoint}）。
- 只在当前工作目录（循环 worktree）内修改业务文件。${protectedBlock}
- 修改完成后直接结束回复；不要宣称任务完成，完成与否由 eval 裁定。`;
}

// 有界 worker invocation：默认走非 bare claude -p；override 注入 stub（argv 数组，上下文文件路径作为最后一个参数）。
export async function runWorker({ worktree, prompt, timeoutSeconds, maxTurns = DEFAULT_MAX_TURNS, overrideArgv = null }) {
  let command;
  if (overrideArgv) {
    const ctxDir = mkdtempSync(join(tmpdir(), 'loop-worker-ctx-'));
    const ctxFile = join(ctxDir, 'context.json');
    writeFileSync(ctxFile, JSON.stringify({ worktree, prompt }, null, 2));
    command = [...overrideArgv, ctxFile];
  } else {
    command = [
      'claude', '-p', prompt,
      '--allowedTools', WORKER_ALLOWED_TOOLS,
      '--max-turns', String(maxTurns),
      '--output-format', 'json',
    ];
  }
  const evalDef = {
    id: 'worker-invocation',
    role: 'target',
    command,
    shell: false,
    cwd: '.',
    expected_exit: 0,
    timeout_seconds: timeoutSeconds,
    repeat: 1,
  };
  const result = await execEval(evalDef, worktree);
  const run = result.runs[0];
  return {
    ok: !result.timed_out && run.exit === 0 && !run.spawn_error,
    exit: run.exit,
    timed_out: result.timed_out,
    spawn_error: run.spawn_error ?? null,
    duration_ms: run.duration_ms,
    summary: result.summary,
  };
}
