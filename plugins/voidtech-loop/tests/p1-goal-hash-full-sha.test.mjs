// P1-6：短 SHA 输入时 goal_hash 必须对应冻结进状态的完整 SHA。
// 之前 goal_hash 在 base 解析前计算、之后又替换成完整 SHA，导致状态里的 spec 与哈希对不上，
// 事后无法用哈希验证 spec 未被篡改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSimpleSpec } from '../scripts/lib/simplemode.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { startLoop, getStatus } from '../scripts/lib/lifecycle.mjs';
import { makeTestRepo, withDataRoot } from './helpers.mjs';

function makeRepo() {
  return makeTestRepo({
    prefix: 'hash-fixture-',
    files: {
      'check.sh': { content: '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', mode: 0o755 },
      'progress.txt': 'todo\n',
    },
  });
}

function fixingStub() {
  const dir = mkdtempSync(join(tmpdir(), 'hash-stub-'));
  const path = join(dir, 's.sh');
  writeFileSync(path, '#!/bin/bash\necho done > progress.txt\n', { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

test('P1-6：短 SHA 启动后，状态中的 spec 为完整 SHA 且与 goal_hash 一致', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = fixingStub();
    try {
      const shortSha = sha.slice(0, 12);
      const built = buildSimpleSpec({ task: 'make done', check: 'bash check.sh', maxIterations: 5, baseCommit: shortSha });
      const res = await startLoop({ repo, rawSpec: built.spec, overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.final.status, 'EVALS_PASSED');

      const st = getStatus({ repo, runId: res.runId });
      assert.equal(st.ok, true);
      // 冻结 spec 中是完整 40 位 SHA
      assert.match(st.state.spec.base_commit, /^[0-9a-f]{40}$/);
      assert.equal(st.state.spec.base_commit, sha);
      // goal_hash 与冻结 spec 一致：对冻结 spec 重新校验得到相同哈希（规范化幂等）
      const revalidated = validateSpecObject(st.state.spec);
      assert.equal(revalidated.ok, true, JSON.stringify(revalidated.errors));
      assert.equal(revalidated.goal_hash, st.state.goal_hash, '冻结 spec 重算哈希必须等于 goal_hash');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

test('P1-6：完整 SHA 输入路径哈希不变（不因修复引入重算差异）', () => {
  const spec = {
    schema_version: 1,
    goal_id: 'hash-stable',
    task: 'x',
    base_commit: 'a'.repeat(40),
    budgets: { max_iterations: 3 },
    evals: [{ id: 't', role: 'target', command: ['true'], timeout_seconds: 60 }],
  };
  const v1 = validateSpecObject(spec);
  const v2 = validateSpecObject(v1.normalized);
  assert.equal(v1.ok, true);
  assert.equal(v1.goal_hash, v2.goal_hash, '规范化必须幂等，否则重校验会改变哈希');
});
