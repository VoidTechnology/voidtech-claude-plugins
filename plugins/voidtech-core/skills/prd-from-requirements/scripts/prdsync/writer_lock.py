"""PRD 工作树全局单写者锁（技术设计 §2.1）。

目录锁：mkdir 原子创建 `_source/reconciliation/writer.lock/`。meta.json 记录
owner 的 pid、pid 启动时间与进程名（双因子判活，排除 PID 复用）、operationId
与获取时间。判活失败才允许接管；接管者从 meta 带回原 operationId，必须先恢复
原 operation，接管留 tombstone。锁元数据缺失或损坏时按非终态 operation 数量
0/1/≥2 分别清锁/要求恢复/fail closed。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from .canonical_store import atomic_write_json, read_json

LOCK_RELPATH = "_source/reconciliation/writer.lock"
TOMBSTONES_RELPATH = "_source/reconciliation/tombstones"
OPERATIONS_RELPATH = "_source/reconciliation/operations"
TERMINAL_PHASES = {"committed", "aborted", "conflict"}


class LockError(Exception):
    pass


class LockHeld(LockError):
    """锁被存活 owner 持有。"""


class RecoveryRequired(LockError):
    """锁元数据损坏且恰有一个非终态 operation，必须先恢复它。"""

    def __init__(self, operation_id):
        super().__init__(f"recovery required for {operation_id}")
        self.operation_id = operation_id


class FailClosed(LockError):
    """单写者不变式已被破坏（≥2 个非终态 operation），要求人工介入。"""


def _lock_dir(root) -> Path:
    return Path(root) / LOCK_RELPATH


def _meta_path(root) -> Path:
    return _lock_dir(root) / "meta.json"


def _ps_field(pid: int, field: str):
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", f"{field}="],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    value = out.stdout.strip()
    return value or None


def process_identity(pid: int):
    """返回 {startedAt, processName}；进程不存在返回 None。"""
    started = _ps_field(pid, "lstart")
    name = _ps_field(pid, "comm")
    if started is None or name is None:
        return None
    return {"startedAt": started, "processName": name}


def list_non_terminal_operations(root):
    """扫描全部 operation manifest，返回非终态的 operationId 列表。

    不可解析的 manifest 按非终态计（保守，fail closed）。
    """
    ops_dir = Path(root) / OPERATIONS_RELPATH
    result = []
    if not ops_dir.is_dir():
        return result
    for path in sorted(ops_dir.glob("*.json")):
        try:
            manifest = read_json(path)
            phase = manifest["phase"]
            operation_id = manifest["operationId"]
        except (ValueError, KeyError, OSError):
            result.append(path.stem)
            continue
        if phase not in TERMINAL_PHASES:
            result.append(operation_id)
    return result


class LockHandle:
    def __init__(self, root, operation_id, recovery_required=None):
        self.root = Path(root)
        self.operation_id = operation_id
        self.recovery_required = recovery_required
        self._released = False

    def rebind(self, operation_id):
        """恢复完成后把锁重新绑定到新 operation。"""
        if self.recovery_required is not None:
            raise LockError("recovery pending; call clear_recovery() first")
        self.operation_id = operation_id
        _write_meta(self.root, operation_id)

    def clear_recovery(self):
        self.recovery_required = None

    def release(self):
        if not self._released:
            shutil.rmtree(_lock_dir(self.root), ignore_errors=True)
            self._released = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()
        return False


def _write_meta(root, operation_id):
    identity = process_identity(os.getpid()) or {"startedAt": "", "processName": ""}
    atomic_write_json(_meta_path(root), {
        "pid": os.getpid(),
        "pidStartedAt": identity["startedAt"],
        "processName": identity["processName"],
        "operationId": operation_id,
        "acquiredAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })


def _write_tombstone(root, stale_meta):
    tomb_dir = Path(root) / TOMBSTONES_RELPATH
    name = f"{stale_meta.get('operationId', 'unknown')}-{stale_meta.get('pid', 0)}.json"
    atomic_write_json(tomb_dir / name, {
        "takenOverBy": os.getpid(),
        "takenOverAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "staleMeta": stale_meta,
    })


def force_clear(root):
    """强制清锁。仅供恢复流程在锁元数据损坏、owner 无法判定时使用。"""
    shutil.rmtree(_lock_dir(root), ignore_errors=True)


def acquire(root, operation_id) -> LockHandle:
    """获取全局单写者锁。

    - 成功：返回 handle（recovery_required 为 None）。
    - 陈旧锁接管：返回 handle 且 recovery_required 为原 operationId，
      调用方必须先完成恢复再 clear_recovery() + rebind()。
    - 存活 owner：抛 LockHeld。
    - 元数据损坏：按 0/1/≥2 非终态 operation 清锁重试 / 抛 RecoveryRequired /
      抛 FailClosed。
    """
    root = Path(root)
    for _ in range(2):
        try:
            _lock_dir(root).mkdir(parents=True)
        except FileExistsError:
            pass
        else:
            _write_meta(root, operation_id)
            return LockHandle(root, operation_id)

        meta = None
        try:
            meta = read_json(_meta_path(root))
            if not isinstance(meta.get("pid"), int):
                meta = None
        except (OSError, ValueError):
            meta = None

        if meta is None:
            pending = list_non_terminal_operations(root)
            if len(pending) == 0:
                force_clear(root)
                continue
            if len(pending) == 1:
                raise RecoveryRequired(pending[0])
            raise FailClosed(f"{len(pending)} non-terminal operations with corrupt lock meta")

        identity = process_identity(meta["pid"])
        alive = (
            identity is not None
            and identity["startedAt"] == meta.get("pidStartedAt")
            and identity["processName"] == meta.get("processName")
        )
        if alive:
            raise LockHeld(f"held by pid {meta['pid']} for {meta.get('operationId')}")

        # 陈旧锁接管：带回原 operationId，恢复前禁止新建 operation。
        _write_tombstone(root, meta)
        original = meta.get("operationId")
        _write_meta(root, original)
        return LockHandle(root, original, recovery_required=original)

    raise LockError("failed to acquire writer lock")
