"""overlay resolver 与读取栅栏（技术设计 §6、§9）。"""

import unittest

from worktree_fixture import (
    LEDGER, LEGACY, MATRIX, sample_records, sync_plan, temp_worktree,
)

from prdsync import effective_view, operation_engine as engine, writer_lock


class OverlayResolverTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_worktree(self)
        proposal = engine.build_proposal(
            self.root, proposal_id="prop-t-001", proposal_kind="sync",
            candidate_revision="rev-new01",
            affected_files=[entry["path"] for entry in sync_plan()])
        with writer_lock.acquire(self.root, "op-t-001"):
            self.manifest = engine.create_operation(
                self.root, proposal, operation_id="op-t-001",
                operation_kind="sync", plan=sync_plan(),
                target_source="requirements-xlsx", target_revision="rev-new01")
            engine.commit_segment(self.root, "op-t-001", sample_records())

    def test_overlay_maps_each_logical_file_once(self):
        view = effective_view.resolve_view(self.root, "op-t-001")
        by_path = {entry["path"]: entry for entry in self.manifest["files"]}
        # 改写与新建指向 staging；删除的逻辑文件不出现。
        self.assertEqual(view[MATRIX], self.root / by_path[MATRIX]["stagedPath"])
        self.assertEqual(view[LEDGER], self.root / by_path[LEDGER]["stagedPath"])
        self.assertNotIn(LEGACY, view)
        # reconciliation 区（staging 镜像、manifest）不作为逻辑文件重复计入。
        self.assertFalse(any(p.startswith("_source/reconciliation/") for p in view))

    def test_current_view_without_operation(self):
        view = effective_view.resolve_view(self.root)
        self.assertEqual(view[MATRIX], self.root / MATRIX)
        self.assertIn(LEGACY, view)

    def test_fence_blocks_current_view(self):
        manifest = engine.load_manifest(self.root, "op-t-001")
        manifest["phase"] = "publishing"
        engine._save_manifest(self.root, manifest)
        with self.assertRaises(effective_view.ReadFenceError):
            effective_view.resolve_view(self.root)
        # 带 operation-id 的预提交视图不受栅栏限制。
        effective_view.resolve_view(self.root, "op-t-001")


if __name__ == "__main__":
    unittest.main()
