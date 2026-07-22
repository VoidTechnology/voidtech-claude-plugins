"""门 1 事务地基 fixture：提交边界崩溃、发布冲突、base CAS、双提交点、
文件动作全集、路径穿越、proposal 过期与篡改（技术设计 §11）。"""

import os
import unittest
from pathlib import Path

from worktree_fixture import (
    LEDGER, LEGACY, MATRIX, MODULE_PRD, ORIGINAL_MATRIX, STAGED_LEDGER,
    STAGED_MATRIX, SimulatedCrash, controller_record, crash_hook,
    run_operation, sample_records, snapshot, sync_plan, temp_worktree,
)

from prdsync import effective_view, operation_engine as engine, writer_lock
from prdsync.canonical_store import read_json


def applied_revision(root):
    state = read_json(root / "_source/sync-state.json")
    return state["sources"]["requirements-xlsx"]["appliedRevision"]


class CrashRecoveryTest(unittest.TestCase):
    """四个提交边界 + publishing 逐文件崩溃，恢复后与一次成功执行逐字节一致。"""

    def test_crash_then_recover_is_byte_identical(self):
        ok_root = temp_worktree(self)
        run_operation(ok_root)
        expected = snapshot(ok_root)

        driver_points = ["segment-committed"]
        hook_points = [
            f"before:{MATRIX}", f"backup:{MATRIX}", f"after:{MATRIX}",
            f"before:{LEDGER}", f"after:{LEDGER}",
            f"before:{LEGACY}", f"backup:{LEGACY}",
            "before-commit", "after-commit",
        ]
        for point in driver_points + hook_points:
            with self.subTest(crash=point):
                root = temp_worktree(self)
                kwargs = ({"crash_at": point} if point in driver_points
                          else {"hook": crash_hook(point)})
                with self.assertRaises(SimulatedCrash):
                    run_operation(root, **kwargs)
                engine.recover_worktree(root)
                self.assertEqual(snapshot(root), expected)

    def test_prepared_without_segment_aborts(self):
        root = temp_worktree(self)
        with self.assertRaises(SimulatedCrash):
            run_operation(root, crash_at="before-segment")
        actions = engine.recover_worktree(root)
        self.assertEqual(actions, {"op-t-001": "aborted"})
        self.assertEqual((root / MATRIX).read_text(encoding="utf-8"), ORIGINAL_MATRIX)
        self.assertFalse((engine.operation_dir(root, "op-t-001") / "staging").exists())


class PublishConflictTest(unittest.TestCase):
    """部分发布后 digest 冲突：栅栏保持，覆盖与回滚两种恢复各自终态正确。"""

    def _crash_then_third_party_write(self):
        root = temp_worktree(self)
        with self.assertRaises(SimulatedCrash):
            run_operation(root, hook=crash_hook(f"after:{MATRIX}"))
        # 第三方在恢复前抢先创建了本 operation 计划新建的目标。
        (root / LEDGER).parent.mkdir(parents=True, exist_ok=True)
        (root / LEDGER).write_text("third-party junk\n", encoding="utf-8")
        with self.assertRaises(engine.PublishConflict):
            engine.recover_worktree(root)
        manifest = engine.load_manifest(root, "op-t-001")
        self.assertEqual(manifest["phase"], "publish-conflict")
        return root

    def test_fence_blocks_reads_and_choice_is_required(self):
        root = self._crash_then_third_party_write()
        with self.assertRaises(effective_view.ReadFenceError):
            effective_view.resolve_view(root)
        with self.assertRaises(engine.RecoveryChoiceRequired):
            engine.recover_worktree(root)

    def test_override_reaches_success_state(self):
        ok_root = temp_worktree(self)
        run_operation(ok_root)
        root = self._crash_then_third_party_write()
        engine.recover_worktree(root, conflict_choice="override")
        self.assertEqual(snapshot(root), snapshot(ok_root))

    def test_keep_third_party_rolls_back_in_reverse(self):
        root = self._crash_then_third_party_write()
        engine.recover_worktree(root, conflict_choice="keep")
        manifest = engine.load_manifest(root, "op-t-001")
        self.assertEqual(manifest["phase"], "conflict")
        # 已发布的改写回滚到 backup；第三方内容保留；未发布的删除未执行。
        self.assertEqual((root / MATRIX).read_text(encoding="utf-8"), ORIGINAL_MATRIX)
        self.assertEqual((root / LEDGER).read_text(encoding="utf-8"), "third-party junk\n")
        self.assertTrue((root / LEGACY).exists())
        self.assertEqual(applied_revision(root), "rev-base01")
        # staging 与 backup 不清理（终态后只归档）。
        self.assertTrue((root / manifest["files"][0]["stagedPath"]).exists())
        self.assertTrue((root / manifest["files"][0]["backupPath"]).exists())
        self.assertEqual(
            read_json(engine.proposal_path(root, "prop-t-001"))["status"], "expired")

    def test_third_party_delete_of_target_conflicts(self):
        # 发布途中目标缺失且 oldDigest 非 null：视为第三方删除 → publish-conflict。
        # （发布前的带外删除由 base CAS 拦截，见 BaseCasTest。）
        root = temp_worktree(self)
        with self.assertRaises(SimulatedCrash):
            run_operation(root, hook=crash_hook(f"before:{MATRIX}"))
        os.remove(root / MATRIX)
        with self.assertRaises(engine.PublishConflict):
            engine.recover_worktree(root)
        self.assertEqual(engine.load_manifest(root, "op-t-001")["phase"],
                         "publish-conflict")


