// goal-spec CLI：Goal Spec 的唯一校验与基线入口（PRD F3）。
// skill、启动 gate 与控制器都必须经由本入口，禁止另写字段规则副本（V7）。

import { readFileSync } from 'node:fs';
import { validateSpecText } from './lib/validate.mjs';
import { runBaseline } from './lib/baseline.mjs';
import { shellExecutionGate } from './lib/shellgate.mjs';

const HELP = `用法：goal-spec <命令> <spec.yaml> [选项]

命令：
  validate <spec.yaml>   校验 Goal Spec，输出规范化结果与 goal_hash
  baseline <spec.yaml>   校验后在 base commit 的一次性 worktree 执行基线 eval 并按角色裁定

选项：
  --json                 以 JSON 输出（机器可读）
  --repo <path>          仓库路径（baseline，默认当前目录）
  --clone-deps <path>    从仓库根克隆依赖目录进验收 worktree（baseline，可重复）
  --allow-shell          确认执行 shell eval 与 setup 命令（baseline 安全门）

退出码：
  0  校验通过 / 基线可启动
  1  spec 无效或 base_commit 无法解析
  2  用法错误或环境错误
  3  全部 target 在基线已满足
  4  invariant 在基线不成立
  5  基线 eval 超时
`;

function parseArgs(argv) {
  const args = { cloneDeps: [], json: false, repo: '.' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--clone-deps') args.cloneDeps.push(argv[++i]);
    else if (a === '--allow-shell') args.allowShell = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else positional.push(a);
  }
  [args.command, args.specPath] = positional;
  return args;
}

function readSpec(path) {
  if (path === '-') return readFileSync(0, 'utf8');
  return readFileSync(path, 'utf8');
}

function printValidation(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) {
    console.log(`校验通过：goal_hash=${result.goal_hash}`);
    if (result.flags.shell) console.log('注意：包含 shell: true 的 eval，启动时需要显式确认');
    if (result.flags.setup) console.log('注意：包含 setup 命令，warm 安装将允许网络并写入报告');
  } else {
    console.error('校验失败：');
    for (const e of result.errors) console.error(`  ${e.path}：${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }
  if (!['validate', 'baseline'].includes(args.command)) {
    console.error(`未知命令：${args.command}\n`);
    console.log(HELP);
    process.exit(2);
  }
  if (!args.specPath) {
    console.error('缺少 spec 文件路径\n');
    console.log(HELP);
    process.exit(2);
  }

  let text;
  try {
    text = readSpec(args.specPath);
  } catch (err) {
    console.error(`无法读取 spec：${err.message}`);
    process.exit(2);
  }

  const validation = validateSpecText(text);
  if (args.command === 'validate') {
    printValidation(validation, args.json);
    process.exit(validation.ok ? 0 : 1);
  }

  // baseline：先校验，再执行
  if (!validation.ok) {
    printValidation(validation, args.json);
    process.exit(1);
  }
  const shellGate = shellExecutionGate(validation, { allowShell: args.allowShell });
  if (!shellGate.ok) {
    console.error(shellGate.message);
    process.exit(2);
  }
  const report = await runBaseline(validation.normalized, {
    repo: args.repo,
    cloneDeps: args.cloneDeps,
  });
  const output = { goal_hash: validation.goal_hash, ...report };
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`基线裁定：${report.verdict}`);
    console.log(report.message);
    for (const r of report.results ?? []) {
      const runsDesc = r.runs
        .map((run) => (run.timed_out ? 'timeout' : run.spawn_error ? `spawn_error(${run.spawn_error})` : `exit=${run.exit}`))
        .join(',');
      console.log(`  [${r.pass ? 'ok' : 'fail'}] ${r.role} ${r.id}：${runsDesc}（期望 exit=${r.expected_exit}）`);
    }
  }
  process.exit(report.exitCode);
}

main().catch((err) => {
  console.error(`内部错误：${err.stack ?? err}`);
  process.exit(2);
});
