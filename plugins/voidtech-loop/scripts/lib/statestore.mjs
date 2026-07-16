// 原子状态存储与项目锁（技术设计 §7）。
// 状态：写临时文件 → fsync(fd) → rename → fsync(目录 fd)；正文 SHA-256 checksum，损坏 fail closed。
// 锁：mkdir 原子创建；元数据含 run ID、PID、进程启动时间与 comm（双因子判活，防 PID 复用）；
//     陈旧接管先把锁目录原子 rename 为唯一 tombstone，仅一个进程能赢。

import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync,
  mkdirSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { canonicalJson } from './validate.mjs';

export const STATE_VERSION = 1;
const CREATING_GRACE_MS = 2000;

// CLI 可能继承当前会话中其他插件的 ${CLAUDE_PLUGIN_DATA}；只接受本插件目录，
// 其余情况按官方公式自行推导（PRD 3.3）。
export function pluginDataRoot() {
  const injected = process.env.CLAUDE_PLUGIN_DATA;
  if (injected && basename(resolve(injected)) === 'voidtech-loop') return injected;
  return join(homedir(), '.claude', 'plugins', 'data', 'voidtech-loop');
}

export function projectDataDir(gitCommonDirRealpath) {
  const key = createHash('sha256').update(gitCommonDirRealpath, 'utf8').digest('hex').slice(0, 16);
  return join(pluginDataRoot(), key);
}

// ---------- 原子状态 ----------

export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const body = { ...state };
  delete body.checksum;
  const canonical = canonicalJson(body);
  const checksum = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const payload = JSON.stringify({ ...body, checksum }, null, 2);
  atomicWrite(join(dir, 'state.json'), payload);
}

export function readState(dir) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const { checksum, ...body } = parsed;
  const expected = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  if (checksum !== expected) return { ok: false, reason: 'checksum_mismatch' };
  if (body.state_version !== STATE_VERSION) return { ok: false, reason: 'unsupported_schema' };
  // checksum 一并返回：review 层的锁内 compare-and-write 以它为前置条件（二期 §3.4）
  return { ok: true, state: body, checksum };
}

// 锁内 compare-and-write（二期技术设计 §3.4）：只承诺单机文件系统上、持 review lock 前提下的
// 条件更新，不是分布式 CAS。锁的存在被机械强制，不靠调用方自觉。
export function updateStateIfChecksum(dir, expectedChecksum, mutator) {
  if (!existsSync(join(dir, 'review.lock'))) return { ok: false, reason: 'lock_not_held' };
  const r = readState(dir);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.checksum !== expectedChecksum) return { ok: false, reason: 'state_changed', checksum: r.checksum };
  const next = mutator(structuredClone(r.state));
  writeState(dir, next);
  const after = readState(dir);
  return { ok: true, state: after.state, checksum: after.checksum };
}

export function atomicWrite(path, payload) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // 目录 fsync 在个别文件系统上不可用；rename 原子性不受影响
  }
}

// ---------- 进程身份与判活 ----------

export function processIdentity(pid = process.pid) {
  return { pid, pid_start: psField(pid, 'lstart='), pid_comm: psField(pid, 'comm=') };
}

function psField(pid, format) {
  const res = spawnSync('ps', ['-p', String(pid), '-o', format], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

export function isProcessAlive(meta) {
  if (!meta || !Number.isInteger(meta.pid)) return false;
  const start = psField(meta.pid, 'lstart=');
  if (start === '') return false;
  const comm = psField(meta.pid, 'comm=');
  return start === meta.pid_start && comm === meta.pid_comm;
}

// ---------- 项目锁 ----------

function lockDir(projectDir) {
  return join(projectDir, 'lock');
}

export function acquireLock(projectDir, meta) {
  mkdirSync(projectDir, { recursive: true });
  try {
    mkdirSync(lockDir(projectDir));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const current = inspectLock(projectDir);
    return { ok: false, reason: current.status === 'creating' ? 'creating' : 'held', holder: current.meta ?? null };
  }
  atomicWrite(join(lockDir(projectDir), 'meta.json'), JSON.stringify({ ...meta, acquired_at: new Date().toISOString() }, null, 2));
  return { ok: true };
}

// 锁所有权移交（P0-1 两阶段启动）：detach 控制器接管由准备进程获取的锁，把判活身份换成自己。
// 只允许同 run 接管；准备进程可能已退出（锁瞬时呈 stale），因此不要求 alive，但拒绝 free/异主。
export function updateLockMeta(projectDir, runId, identity) {
  const current = inspectLock(projectDir);
  if (current.status === 'free') return { ok: false, reason: 'not_held' };
  if (current.meta?.run_id !== runId) return { ok: false, reason: 'not_owner', holder: current.meta ?? null };
  atomicWrite(join(lockDir(projectDir), 'meta.json'), JSON.stringify({
    run_id: runId,
    ...identity,
    acquired_at: current.meta.acquired_at ?? new Date().toISOString(),
  }, null, 2));
  return { ok: true };
}

export function releaseLock(projectDir, runId) {
  const current = inspectLock(projectDir);
  if (current.status === 'free') return { ok: false, reason: 'not_held' };
  if (current.meta?.run_id !== runId) return { ok: false, reason: 'not_owner', holder: current.meta ?? null };
  rmSync(lockDir(projectDir), { recursive: true, force: true });
  return { ok: true };
}

// 返回 { status: 'free'|'creating'|'alive'|'stale', meta? }
export function inspectLock(projectDir) {
  const dir = lockDir(projectDir);
  if (!existsSync(dir)) return { status: 'free' };
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    // 元数据未写完：宽限期内按“创建中”，超过宽限期按陈旧处理
    let age = 0;
    try { age = Date.now() - statSync(dir).birthtimeMs; } catch { /* 拿不到时间则保守按创建中 */ }
    return age > CREATING_GRACE_MS ? { status: 'stale', meta: null } : { status: 'creating' };
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { status: 'stale', meta: null };
  }
  return isProcessAlive(meta) ? { status: 'alive', meta } : { status: 'stale', meta };
}

// 陈旧接管：rename 到唯一 tombstone，仅一个进程能赢（技术设计 §7）。
export function takeoverStaleLock(projectDir, takerId) {
  const current = inspectLock(projectDir);
  if (current.status !== 'stale') return { won: false, reason: current.status };
  const tombstone = join(projectDir, `lock.tombstone.${takerId}-${randomUUID().slice(0, 8)}`);
  try {
    renameSync(lockDir(projectDir), tombstone);
  } catch {
    return { won: false, reason: 'lost_race' };
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(tombstone, 'meta.json'), 'utf8'));
  } catch {
    // 空锁或元数据损坏的 tombstone，meta 保持 null
  }
  rmSync(tombstone, { recursive: true, force: true });
  return { won: true, meta };
}
