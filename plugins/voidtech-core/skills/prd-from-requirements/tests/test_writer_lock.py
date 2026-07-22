"""门 1「双写竞争（锁）」与「锁异常」fixture（技术设计 §2.1、§11）。"""

import json
import os
import subprocess
import unittest

from worktree_fixture import temp_worktree

from prdsync import writer_lock


def _write_meta(root, meta):
    path = root / writer_lock.LOCK_RELPATH / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta), encoding="utf-8")


def _fake_operation(root, operation_id, phase):
    path = root / writer_lock.OPERATIONS_RELPATH / f"{operation_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"operationId": operation_id, "phase": phase}),
                    encoding="utf-8")


class WriterLockTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_worktree(self)

    def test_second_acquire_fails_while_held(self):
        handle = writer_lock.acquire(self.root, "op-a-1")
        try:
            with self.assertRaises(writer_lock.LockHeld):
                writer_lock.acquire(self.root, "op-b-1")
        finally:
            handle.release()
        # 释放后可再次获取。
        writer_lock.acquire(self.root, "op-b-1").release()

    def test_pid_reuse_detected_as_stale(self):
        # 同 pid、不同启动时间与进程名：双因子判活必须判定为 PID 复用。
        _write_meta(self.root, {
            "pid": os.getpid(), "pidStartedAt": "Thu Jan  1 00:00:00 1970",
            "processName": "ghost-process", "operationId": "op-ghost-1",
            "acquiredAt": "1970-01-01T00:00:00+0000",
        })
        handle = writer_lock.acquire(self.root, "op-new-1")
        try:
            self.assertEqual(handle.recovery_required, "op-ghost-1")
            tombs = list((self.root / writer_lock.TOMBSTONES_RELPATH).glob("*.json"))
            self.assertTrue(tombs, "takeover must leave a tombstone")
        finally:
            handle.release()

    def test_dead_pid_detected_as_stale(self):
        proc = subprocess.Popen(["true"])
        proc.wait()
        _write_meta(self.root, {
            "pid": proc.pid, "pidStartedAt": "Thu Jan  1 00:00:00 1970",
            "processName": "true", "operationId": "op-dead-1", "acquiredAt": "x",
        })
        handle = writer_lock.acquire(self.root, "op-new-1")
        try:
            self.assertEqual(handle.recovery_required, "op-dead-1")
        finally:
            handle.release()

    def test_takeover_blocks_new_operation_until_recovery(self):
        _write_meta(self.root, {
            "pid": os.getpid(), "pidStartedAt": "Thu Jan  1 00:00:00 1970",
            "processName": "ghost-process", "operationId": "op-ghost-1",
            "acquiredAt": "x",
        })
        handle = writer_lock.acquire(self.root, "op-new-1")
        try:
            with self.assertRaises(writer_lock.LockError):
                handle.rebind("op-new-1")
            handle.clear_recovery()
            handle.rebind("op-new-1")
        finally:
            handle.release()

    def test_corrupt_meta_zero_pending_clears_lock(self):
        _write_meta(self.root, {"not": "valid meta"})
        handle = writer_lock.acquire(self.root, "op-new-1")
        self.assertIsNone(handle.recovery_required)
        handle.release()

    def test_corrupt_meta_one_pending_requires_recovery(self):
        _write_meta(self.root, {"not": "valid meta"})
        _fake_operation(self.root, "op-x-1", "prepared")
        with self.assertRaises(writer_lock.RecoveryRequired) as ctx:
            writer_lock.acquire(self.root, "op-new-1")
        self.assertEqual(ctx.exception.operation_id, "op-x-1")

    def test_corrupt_meta_two_pending_fails_closed(self):
        _write_meta(self.root, {"not": "valid meta"})
        _fake_operation(self.root, "op-x-1", "prepared")
        _fake_operation(self.root, "op-x-2", "publishing")
        with self.assertRaises(writer_lock.FailClosed):
            writer_lock.acquire(self.root, "op-new-1")

    def test_terminal_operations_do_not_block_clearing(self):
        _write_meta(self.root, {"not": "valid meta"})
        _fake_operation(self.root, "op-x-1", "committed")
        _fake_operation(self.root, "op-x-2", "aborted")
        _fake_operation(self.root, "op-x-3", "conflict")
        handle = writer_lock.acquire(self.root, "op-new-1")
        self.assertIsNone(handle.recovery_required)
        handle.release()


if __name__ == "__main__":
    unittest.main()
