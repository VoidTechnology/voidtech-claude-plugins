// M3 回归测试（QA 发现）：输出落在 (256KiB, 512KiB] 区间时，证据不得静默丢弃尾部。
// 缺陷：truncated 判定为 total > HEAD_CAP + TAIL_CAP(512KiB)，该区间内 truncated=false，
// writeEvidenceFile 只写前 256KiB → 尾部（含失败信息）丢失，且不写 TRUNCATED 标记。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execEval } from '../scripts/lib/evalrunner.mjs';

// 哨兵用 printf hex 构造，确保字面量不出现在命令字符串（否则会经 "# command:" 头混入证据）
// ZZSENTINELZZ = 5a5a53454e54494e454c5a5a
const SENTINEL = 'ZZSENTINELZZ';
const GEN = "n=6000; for i in $(seq 1 $n); do printf 'padding-%06d-padding-padding-padding-padding-padding\\n' \"$i\"; done; printf '%b\\n' '\\x5a\\x5a\\x53\\x45\\x4e\\x54\\x49\\x4e\\x45\\x4c\\x5a\\x5a'";

test('M3: 约 330KiB 输出（256–512KiB 区间）证据保留尾部或明确标注 TRUNCATED', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'm3-ev-'));
  const wt = mkdtempSync(join(tmpdir(), 'm3-wt-'));
  try {
    const evalDef = {
      id: 'big-mid', role: 'target', command: GEN, shell: true,
      cwd: '.', expected_exit: 0, timeout_seconds: 60, repeat: 1,
    };
    const r = await execEval(evalDef, wt, { evidenceDir });
    const total = r.runs[0].evidence.total_bytes;
    assert.ok(total > 256 * 1024 && total <= 512 * 1024, `输出须落在 256–512KiB 区间，实际 ${total}`);
    const evidence = readFileSync(r.runs[0].evidence.path, 'utf8');
    assert.ok(
      evidence.includes(SENTINEL) || evidence.includes('TRUNCATED'),
      '证据必须保留尾部哨兵，或显式标注 TRUNCATED；不得静默丢尾',
    );
    // 命令字符串里不应出现哨兵字面量（否则断言失去意义）
    assert.equal(GEN.includes(SENTINEL), false, '哨兵不得字面出现在命令中');
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test('M3: 小输出（<256KiB）证据完整、无 TRUNCATED 噪声（不回归）', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'm3-ev-'));
  const wt = mkdtempSync(join(tmpdir(), 'm3-wt-'));
  try {
    const evalDef = {
      id: 'small', role: 'target', command: ['bash', '-c', "printf '%b\\n' '\\x5a\\x5a\\x53\\x45\\x4e\\x54\\x49\\x4e\\x45\\x4c\\x5a\\x5a'"],
      shell: false, cwd: '.', expected_exit: 0, timeout_seconds: 30, repeat: 1,
    };
    const r = await execEval(evalDef, wt, { evidenceDir });
    const evidence = readFileSync(r.runs[0].evidence.path, 'utf8');
    assert.ok(evidence.includes(SENTINEL), '小输出应完整保留');
    assert.equal(evidence.includes('TRUNCATED'), false, '小输出不应出现 TRUNCATED 标记');
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
