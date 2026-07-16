// statestore 测试：原子状态（checksum fail closed，对应 V18/PRD 5.1）与项目锁（互斥/陈旧接管，对应 V8/PRD 3.3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  writeState,
  readState,
  acquireLock,
  releaseLock,
  inspectLock,
  takeoverStaleLock,
  processIdentity,
  pluginDataRoot,
} from '../scripts/lib/statestore.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'loop-state-'));
}

const SAMPLE = {
  state_version: 1,
  run_id: 'run-test-1',
  status: 'RUNNING',
  iteration: 3,
};

test('状态写读往返，checksum 自动维护', () => {
  const dir = tempDir();
  try {
    writeState(dir, SAMPLE);
    const r = readState(dir);
    assert.equal(r.ok, true);
    assert.equal(r.state.run_id, 'run-test-1');
    assert.equal(r.state.iteration, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V18：状态文件被篡改 → checksum 不符 fail closed', () => {
  const dir = tempDir();
  try {
    writeState(dir, SAMPLE);
    const path = join(dir, 'state.json');
    const tampered = readFileSync(path, 'utf8').replace('"iteration": 3', '"iteration": 99');
    assert.ok(tampered.includes('"iteration": 99'), '篡改必须真实生效');
    writeFileSync(path, tampered);
    const r = readState(dir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'checksum_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V18：不支持的 state_version fail closed', () => {
  const dir = tempDir();
  try {
    writeState(dir, { ...SAMPLE, state_version: 999 });
    const r = readState(dir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unsupported_schema');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态文件缺失 → missing', () => {
  const dir = tempDir();
  try {
    const r = readState(dir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V8：项目锁互斥——第二次获取失败并报告持有者', () => {
  const dir = tempDir();
  try {
    const a = acquireLock(dir, { run_id: 'run-a', ...processIdentity() });
    assert.equal(a.ok, true);
    const b = acquireLock(dir, { run_id: 'run-b', ...processIdentity() });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'held');
    assert.equal(b.holder.run_id, 'run-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('释放锁校验 run_id：持有者才可释放，释放后可重新获取', () => {
  const dir = tempDir();
  try {
    acquireLock(dir, { run_id: 'run-a', ...processIdentity() });
    assert.equal(releaseLock(dir, 'run-x').ok, false);
    assert.equal(releaseLock(dir, 'run-a').ok, true);
    assert.equal(acquireLock(dir, { run_id: 'run-c', ...processIdentity() }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('存活进程的锁被判定为 alive；已退出 PID 的锁被判定为 stale', () => {
  const dir = tempDir();
  try {
    acquireLock(dir, { run_id: 'run-live', ...processIdentity() });
    assert.equal(inspectLock(dir).status, 'alive');
    releaseLock(dir, 'run-live');

    const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout.trim());
    acquireLock(dir, { run_id: 'run-dead', pid: deadPid, pid_start: 'gone', pid_comm: 'bash' });
    assert.equal(inspectLock(dir).status, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PID 复用防御：同 PID 但启动时间不符 → stale', () => {
  const dir = tempDir();
  try {
    const me = processIdentity();
    acquireLock(dir, { run_id: 'run-reuse', pid: me.pid, pid_start: 'Mon Jan  1 00:00:00 1990', pid_comm: me.pid_comm });
    assert.equal(inspectLock(dir).status, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空锁目录（元数据未写完）→ creating，宽限期内不判陈旧', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'lock'));
    assert.equal(inspectLock(dir).status, 'creating');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('陈旧接管：并发接管只有一个赢家（tombstone rename）', () => {
  const dir = tempDir();
  try {
    acquireLock(dir, { run_id: 'run-dead', pid: 999999, pid_start: 'gone', pid_comm: 'none' });
    const r1 = takeoverStaleLock(dir, 'taker-1');
    const r2 = takeoverStaleLock(dir, 'taker-2');
    const winners = [r1, r2].filter((r) => r.won);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].meta.run_id, 'run-dead');
    assert.equal(acquireLock(dir, { run_id: 'run-new', ...processIdentity() }).ok, true, '接管后锁可重新获取');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锁目录不存在 → free', () => {
  const dir = tempDir();
  try {
    assert.equal(inspectLock(dir).status, 'free');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件数据目录：忽略其他插件继承的 CLAUDE_PLUGIN_DATA', () => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = join(tmpdir(), 'codex-openai-codex');
  try {
    assert.equal(pluginDataRoot(), join(homedir(), '.claude', 'plugins', 'data', 'voidtech-loop'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test('插件数据目录：仅接受尾部为 voidtech-loop 的官方注入路径', () => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  const expected = join(tempDir(), 'voidtech-loop');
  process.env.CLAUDE_PLUGIN_DATA = expected;
  try {
    assert.equal(pluginDataRoot(), expected);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(join(expected, '..'), { recursive: true, force: true });
  }
});
