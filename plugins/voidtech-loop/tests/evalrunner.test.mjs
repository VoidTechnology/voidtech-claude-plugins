// evalrunner 测试：V13（一次性验收 worktree 隔离）、V14（证据截断：前后 256KiB + 总字节 + 流 SHA-256，
// worker 摘要 ≤32KiB）与失败证据的规范化结构。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runEvalPack } from '../scripts/lib/evalrunner.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { makeTestRepo } from './helpers.mjs';

function makeRepo() {
  return makeTestRepo({
    prefix: 'evalrunner-fixture-',
    files: {
      'ok.sh': { content: '#!/bin/bash\nexit 0\n', mode: 0o755 },
      'fail.sh': { content: '#!/bin/bash\necho boom >&2\nexit 7\n', mode: 0o755 },
    },
  });
}

function makeSpec(sha, evals) {
  const r = validateSpecObject({
    schema_version: 1,
    goal_id: 'runner-fixture',
    task: 'eval runner fixture',
    base_commit: sha,
    budgets: { max_iterations: 5 },
    evals,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return { spec: r.normalized, hash: r.goal_hash };
}

test('全部通过 → passed=true，证据绑定 candidate 与 goal_hash', async () => {
  const { repo, sha } = makeRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const { spec, hash } = makeSpec(sha, [
      { id: 'ok-eval', role: 'target', command: ['bash', 'ok.sh'], timeout_seconds: 30 },
    ]);
    const report = await runEvalPack(spec, { repo, candidateSha: sha, goalHash: hash, evidenceDir });
    assert.equal(report.passed, true);
    assert.equal(report.candidate_sha, sha);
    assert.equal(report.goal_hash, hash);
    assert.equal(report.results[0].pass, true);
    const evidencePath = report.results[0].runs[0].evidence.path;
    assert.ok(existsSync(evidencePath));
    const head = readFileSync(evidencePath, 'utf8').split('\n').slice(0, 4).join('\n');
    assert.ok(head.includes(sha), '证据文件头必须绑定 candidate SHA');
    assert.ok(head.includes(hash), '证据文件头必须绑定 goal_hash');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('失败 eval → passed=false，规范化结果含 eval ID 与退出码', async () => {
  const { repo, sha } = makeRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const { spec, hash } = makeSpec(sha, [
      { id: 'good', role: 'invariant', command: ['bash', 'ok.sh'], timeout_seconds: 30 },
      { id: 'bad', role: 'target', command: ['bash', 'fail.sh'], timeout_seconds: 30 },
    ]);
    const report = await runEvalPack(spec, { repo, candidateSha: sha, goalHash: hash, evidenceDir });
    assert.equal(report.passed, false);
    const failed = report.failed;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 'bad');
    assert.equal(failed[0].runs[0].exit, 7);
    assert.ok(failed[0].summary.includes('boom'), '失败摘要应含 stderr 内容');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('V13：eval 在一次性 worktree 运行且结束后销毁；副作用不进原仓库', async () => {
  const { repo, sha } = makeRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const { spec, hash } = makeSpec(sha, [
      { id: 'side-effect', role: 'target', command: ['bash', '-c', 'touch injected.txt && pwd'], timeout_seconds: 30 },
    ]);
    const report = await runEvalPack(spec, { repo, candidateSha: sha, goalHash: hash, evidenceDir });
    assert.equal(report.passed, true);
    assert.ok(!existsSync(join(repo, 'injected.txt')), '副作用不得出现在原仓库');
    assert.ok(!existsSync(report.worktree), '验收 worktree 必须已销毁');
    assert.notEqual(report.worktree, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('V14：大输出截断——前后各 256KiB、总字节数、完整流 SHA-256、摘要 ≤32KiB', async () => {
  const { repo, sha } = makeRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    // 生成 2 MiB 确定性输出：每行 "line-<n>-" 填充
    const gen = 'for i in $(seq 1 40000); do printf "line-%06d-padding-padding-padding-padding-padding\\n" $i; done';
    const { spec, hash } = makeSpec(sha, [
      { id: 'big-output', role: 'target', command: ['bash', '-c', gen], timeout_seconds: 60 },
    ]);
    const report = await runEvalPack(spec, { repo, candidateSha: sha, goalHash: hash, evidenceDir });
    const run = report.results[0].runs[0];

    // 独立复算完整流哈希
    const independent = spawnSync('bash', ['-c', gen], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const expectedSha = createHash('sha256').update(independent.stdout).digest('hex');
    const expectedBytes = independent.stdout.length;

    assert.equal(run.evidence.total_bytes, expectedBytes, '总字节数必须精确');
    assert.equal(run.evidence.sha256, expectedSha, '完整流 SHA-256 必须与独立复算一致');
    assert.equal(run.evidence.truncated, true);

    const evidence = readFileSync(run.evidence.path, 'utf8');
    assert.ok(evidence.includes('line-000001-'), '证据应含流头部');
    assert.ok(evidence.includes('line-040000-'), '证据应含流尾部');
    assert.ok(evidence.includes('TRUNCATED'), '截断必须显式标注');
    const st = readFileSync(run.evidence.path).length;
    assert.ok(st < 600 * 1024, `证据文件应约束在前后 256KiB 量级，实际 ${st}`);

    assert.ok(Buffer.byteLength(report.results[0].summary, 'utf8') <= 32 * 1024, 'worker 摘要不得超过 32KiB');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('超时 eval 记为失败并清理进程组；其余 eval 继续执行', async () => {
  const { repo, sha } = makeRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const { spec, hash } = makeSpec(sha, [
      { id: 'hang', role: 'target', command: ['bash', '-c', 'sleep 300 & wait'], timeout_seconds: 1 },
      { id: 'after-hang', role: 'invariant', command: ['bash', 'ok.sh'], timeout_seconds: 30 },
    ]);
    const report = await runEvalPack(spec, { repo, candidateSha: sha, goalHash: hash, evidenceDir });
    assert.equal(report.passed, false);
    assert.equal(report.results[0].timed_out, true);
    assert.equal(report.results[1].pass, true, '超时后其余 eval 仍应执行');
    await new Promise((r) => setTimeout(r, 2500));
    const leftover = spawnSync('pgrep', ['-f', 'sleep 300'], { encoding: 'utf8' });
    assert.notEqual(leftover.status, 0, '超时 eval 的进程组应被清理');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
