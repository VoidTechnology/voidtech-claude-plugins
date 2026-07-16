// M6 回归测试（dogfood 途中发现）：审计不得把 refs/remotes/* 的任何变化当硬违规。
// 缺陷：compareAudit 只豁免 refs/remotes/* 的纯前进，删除/分叉会判 violation。但 worker 碰不到
// 远端跟踪引用（guard 拦 fetch/remote），且它们与 candidate/checkpoint 完整性无关——上游分支
// 被合并后删除、force-push 等都是良性的本地跟踪状态变化。实测中它曾误杀一次正常循环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAudit } from '../scripts/lib/gitops.mjs';

const EMPTY = { files: {}, worktreePointers: {} };
const snap = (refs) => ({ ...EMPTY, refs });

test('M6: 远端跟踪引用被删除 → 记录而非违规', () => {
  const before = snap({ 'refs/remotes/origin/feature': 'aaaa', 'refs/heads/main': 'main1' });
  const after = snap({ 'refs/heads/main': 'main1' });
  const cmp = compareAudit('/tmp', before, after);
  assert.equal(cmp.ok, true, JSON.stringify(cmp.violations));
  assert.ok(cmp.recorded.some((r) => r.item === 'refs/remotes/origin/feature'));
});

test('M6: 远端跟踪引用分叉/force-update → 记录而非违规', () => {
  const before = snap({ 'refs/remotes/origin/main': 'aaaa' });
  const after = snap({ 'refs/remotes/origin/main': 'bbbb' });
  const cmp = compareAudit('/tmp', before, after);
  assert.equal(cmp.ok, true, JSON.stringify(cmp.violations));
  assert.ok(cmp.recorded.some((r) => r.item === 'refs/remotes/origin/main'));
});

test('M6: 新增远端跟踪引用 → 记录而非违规', () => {
  const before = snap({});
  const after = snap({ 'refs/remotes/origin/new': 'cccc' });
  const cmp = compareAudit('/tmp', before, after);
  assert.equal(cmp.ok, true, JSON.stringify(cmp.violations));
});

test('M6: 本地分支被改写仍是硬违规（不回归安全边界）', () => {
  const before = snap({ 'refs/heads/loop/x': 'aaaa' });
  const after = snap({ 'refs/heads/loop/x': 'bbbb' });
  const cmp = compareAudit('/tmp', before, after);
  assert.equal(cmp.ok, false, '本地 ref 改写必须仍被判违规');
  assert.ok(cmp.violations.some((v) => v.kind === 'ref' && v.item === 'refs/heads/loop/x'));
});

test('M6: gitdir 文件篡改仍是硬违规（不回归）', () => {
  const before = { refs: {}, worktreePointers: {}, files: { config: 'h1' } };
  const after = { refs: {}, worktreePointers: {}, files: { config: 'h2' } };
  const cmp = compareAudit('/tmp', before, after);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.violations.some((v) => v.kind === 'gitdir'));
});
