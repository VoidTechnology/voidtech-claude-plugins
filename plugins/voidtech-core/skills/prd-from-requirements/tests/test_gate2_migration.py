"""门 2「迁移缺口」fixture（技术设计 §8.1、§11 门 2；ADR-0004 分阶段第一阶段）。

被测契约——worker 在 `scripts/prdsync/migration.py` 实现：

- `migration.analyze(root) -> dict`：对 legacy 工作树做**只读** dry-run 分析，
  返回至少含三个键的 dict：
  - `autoCandidates`：自动序号映射候选列表（矩阵区间展开 × 原表序号行对齐）；
  - `manualItems`：人工确认项列表，每项含 `itemKey`（矩阵中的 `xxx+a` 标注，
    如 `TST-003+a`）；
  - `gaps`：区间级追溯缺口列表（骨架级区间没有行级映射时如实呈现，
    不伪造行级映射）。
  两次调用结果完全一致（确定性），且不写任何文件。
- `migration.commit_migration(root, confirmations: dict[str, str]) -> dict`：
  按用户确认提交**单一 migration operation**（经 operation_engine，
  operationKind="migration"）。`confirmations` 把 `itemKey` 映射到裁决的
  需求编号。人工项未全部确认时抛 `migration.MigrationBlocked`，此时
  revision 0 不得成为 applied、`capabilities.sourceSync` 不得置位——
  完备性不变式不为迁移豁免，无「部分 applied」。
  全部确认后提交：revision 0 applied、能力开关置位、journal 对 revision 0
  的每条 occurrence 都有生效裁决（basis 为 initial-import /
  migration-backfill / manual-confirmation 之一）。
"""

import json
import unittest
import tempfile
from pathlib import Path

from legacy_fixture import AUTO_COUNT, MANUAL_COUNT, MANUAL_KEY, make_legacy_worktree
from worktree_fixture import snapshot

from prdsync import journal_projector, migration
from prdsync.canonical_store import read_json


class MigrationAnalyzeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = make_legacy_worktree(tmp.name)

    def test_analyze_is_read_only_and_deterministic(self):
        before = snapshot(self.root)
        first = migration.analyze(self.root)
        second = migration.analyze(self.root)
        self.assertEqual(snapshot(self.root), before, "analyze must not write anything")
        self.assertEqual(json.dumps(first, sort_keys=True, default=str),
                         json.dumps(second, sort_keys=True, default=str),
                         "analyze must be deterministic")

    def test_analyze_counts_and_manual_keys(self):
        report = migration.analyze(self.root)
        self.assertEqual(len(report["autoCandidates"]), AUTO_COUNT)
        self.assertEqual(len(report["manualItems"]), MANUAL_COUNT)
        self.assertEqual([item["itemKey"] for item in report["manualItems"]],
                         [MANUAL_KEY])
        # 覆盖计数不等于身份确认：无序号行绝不进入自动候选。
        auto_dump = json.dumps(report["autoCandidates"], ensure_ascii=False, default=str)
        self.assertNotIn(MANUAL_KEY, auto_dump)


class MigrationGatingTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = make_legacy_worktree(tmp.name)

    def _assert_not_applied(self):
        # 能力开关是唯一权威：未置位即迁移未完成。
        manifest_path = self.root / "prd-worktree.json"
        if manifest_path.exists():
            manifest = read_json(manifest_path)
            self.assertFalse(manifest["capabilities"]["sourceSync"],
                             "capability must not be enabled while gaps remain")
        state_path = self.root / "_source/sync-state.json"
        if state_path.exists():
            state = read_json(state_path)
            for source_id, cursors in state["sources"].items():
                self.assertIsNone(cursors.get("appliedRevision"),
                                  f"{source_id}: revision 0 must stay pending")

    def test_unconfirmed_manual_items_block_commit(self):
        with self.assertRaises(migration.MigrationBlocked):
            migration.commit_migration(self.root, confirmations={})
        self._assert_not_applied()

    def test_full_confirmation_commits_single_migration_operation(self):
        # 先经历一次被阻断的提交，再补齐确认——阻断不得留下不可恢复状态。
        with self.assertRaises(migration.MigrationBlocked):
            migration.commit_migration(self.root, confirmations={})
        migration.commit_migration(self.root, confirmations={MANUAL_KEY: "TST-006"})

        manifest = read_json(self.root / "prd-worktree.json")
        self.assertTrue(manifest["capabilities"]["sourceSync"])

        state = read_json(self.root / "_source/sync-state.json")
        applied = [cursors.get("appliedRevision")
                   for cursors in state["sources"].values()
                   if "appliedRevision" in cursors]
        self.assertEqual(len(applied), 1, "exactly one versioned source")
        self.assertIsNotNone(applied[0], "revision 0 must be applied")

        # 单一 migration operation 已提交。
        ops_dir = self.root / "_source/reconciliation/operations"
        manifests = [read_json(p) for p in ops_dir.glob("*.json")]
        committed = [m for m in manifests if m["phase"] == "committed"]
        self.assertEqual(len(committed), 1)
        self.assertEqual(committed[0]["operationKind"], "migration")

        # 完备性：revision 0 的每条 occurrence 都有生效裁决(5 序号 + 1 确认 = 6)。
        projection = journal_projector.project(self.root)
        self.assertEqual(len(projection["mappings"]), AUTO_COUNT + MANUAL_COUNT)
        allowed_basis = {"initial-import", "migration-backfill", "manual-confirmation"}
        for record in projection["mappings"].values():
            self.assertIn(record["basis"], allowed_basis)
        # 人工确认的编号已生效。
        mapped_ids = {r["requirementId"] for r in projection["mappings"].values()}
        self.assertIn("TST-006", mapped_ids)


if __name__ == "__main__":
    unittest.main()
