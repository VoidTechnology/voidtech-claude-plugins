// F5 测试：V10——以工具调用 JSON 直接驱动 PreToolUse 守卫的单元 fixture；
// worker settings 注入与 stub worker 接缝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeWorkerSettings, buildWorkerPrompt, runWorker } from '../scripts/lib/workerio.mjs';

const GUARD = fileURLToPath(new URL('../scripts/hooks/worker-guard.sh', import.meta.url));

function runGuard(toolName, toolInput, { root, protectedFile = '' }) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  return spawnSync('bash', [GUARD], {
    input,
    encoding: 'utf8',
    env: { ...process.env, LOOP_ROOT: root, LOOP_PROTECTED_FILE: protectedFile },
  });
}

function makeWorktreeDir() {
  const root = mkdtempSync(join(tmpdir(), 'guard-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('V10：Bash git 写命令被拦截（exit 2），只读 git 与普通命令放行', () => {
  const root = makeWorktreeDir();
  try {
    const denied = [
      'git add -A && git commit -m x',
      'git push origin main',
      'git -C /tmp/repo reset --hard HEAD~1',
      'cd /tmp && git checkout -b evil',
      'npm test; git config core.hooksPath /tmp/evil',
      'git worktree add /tmp/wt',
    ];
    for (const cmd of denied) {
      const r = runGuard('Bash', { command: cmd }, { root });
      assert.equal(r.status, 2, `应拦截：${cmd}\nstderr=${r.stderr}`);
      assert.ok(r.stderr.includes('Git 写权限'), r.stderr);
    }
    const allowed = [
      'git status',
      'git log --oneline -5',
      'git diff HEAD',
      'git rev-parse HEAD',
      'npm test -- payment',
      'ls -la && cat README.md',
      'legitimate-tool --gitlab-token x',
    ];
    for (const cmd of allowed) {
      const r = runGuard('Bash', { command: cmd }, { root });
      assert.equal(r.status, 0, `不应拦截：${cmd}\nstderr=${r.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V10：写路径越界与 .. 逃逸被拦截；worktree 内放行', () => {
  const root = makeWorktreeDir();
  try {
    for (const [tool, input] of [
      ['Write', { file_path: '/etc/passwd' }],
      ['Write', { file_path: join(root, '..', 'outside.txt') }],
      ['Edit', { file_path: 'src/../../escape.txt' }],
    ]) {
      const r = runGuard(tool, input, { root });
      assert.equal(r.status, 2, `应拦截：${JSON.stringify(input)}\nstderr=${r.stderr}`);
    }
    for (const [tool, input] of [
      ['Write', { file_path: join(root, 'src/app.js') }],
      ['Edit', { file_path: 'src/app.js' }],
    ]) {
      const r = runGuard(tool, input, { root });
      assert.equal(r.status, 0, `不应拦截：${JSON.stringify(input)}\nstderr=${r.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V10：protected paths 与保留目录（.voidtech-loop/.claude）写入被拦截', () => {
  const root = makeWorktreeDir();
  const patternDir = mkdtempSync(join(tmpdir(), 'guard-patterns-'));
  const patternFile = join(patternDir, 'patterns');
  writeFileSync(patternFile, 'tests/acceptance/**\n*.golden\n');
  try {
    for (const file of [
      'tests/acceptance/contract.txt',
      'snapshots/output.golden',
      '.voidtech-loop/specs/x.yaml',
      '.claude/settings.json',
    ]) {
      const r = runGuard('Write', { file_path: file }, { root, protectedFile: patternFile });
      assert.equal(r.status, 2, `应拦截：${file}\nstderr=${r.stderr}`);
    }
    const ok = runGuard('Write', { file_path: 'tests/unit/normal.txt' }, { root, protectedFile: patternFile });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(patternDir, { recursive: true, force: true });
  }
});

test('writeWorkerSettings：写入合法 settings.json 并挂接守卫', () => {
  const root = makeWorktreeDir();
  try {
    writeWorkerSettings(root, { protectedPatternsFile: '/tmp/patterns' });
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    const hook = settings.hooks.PreToolUse[0];
    assert.equal(hook.matcher, 'Bash|Edit|Write|NotebookEdit');
    assert.ok(hook.hooks[0].command.includes('worker-guard.sh'));
    assert.ok(hook.hooks[0].command.includes(`LOOP_ROOT='${root}'`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt：注入任务、eval 清单、失败证据与纪律约束', () => {
  const spec = {
    task: 'Fix payment tests',
    protected_paths: ['tests/acceptance/**'],
    evals: [
      { id: 'payment', role: 'target', command: ['npm', 'test'], shell: false, expected_exit: 0, timeout_seconds: 600 },
    ],
  };
  const first = buildWorkerPrompt({ spec, iteration: 1, lastCheckpoint: 'abc1234' });
  assert.ok(first.includes('Fix payment tests'));
  assert.ok(first.includes('首轮'));
  assert.ok(first.includes('只解决一个明确差距'));
  assert.ok(first.includes('tests/acceptance/**'));

  const later = buildWorkerPrompt({
    spec,
    iteration: 3,
    lastCheckpoint: 'def5678',
    failedSummaries: ['[payment] exit=1 expected_exit=0\nFAIL src/pay.test.js'],
  });
  assert.ok(later.includes('上一轮失败的 eval'));
  assert.ok(later.includes('FAIL src/pay.test.js'));
  assert.ok(later.includes('def5678'));
});

test('runWorker stub 接缝：注入可执行文件，上下文经文件传递，在 worktree 内执行', async () => {
  const root = makeWorktreeDir();
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'stub-worker.sh');
  writeFileSync(stub, `#!/bin/bash
CTX="$1"
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['prompt'])" "$CTX" > prompt-received.txt
echo did-work > work-output.txt
`, { mode: 0o755 });
  try {
    const r = await runWorker({
      worktree: root,
      prompt: 'PROMPT-MARKER-XYZ',
      timeoutSeconds: 30,
      overrideArgv: ['bash', stub],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(existsSync(join(root, 'work-output.txt')), 'stub 应在 worktree cwd 内执行');
    assert.ok(readFileSync(join(root, 'prompt-received.txt'), 'utf8').includes('PROMPT-MARKER-XYZ'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('worker 继承认证环境（凭据清理只作用于 eval，不作用于 worker）', async () => {
  // 回归：dogfood 曾因 worker 走 eval 白名单丢失凭据环境而报 “Not logged in”。
  const root = makeWorktreeDir();
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'envcheck.sh');
  // stub 把关键认证相关环境变量落盘，验证 worker 能看到父进程环境
  writeFileSync(stub, `#!/bin/bash
{ echo "HOME=$HOME"; echo "MARKER=$LOOP_WORKER_ENV_MARKER"; } > env-seen.txt
`, { mode: 0o755 });
  const prev = process.env.LOOP_WORKER_ENV_MARKER;
  process.env.LOOP_WORKER_ENV_MARKER = 'inherited-ok';
  try {
    const r = await runWorker({ worktree: root, prompt: 'x', timeoutSeconds: 30, overrideArgv: ['bash', stub] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const seen = readFileSync(join(root, 'env-seen.txt'), 'utf8');
    assert.ok(seen.includes('MARKER=inherited-ok'), 'worker 应继承父进程环境（认证所需）');
    assert.ok(/HOME=\S/.test(seen), 'worker 环境应含 HOME');
  } finally {
    if (prev === undefined) delete process.env.LOOP_WORKER_ENV_MARKER;
    else process.env.LOOP_WORKER_ENV_MARKER = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('runWorker 超时：stub 挂起时 timed_out=true', async () => {
  const root = makeWorktreeDir();
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'hang.sh');
  writeFileSync(stub, '#!/bin/bash\nsleep 120\n', { mode: 0o755 });
  try {
    const r = await runWorker({ worktree: root, prompt: 'x', timeoutSeconds: 1, overrideArgv: ['bash', stub] });
    assert.equal(r.ok, false);
    assert.equal(r.timed_out, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});
