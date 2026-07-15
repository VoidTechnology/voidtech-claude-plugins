// M2 回归测试（QA 发现）：runWorker 从 worker 的完整 JSON 输出解析 cost 与 permission_denials。
// 缺陷：原实现从被截断到 8KiB 的 eval summary 里 JSON.parse，当 claude -p 的 result 字段较大
// （常态 >8KiB）时解析恒失败 → cost 恒 unavailable、permission_denials 恒空 →
// PRD 5.3 的“连续两轮同一请求被拒 → STOPPED(blocked)”熔断静默失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorker } from '../scripts/lib/workerio.mjs';

function makeWorktree() {
  return mkdtempSync(join(tmpdir(), 'm2-wt-'));
}

// 构造一个输出「大 result 字段的合法单行 JSON」的 stub worker（模拟 claude -p --output-format json）。
function makeJsonStub(jsonObj) {
  const dir = mkdtempSync(join(tmpdir(), 'm2-stub-'));
  const jsonFile = join(dir, 'out.json');
  writeFileSync(jsonFile, JSON.stringify(jsonObj));
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, `#!/bin/bash\ncat '${jsonFile}'\n`, { mode: 0o755 });
  return { dir, argv: ['bash', stub] };
}

test('M2: worker result 字段达 20KiB 时仍能解析出 cost_usd', async () => {
  const wt = makeWorktree();
  const stub = makeJsonStub({
    total_cost_usd: 0.5,
    session_id: 'sess-1',
    permission_denials: [],
    result: 'x'.repeat(20000),
  });
  try {
    const r = await runWorker({ worktree: wt, prompt: 'x', timeoutSeconds: 30, overrideArgv: stub.argv });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.cost_usd, 0.5, 'cost 不得因输出超 8KiB 而丢失');
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('M2: worker result 字段达 20KiB 时仍能解析出 permission_denials', async () => {
  const wt = makeWorktree();
  const stub = makeJsonStub({
    total_cost_usd: 0.1,
    session_id: 'sess-2',
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }],
    result: 'y'.repeat(20000),
  });
  try {
    const r = await runWorker({ worktree: wt, prompt: 'x', timeoutSeconds: 30, overrideArgv: stub.argv });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.permission_denials.length, 1, 'permission_denials 不得因输出超 8KiB 而丢失');
    assert.ok(r.permission_denials[0].includes('Bash'), '规范化后应含工具名');
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('M2: 小输出（<8KiB）仍正常解析（不回归）', async () => {
  const wt = makeWorktree();
  const stub = makeJsonStub({ total_cost_usd: 0.02, session_id: 's', permission_denials: [], result: 'small' });
  try {
    const r = await runWorker({ worktree: wt, prompt: 'x', timeoutSeconds: 30, overrideArgv: stub.argv });
    assert.equal(r.cost_usd, 0.02);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  }
});
