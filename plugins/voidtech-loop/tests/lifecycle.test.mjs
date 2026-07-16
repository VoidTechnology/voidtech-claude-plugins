// F8/F9 测试：V5（四主场景一行 --check 启动）、V16（accept 仅 EVALS_PASSED）、
// V18（状态损坏 fail closed）、V20（--base 全新 run）、cancel 幂等、简单模式默认值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSimpleSpec, tokenizeCheck } from '../scripts/lib/simplemode.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { startLoop, acceptRun, cancelRun, getStatus, newFromCommit } from '../scripts/lib/lifecycle.mjs';
import { makeTestRepo, withDataRoot } from './helpers.mjs';

function makeRepo() {
  return makeTestRepo({
    prefix: 'lifecycle-fixture-',
    files: {
      'check.sh': { content: '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', mode: 0o755 },
      'progress.txt': 'todo\n',
    },
  });
}

function stubThatFixes() {
  const dir = mkdtempSync(join(tmpdir(), 'lc-stub-'));
  const path = join(dir, 's.sh');
  // 首轮写 half（eval 仍失败），第二轮看到失败证据后写 done
  writeFileSync(path, `#!/bin/bash
CTX="$1"
PROMPT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['prompt'])" "$CTX")
if grep -q '上一轮失败的 eval' <<<"$PROMPT"; then echo done > progress.txt; else echo half > progress.txt; fi
`, { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

test('简单模式 tokenizer：引号成组，拒绝 shell 元字符', () => {
  assert.deepEqual(tokenizeCheck('npm test -- payment').argv, ['npm', 'test', '--', 'payment']);
  assert.deepEqual(tokenizeCheck('npx tsc --noEmit').argv, ['npx', 'tsc', '--noEmit']);
  assert.deepEqual(tokenizeCheck('sh -c "echo hi"').argv, ['sh', '-c', 'echo hi']);
  for (const bad of ['a | b', 'a && b', 'a > f', 'a; b', 'echo $(whoami)', 'a `b`']) {
    assert.equal(tokenizeCheck(bad).ok, false, `应拒绝：${bad}`);
  }
});

test('V5：四主场景一行 --check 规范化为合法单 target Goal Spec，含默认值', () => {
  const scenarios = [
    { task: 'Fix failing payment tests', check: 'npm test -- payment' },
    { task: 'Eliminate TypeScript strict errors', check: 'npx tsc --noEmit' },
    { task: 'Implement payment contract', check: 'npm test -- contract/payment' },
    { task: 'Fix the typing flow UI', check: 'npm run test:e2e -- typing-flow' },
  ];
  for (const s of scenarios) {
    const built = buildSimpleSpec({ ...s, maxIterations: 25, baseCommit: '0123456789abcdef' });
    assert.equal(built.ok, true, s.task);
    const v = validateSpecObject(built.spec);
    assert.equal(v.ok, true, `${s.task}: ${JSON.stringify(v.errors)}`);
    assert.equal(v.normalized.budgets.max_duration_seconds, 3600, 'max_duration 默认 3600');
    assert.equal(v.normalized.evals.length, 1);
    assert.equal(v.normalized.evals[0].role, 'target');
    assert.equal(v.normalized.evals[0].timeout_seconds, 600);
  }
});

test('startLoop happy path：两轮修复进入 EVALS_PASSED，锁在终态释放', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.final.status, 'EVALS_PASSED');
      // 终态后锁应已释放，可再次启动
      const status = getStatus({ repo });
      assert.equal(status.lock.status, 'free', '执行期锁应在终态释放');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('V16：accept 只能从 EVALS_PASSED 进入 ACCEPTED', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(res.final.status, 'EVALS_PASSED');
      const acc = await acceptRun({ repo, runId: res.runId });
      assert.equal(acc.ok, true);
      assert.equal(acc.state.status, 'ACCEPTED');
      // 二期：accept 同时生成外部 Decision Record 并写入 decision_ref
      assert.equal(acc.decision.outcome, 'accept');
      assert.equal(acc.state.decision_ref.decision_id, acc.decision.decision_id);
      assert.equal(acc.state.review_protocol_version, 1);
      // 再次 accept（已 ACCEPTED）：相同请求幂等返回已有决定（P2-15）
      const again = await acceptRun({ repo, runId: res.runId });
      assert.equal(again.ok, true);
      assert.equal(again.idempotent, true);
      assert.equal(again.decision.decision_id, acc.decision.decision_id);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('V16：对非 EVALS_PASSED 状态 accept 被拒绝', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stubDir = mkdtempSync(join(tmpdir(), 'lc-stub-'));
    const stub = join(stubDir, 's.sh');
    writeFileSync(stub, '#!/bin/bash\ntrue\n', { mode: 0o755 }); // 永不进展 → STOPPED(blocked)
    try {
      const built = buildSimpleSpec({ task: 'never', check: 'bash check.sh', maxIterations: 10, baseCommit: sha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: ['bash', stub], skipPreflight: true });
      assert.equal(res.final.status, 'STOPPED');
      assert.equal((await acceptRun({ repo, runId: res.runId })).ok, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

test('V18：状态文件损坏时 accept/status fail closed', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      // 篡改状态文件正文，破坏 checksum
      const statePath = join(res.stateDir, 'state.json');
      writeFileSync(statePath, '{"state_version":1,"run_id":"x","status":"ACCEPTED","checksum":"deadbeef"}');
      assert.equal((await acceptRun({ repo, runId: res.runId })).ok, false, '损坏状态不得被接受');
      const st = getStatus({ repo, runId: res.runId });
      assert.equal(st.ok, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('cancel 幂等：对已 EVALS_PASSED 的 run 返回成功不改状态', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      const c1 = cancelRun({ repo, runId: res.runId });
      assert.equal(c1.ok, true);
      assert.equal(c1.already, true);
      const c2 = cancelRun({ repo, runId: res.runId });
      assert.equal(c2.ok, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('V20：--base 从任意 commit 发起全新 run（新 runId/分支/哈希），旧 run 不变', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const first = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(first.final.status, 'EVALS_PASSED');
      const candidate = first.final.candidate_commit;
      assert.match(candidate, /^[0-9a-f]{40}$/);

      // 以 candidate 为 base 发起新循环（此时 target 在该 commit 已满足 → baseline 拒绝，符合预期）
      const built2 = buildSimpleSpec({ task: 'make done again', check: 'bash check.sh', maxIterations: 5, baseCommit: sha });
      const second = await newFromCommit({ repo, rawSpec: built2.spec, baseCommit: candidate, overrideArgv: stub.argv, skipPreflight: true });
      // candidate 上 progress.txt=done → target 已满足 → 基线判 all_targets_met，不可启动
      assert.equal(second.ok, false);
      assert.equal(second.stage, 'baseline');
      assert.equal(second.verdict, 'all_targets_met');

      // 旧 run 状态未被触碰
      const old = getStatus({ repo, runId: first.runId });
      assert.equal(old.state.status, 'EVALS_PASSED');
      assert.equal(old.state.run_id, first.runId);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('启动体检：base 上 target 已满足时拒绝启动', async () => {
  await withDataRoot(async () => {
    const { repo, git } = makeRepo();
    // 让 target 在 base 就通过
    writeFileSync(join(repo, 'progress.txt'), 'done\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'done');
    const sha2 = git('rev-parse', 'HEAD').stdout.trim();
    try {
      const built = buildSimpleSpec({ task: 'already done', check: 'bash check.sh', maxIterations: 5, baseCommit: sha2 });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: ['bash', '-c', 'true'], skipPreflight: true });
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'baseline');
      assert.equal(res.verdict, 'all_targets_met');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
