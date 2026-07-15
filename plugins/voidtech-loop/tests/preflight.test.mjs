// preflight 测试：V9（非 macOS arm64 拒绝）与关键命令/版本探测（注入 probe，不依赖宿主）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight, compareVersions } from '../scripts/lib/preflight.mjs';

const allPresent = {
  hasCommand: () => true,
  claudeVersion: () => '2.1.210',
};

test('V9：非 macOS arm64 被拒绝', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const r = preflight({ platform, arch, probe: allPresent });
    assert.equal(r.ok, false, `${platform}/${arch} 应被拒绝`);
    assert.ok(r.problems.some((p) => p.code === 'unsupported_os'));
  }
});

test('macOS arm64 且命令齐全 → 通过', () => {
  const r = preflight({ platform: 'darwin', arch: 'arm64', probe: allPresent });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('缺少关键命令被报告', () => {
  const probe = { hasCommand: (c) => c !== 'jq', claudeVersion: () => '2.1.210' };
  const r = preflight({ platform: 'darwin', arch: 'arm64', probe });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === 'missing_command' && p.message.includes('jq')));
});

test('Claude Code 版本低于下限被拒绝', () => {
  const probe = { hasCommand: () => true, claudeVersion: () => '2.1.100' };
  const r = preflight({ platform: 'darwin', arch: 'arm64', probe });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === 'claude_too_old'));
});

test('compareVersions 语义', () => {
  assert.ok(compareVersions('2.1.210', '2.1.210') === 0);
  assert.ok(compareVersions('2.1.211', '2.1.210') > 0);
  assert.ok(compareVersions('2.1.99', '2.1.210') < 0);
  assert.ok(compareVersions('2.2.0', '2.1.999') > 0);
  assert.ok(compareVersions('3.0.0', '2.9.9') > 0);
});
