"""门 3「rebaseline」fixture（技术设计 §8.2、§11 门 3）。

被测契约——worker 在 `scripts/prdsync/sync.py` 实现：

- `sync.rebaseline(root, source_id, *, fingerprint_columns) -> dict`（返回至少
  含 `revisionId`）：检测到 `effectiveNormalizationDigest` 变化后的基线重建。
  从旧 appliedRevision 的**同一原始文件**生成新的不可变 baseline revision
  （revision 永不覆盖，旧目录逐字节不动），写入新 normalization-manifest；
  生成新旧 recordKey crosswalk 并为全部新 occurrence 写映射 segment
  （`basis: normalization-rebaseline`），身份继承：requirementId 集合不变；
  提交后该源 `appliedRevision` 推进到新 baseline。
- 触发规则：`sync.sync_source` 携带与 appliedRevision 的 manifest 不一致的
  `fingerprint_columns` 时抛 `sync.RebaselineRequired`，拒绝直接 diff。
- 验收（§8.2 第 6 条）：内容未变的源在 rebaseline 后重新同步，零业务变更集
  （no-op）——仅因规范化规则变化产生的差异归类为基线重建，不得呈现为业务变更。
"""

import tempfile
import unittest
from pathlib import Path

from legacy_fixture import MANUAL_KEY, build_xlsx, make_legacy_worktree

from prdsync import journal_projector, migration, sync
from prdsync.canonical_store import read_json

SOURCE_ID = "requirements-xlsx"
# 与默认配置不同的 fingerprint 列集合（各行正文互不相同,crosswalk 可 1:1 自动对齐）。
NEW_COLUMNS = ["requirement-text"]


class RebaselineTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = make_legacy_worktree(tmp.name)
        migration.commit_migration(self.root, confirmations={MANUAL_KEY: "TST-006"})
        self.tmp = Path(tmp.name)
        state = read_json(self.root / "_source/sync-state.json")
        self.rev0 = state["sources"][SOURCE_ID]["appliedRevision"]
        self.rev0_dir = self.root / "_source/revisions" / SOURCE_ID / self.rev0

    def _requirement_ids(self):
        projection = journal_projector.project(self.root)
        return {record["requirementId"] for record in projection["mappings"].values()}

    def test_contract_change_refuses_direct_diff(self):
        same = self.tmp / "same.xlsx"
        build_xlsx(same)
        with self.assertRaises(sync.RebaselineRequired):
            sync.sync_source(self.root, SOURCE_ID, same, fingerprint_columns=NEW_COLUMNS)

    def test_rebaseline_preserves_identity_and_immutability(self):
        ids_before = self._requirement_ids()
        rev0_snapshot = {p.name: p.read_bytes() for p in self.rev0_dir.iterdir()}

        result = sync.rebaseline(self.root, SOURCE_ID, fingerprint_columns=NEW_COLUMNS)
        new_rev = result["revisionId"]
        self.assertNotEqual(new_rev, self.rev0)

        # 旧 revision 逐字节不动(revision 永不覆盖)。
        self.assertEqual({p.name: p.read_bytes() for p in self.rev0_dir.iterdir()},
                         rev0_snapshot)

        # appliedRevision 推进到新 baseline。
        state = read_json(self.root / "_source/sync-state.json")["sources"][SOURCE_ID]
        self.assertEqual(state["appliedRevision"], new_rev)

        # 新 manifest 的契约摘要确实变化。
        old_manifest = read_json(self.rev0_dir / "normalization-manifest.json")
        new_manifest = read_json(self.root / "_source/revisions" / SOURCE_ID / new_rev
                                 / "normalization-manifest.json")
        self.assertNotEqual(new_manifest["effectiveNormalizationDigest"],
                            old_manifest["effectiveNormalizationDigest"])

        # 身份继承:每条新 occurrence 有生效裁决,基于 normalization-rebaseline;
        # requirementId 集合不变(后来的规则变化不改变需求身份)。
        projection = journal_projector.project(self.root)
        new_occurrences = {occ for occ in projection["mappings"]
                           if f"@{new_rev}/" in occ}
        self.assertEqual(len(new_occurrences), 6)
        for occ in new_occurrences:
            self.assertEqual(projection["mappings"][occ]["basis"],
                             "normalization-rebaseline")
        self.assertEqual(self._requirement_ids(), ids_before)

    def test_unchanged_content_resyncs_as_noop_after_rebaseline(self):
        sync.rebaseline(self.root, SOURCE_ID, fingerprint_columns=NEW_COLUMNS)
        same = self.tmp / "same.xlsx"
        build_xlsx(same, date_time=(2026, 7, 20, 8, 0, 0))
        result = sync.sync_source(self.root, SOURCE_ID, same,
                                  fingerprint_columns=NEW_COLUMNS)
        self.assertTrue(result["noOp"], "零业务变更集:规则变化不得呈现为业务变更")


if __name__ == "__main__":
    unittest.main()
