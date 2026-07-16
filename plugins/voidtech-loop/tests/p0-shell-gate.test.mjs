// P0-4：shell 确认门。spec 含 shell eval 或 setup 命令（同为任意 shell 字符串）时，
// CLI 必须完整展示并要求 --allow-shell 单独确认，兑现 PRD“完整展示并单独确认”的安全承诺。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflight } from '../scripts/lib/preflight.mjs';

const LOOP_CLI = fileURLToPath(new URL('../scripts/loop.mjs', import.meta.url));
const PF_OK = preflight().ok;
const SKIP = !PF_OK && '环境不满足 preflight，跳过 CLI 集成测试';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'gate-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'x');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

function runGoal(repo, root, args) {
  return spawnSync(process.execPath, [LOOP_CLI, 'goal', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
  });
}

test('P0-4：shell eval 未确认时拒绝启动，完整展示命令并提示 --allow-shell', { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-data-'));
  const { repo, sha } = makeRepo();
  try {
    const specPath = join(repo, 'spec.yaml');
    writeFileSync(specPath, [
      'schema_version: 1',
      'goal_id: shell-gate',
      'task: gate test',
      `base_commit: ${sha}`,
      'budgets:',
      '  max_iterations: 3',
      'evals:',
      '  - id: t1',
      '    role: target',
      '    command: exit 0',
      '    shell: true',
      '    timeout_seconds: 60',
      '',
    ].join('\n'));
    const r = runGoal(repo, root, ['--spec', specPath]);
    assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /--allow-shell/);
    assert.match(r.stderr, /exit 0/, '必须完整展示将执行的 shell 命令');
    assert.doesNotMatch(r.stdout, /已在后台启动/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-4：setup 命令同为任意 shell，未确认时同样拦截', { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-data-'));
  const { repo, sha } = makeRepo();
  try {
    const specPath = join(repo, 'spec.yaml');
    writeFileSync(specPath, [
      'schema_version: 1',
      'goal_id: setup-gate',
      'task: gate test',
      `base_commit: ${sha}`,
      'budgets:',
      '  max_iterations: 3',
      'setup:',
      '  - npm ci',
      'evals:',
      '  - id: t1',
      '    role: target',
      '    command: ["false"]',
      '    timeout_seconds: 60',
      '',
    ].join('\n'));
    const r = runGoal(repo, root, ['--spec', specPath]);
    assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /npm ci/, '必须完整展示 setup 命令');
    assert.match(r.stderr, /--allow-shell/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-4：--allow-shell 确认后通过安全门（推进到基线裁定）', { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-data-'));
  const { repo, sha } = makeRepo();
  try {
    const specPath = join(repo, 'spec.yaml');
    // target 在基线即通过 → all_targets_met：证明已越过安全门、进入 prepare 的基线裁定
    writeFileSync(specPath, [
      'schema_version: 1',
      'goal_id: shell-pass',
      'task: gate test',
      `base_commit: ${sha}`,
      'budgets:',
      '  max_iterations: 3',
      'evals:',
      '  - id: t1',
      '    role: target',
      '    command: exit 0',
      '    shell: true',
      '    timeout_seconds: 60',
      '',
    ].join('\n'));
    const r = runGoal(repo, root, ['--spec', specPath, '--allow-shell']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /启动失败（baseline）/);
    assert.doesNotMatch(r.stderr, /--allow-shell/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-4：简单模式（argv eval、无 setup）不受安全门影响', { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-data-'));
  const { repo } = makeRepo();
  try {
    // 简单模式 --check 是 argv 数组、无 shell —— 不应触发确认门；
    // check 命令不存在 → 基线 target 失败 → startable → 走到 detach 前的准备成功路径。
    // 为避免真的派生后台 worker，这里用一个基线即通过的 check 使其停在 baseline。
    const r = runGoal(repo, root, ['noop', '--check', 'true', '--max-iterations', '2']);
    assert.doesNotMatch(r.stderr ?? '', /--allow-shell/, '简单模式不得被安全门拦截');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /启动失败（baseline）/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