class BaseCasTest(unittest.TestCase):
    """带外修改与双写竞争的 CAS 分支。"""

    def test_out_of_band_master_edit_blocks_publish(self):
        root = temp_worktree(self)
        proposal = engine.build_proposal(
            root, proposal_id="prop-t-001", proposal_kind="sync",
            candidate_revision="rev-new01",
            affected_files=[entry["path"] for entry in sync_plan()])
        with writer_lock.acquire(root, "op-t-001"):
            engine.create_operation(
                root, proposal, operation_id="op-t-001", operation_kind="sync",
                plan=sync_plan(), target_source="requirements-xlsx",
                target_revision="rev-new01")
            engine.commit_segment(root, "op-t-001", sample_records())
            engine.validate_operation(root, "op-t-001")
            (root / MODULE_PRD).write_text("# edited out of band\n", encoding="utf-8")
            with self.assertRaises(engine.BaseChanged):
                engine.publish(root, "op-t-001")
        # 不发布由旧主本生成的任何暂存内容。
        self.assertEqual((root / MATRIX).read_text(encoding="utf-8"), ORIGINAL_MATRIX)
        self.assertFalse((root / LEDGER).exists())
        self.assertTrue((root / LEGACY).exists())
        self.assertEqual(engine.load_manifest(root, "op-t-001")["phase"], "conflict")
        self.assertEqual(
            read_json(engine.proposal_path(root, "prop-t-001"))["status"], "expired")

    def test_second_proposal_on_stale_base_expires(self):
        root = temp_worktree(self)
        stale = engine.build_proposal(
            root, proposal_id="prop-t-002", proposal_kind="sync",
            candidate_revision="rev-new01", affected_files=[MATRIX])
        run_operation(root)  # 先发布者胜出
        with writer_lock.acquire(root, "op-t-002"):
            with self.assertRaises(engine.ProposalExpired):
                engine.create_operation(
                    root, stale, operation_id="op-t-002", operation_kind="sync",
                    plan=[{"path": MATRIX, "action": "write", "content": "x\n"}],
                    target_source="requirements-xlsx", target_revision="rev-new01")
        # 先发布者不被覆盖。
        self.assertEqual((root / MATRIX).read_text(encoding="utf-8"), STAGED_MATRIX)
        self.assertEqual(
            read_json(engine.proposal_path(root, "prop-t-002"))["status"], "expired")


class ProposalIntegrityTest(unittest.TestCase):
    def test_tampered_payload_rejected(self):
        root = temp_worktree(self)
        proposal = engine.build_proposal(
            root, proposal_id="prop-t-001", proposal_kind="sync",
            candidate_revision="rev-new01", affected_files=[MATRIX])
        proposal["affectedFiles"] = [MATRIX, MODULE_PRD]  # 确认后篡改载荷
        with writer_lock.acquire(root, "op-t-001"):
            with self.assertRaises(engine.ProposalTampered):
                engine.create_operation(
                    root, proposal, operation_id="op-t-001", operation_kind="sync",
                    plan=[{"path": MATRIX, "action": "write", "content": "x\n"}],
                    target_source="requirements-xlsx", target_revision="rev-new01")


