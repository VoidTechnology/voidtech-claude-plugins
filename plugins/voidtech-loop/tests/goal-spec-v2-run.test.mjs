// Task 2.3：v2 spec 贯通 baseline / controller / accept（技术设计 §4.4，P2-03）。
// agent_review 不参与 EVALS_PASSED；完整 v2 spec（含新字段）进入冻结 state 与 goal hash；
// v1 行为不变（由既有测试与 golden 集保证）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLoop, acceptRun, getStatus } from '../scripts/lib/lifecycle.mjs';
import { validateSpecObject } from '../scripts/lib/validate.mjs';
import { runBaseline } from '../scripts/lib/baseline.mjs';
import { makeTestRepo, withDataRoot } from './helpers.mjs';

function makeRepo() {
  return makeTestRepo({
    prefix: 'v2-run-fixture-',
    files: {
      'check.sh': { content: '#!/bin/bash\n[ "$(cat progress.txt 2>/dev/null)" = "done" ]\n', mode: 0o755 },
      'progress.txt': 'todo\n',
    },
  });
}

function stubThatFixes() {
  const dir = mkdtempSync(join(tmpdir(), 'v2-stub-'));
  const path = join(dir, 's.sh');
  writeFileSync(path, `#!/bin/bash
CTX="$1"
PROMPT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['prompt'])" "$CTX")
if grep -q '上一轮失败的 eval' <<<"$PROMPT"; then echo done > progress.txt; else echo half > progress.txt; fi
`, { mode: 0o755 });
  return { dir, argv: ['bash', path] };
}

function v2RawSpec(baseCommit) {
  return {
    schema_version: 2,
    goal_id: 'v2-payment',
    task: 'Fix failing check with v2 spec',
    base_commit: baseCommit,
    budgets: { max_iterations: 5 },
    evals: [{ id: 'check', role: 'target', command: ['bash', 'check.sh'], timeout_seconds: 60 }],
    agent_review: [{
      id: 'api-compat',
      criterion: 'Verify public API stays source-compatible.',
      required: true,
      evidence_scope: ['candidate_diff'],
    }],
    review_policy: { default_mode: 'suggestion', bounded_delegate_allowed: false },
  };
}

test('v2 baseline 只执行 evals：agent_review 不影响 startable 裁定', async () => {
  const { repo, sha } = makeRepo();
  try {
    const v = validateSpecObject(v2RawSpec(sha));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const baseline = await runBaseline(v.normalized, { repo });
    assert.equal(baseline.verdict, 'startable', JSON.stringify(baseline));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v2 run 端到端：达到 EVALS_PASSED，agent_review 完整冻结进 state，accept 走二期事务', async () => {
  await withDataRoot(async () => {
    const { repo, sha } = makeRepo();
    const stub = stubThatFixes();
    try {
      const res = await startLoop({ repo, rawSpec: v2RawSpec(sha), overrideArgv: stub.argv, skipPreflight: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      // agent_review 不参与 EVALS_PASSED：仅 evals 全过即进入机器验收终态
      assert.equal(res.final.status, 'EVALS_PASSED');

      const status = getStatus({ repo, runId: res.runId });
      assert.equal(status.state.spec.schema_version, 2);
      assert.equal(status.state.spec.agent_review[0].id, 'api-compat', '完整 v2 spec 进入冻结 state');
      assert.equal(status.state.spec.review_policy.bounded_delegate_allowed, false);

      // 冻结 hash 与重算一致：v2 新字段进入 goal hash
      const recomputed = validateSpecObject(status.state.spec);
      assert.equal(recomputed.ok, true);
      assert.equal(recomputed.goal_hash, status.state.goal_hash);

      const acc = await acceptRun({ repo, runId: res.runId });
      assert.equal(acc.ok, true, JSON.stringify(acc));
      assert.equal(acc.review.review_integrity, 'committed');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});