class CommitPointTest(unittest.TestCase):
    """双提交点：同步类推进 appliedRevision，非同步类原子翻转 operationState。"""

    def test_sync_commit_advances_applied_and_clears_pending(self):
        root = temp_worktree(self)
        run_operation(root)
        state = read_json(root / "_source/sync-state.json")
        cursors = state["sources"]["requirements-xlsx"]
        self.assertEqual(cursors["appliedRevision"], "rev-new01")
        self.assertIsNone(cursors["pendingRevision"])

    def test_sync_crash_after_commit_point_finalizes_without_choice(self):
        root = temp_worktree(self)
        with self.assertRaises(SimulatedCrash):
            run_operation(root, hook=crash_hook("after-commit"))
        self.assertEqual(applied_revision(root), "rev-new01")
        self.assertEqual(engine.load_manifest(root, "op-t-001")["phase"], "publishing")
        actions = engine.recover_worktree(root)
        self.assertEqual(actions, {"op-t-001": "finalized"})
        self.assertEqual(engine.load_manifest(root, "op-t-001")["phase"], "committed")

    def test_maintain_commit_is_phase_flip_and_leaves_sync_state(self):
        root = temp_worktree(self)
        state_before = (root / "_source/sync-state.json").read_bytes()
        plan = [{"path": MATRIX, "action": "write", "content": STAGED_MATRIX}]
        with self.assertRaises(SimulatedCrash):
            run_operation(root, kind="maintain", plan=plan,
                          records=[controller_record()],
                          hook=crash_hook("before-commit"))
        self.assertEqual(engine.load_manifest(root, "op-t-001")["phase"], "publishing")
        engine.recover_worktree(root)
        manifest = engine.load_manifest(root, "op-t-001")
        self.assertEqual(manifest["phase"], "committed")
        self.assertEqual(manifest["commitPoint"], "operationState")
        self.assertEqual((root / "_source/sync-state.json").read_bytes(), state_before)


class FileActionTest(unittest.TestCase):
    def test_action_set_backup_and_null_semantics(self):
        root = temp_worktree(self)
        run_operation(root)
        manifest = engine.load_manifest(root, "op-t-001")
        by_path = {entry["path"]: entry for entry in manifest["files"]}
        # 改写：backup 必有且为原内容。
        backup = root / by_path[MATRIX]["backupPath"]
        self.assertEqual(backup.read_text(encoding="utf-8"), ORIGINAL_MATRIX)
        # 新建：无 backup、oldDigest 为 null。
        self.assertIsNone(by_path[LEDGER]["backupPath"])
        self.assertIsNone(by_path[LEDGER]["oldDigest"])
        self.assertEqual((root / LEDGER).read_text(encoding="utf-8"), STAGED_LEDGER)
        # 删除：目标消失、backup 保留原内容。
        self.assertFalse((root / LEGACY).exists())
        self.assertEqual((root / by_path[LEGACY]["backupPath"]).read_text(encoding="utf-8"),
                         "# legacy module\n")


class PathSafetyTest(unittest.TestCase):
    def _create(self, root, plan):
        proposal = engine.build_proposal(
            root, proposal_id="prop-t-001", proposal_kind="sync",
            candidate_revision="rev-new01", affected_files=[])
        with writer_lock.acquire(root, "op-t-001"):
            engine.create_operation(
                root, proposal, operation_id="op-t-001", operation_kind="sync",
                plan=plan, target_source="requirements-xlsx",
                target_revision="rev-new01")

    def test_traversal_and_absolute_rejected(self):
        for bad in ("../outside.md", "/etc/target.md",
                    "01-portal/../../outside.md",
                    "_source/reconciliation/decisions/000001-op-x.jsonl"):
            with self.subTest(path=bad):
                root = temp_worktree(self)
                with self.assertRaises(engine.PathViolation):
                    self._create(root, [{"path": bad, "action": "write", "content": "x"}])

    def test_symlink_escape_rejected(self):
        root = temp_worktree(self)
        outside = root.parent / "outside-dir"
        outside.mkdir()
        (outside / "victim.md").write_text("outside\n", encoding="utf-8")
        (root / "01-portal/evil-dir").symlink_to(outside)
        with self.assertRaises(engine.PathViolation):
            self._create(root, [{"path": "01-portal/evil-dir/victim.md",
                                 "action": "write", "content": "x"}])

    def test_symlink_file_escape_rejected(self):
        root = temp_worktree(self)
        outside_file = root.parent / "victim.md"
        outside_file.write_text("outside\n", encoding="utf-8")
        (root / "01-portal/evil-link.md").symlink_to(outside_file)
        with self.assertRaises(engine.PathViolation):
            self._create(root, [{"path": "01-portal/evil-link.md",
                                 "action": "write", "content": "x"}])


if __name__ == "__main__":
    unittest.main()
