"""门 3「只读同步」fixture（技术设计 §12 第 3 步；ADR-0004 §2/§3/§6 第一阶段）。

被测契约——worker 在 `scripts/prdsync/sync.py` 实现（可重构 migration.py，
迁移的 revision 0 必须与 sync 共用同一 normalizer）：

- `sync.sync_source(root, source_id, input_path, *, fingerprint_columns=None) -> dict`
  只读同步：创建不可变 revision（或 no-op），更新 observed/pending 游标；
  绝不修改 PRD 主本、绝不推进 appliedRevision、绝不改变需求生命周期。
  - 判重以规范化记录哈希为准：规范化内容与 appliedRevision 一致时（即使
    二进制不同，如仅另存）返回 `{"noOp": True, ...}`，不产生新 revision。
  - 否则返回 `{"noOp": False, "revisionId": <新 revision>, "rawDiff": {...}}`，
    其中 rawDiff 至少含 `added`（新出现 recordKey 的记录列表）、`removed`
    （消失 recordKey 的记录列表）、`unchangedCount`（recordKey 未变的记录数）。
  - `fingerprint_columns` 覆盖默认适配器配置；与 appliedRevision 的
    normalization-manifest 的 `effectiveNormalizationDigest` 不一致时抛
    `sync.RebaselineRequired`，拒绝直接 diff（rebaseline 见 test_gate3_rebaseline）。

- revision 目录契约（对 sync 新建的 revision 与 migration 的 revision 0
  同样生效）：`normalized.jsonl` 每行至少含 `sourceOccurrenceId`、`recordKey`、
  `duplicateOrdinal`、`locator`、`normalizedText`，且**不含 `requirementId`**
  ——revision 是不可变观测，裁决只进 journal（ADR-0004 §2/§3）。目录下必须有
  `revision-manifest.json` 与 `normalization-manifest.json` 且通过各自 schema。
  `recordKey` 仅由业务列规范化内容计算：插行、行号偏移不改变未变行的
  recordKey；同一 revision 内容重复的行以 `duplicateOrdinal` 消歧。
"""

import json
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    MANUAL_KEY, ROWS_DUP, ROWS_V2, build_xlsx, make_legacy_worktree,
)
from worktree_fixture import SKILL_ROOT

from prdsync import migration, sync
from prdsync.canonical_store import read_json
from prdsync.schema_validator import check, load_schema

SOURCE_ID = "requirements-xlsx"
SCHEMAS_DIR = SKILL_ROOT / "schemas"


def _migrated_worktree(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    return root, Path(tmp.name)


def _applied_revision(root):
    state = read_json(root / "_source/sync-state.json")
    return state["sources"][SOURCE_ID]["appliedRevision"]


def _revision_dir(root, revision_id):
    return root / "_source/revisions" / SOURCE_ID / revision_id


def _load_normalized(root, revision_id):
    lines = (_revision_dir(root, revision_id) / "normalized.jsonl").read_text(
        encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def _assert_revision_contract(testcase, root, revision_id):
    rev_dir = _revision_dir(root, revision_id)
    records = _load_normalized(root, revision_id)
    for record in records:
        for key in ("sourceOccurrenceId", "recordKey", "duplicateOrdinal",
                    "locator", "normalizedText"):
            testcase.assertIn(key, record, f"normalized record missing {key}")
        testcase.assertNotIn("requirementId", record,
                             "revision 是不可变观测,裁决不得写入 normalized.jsonl")
    rev_manifest = read_json(rev_dir / "revision-manifest.json")
    testcase.assertEqual(check(rev_manifest, load_schema(SCHEMAS_DIR, "revision-manifest")), [])
    norm_manifest = read_json(rev_dir / "normalization-manifest.json")
    testcase.assertEqual(check(norm_manifest, load_schema(SCHEMAS_DIR, "normalization-manifest")), [])
    return records, norm_manifest


class RevisionContractTest(unittest.TestCase):
    def test_migration_revision_0_follows_normalization_contract(self):
        # 门 2 遗留债务：migration 的 revision 0 必须与 sync 共用同一契约。
        root, _ = _migrated_worktree(self)
        records, _ = _assert_revision_contract(self, root, _applied_revision(root))
        self.assertEqual(len(records), 6)


class SyncNoOpTest(unittest.TestCase):
    def test_identical_content_is_noop_even_with_different_binary(self):
        root, tmp = _migrated_worktree(self)
        before_revisions = sorted(
            p.name for p in (root / "_source/revisions" / SOURCE_ID).iterdir())
        # 仅另存不改内容：zip 时间戳不同 → 二进制不同,规范化内容一致。
        resaved = tmp / "resaved.xlsx"
        build_xlsx(resaved, date_time=(2026, 7, 15, 12, 0, 0))
        result = sync.sync_source(root, SOURCE_ID, resaved)
        self.assertTrue(result["noOp"])
        after_revisions = sorted(
            p.name for p in (root / "_source/revisions" / SOURCE_ID).iterdir())
        self.assertEqual(after_revisions, before_revisions,
                         "no-op must not create a revision")


class SyncImportTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = _migrated_worktree(self)
        self.v2 = self.tmp / "v2.xlsx"
        build_xlsx(self.v2, data_rows=ROWS_V2)
        self.masters_before = {
            path: path.read_bytes()
            for path in [self.root / "00-global/requirement-traceability-matrix.md",
                         self.root / "01-test-system/01-module-a/prd.md"]}

    def test_import_creates_immutable_revision_and_raw_diff(self):
        applied_before = _applied_revision(self.root)
        result = sync.sync_source(self.root, SOURCE_ID, self.v2)
        self.assertFalse(result["noOp"])
        revision_id = result["revisionId"]
        self.assertNotEqual(revision_id, applied_before)

        # 只读同步:主本与 appliedRevision 不动,observed/pending 推进。
        for path, content in self.masters_before.items():
            self.assertEqual(path.read_bytes(), content)
        state = read_json(self.root / "_source/sync-state.json")["sources"][SOURCE_ID]
        self.assertEqual(state["appliedRevision"], applied_before)
        self.assertEqual(state["observedRevision"], revision_id)
        self.assertEqual(state["pendingRevision"], revision_id)

        # raw diff:一处正文修改 = 1 removed + 1 added,一条纯新增 = 1 added。
        diff = result["rawDiff"]
        self.assertEqual(len(diff["added"]), 2)
        self.assertEqual(len(diff["removed"]), 1)
        self.assertEqual(diff["unchangedCount"], 5)

        _assert_revision_contract(self, self.root, revision_id)

    def test_record_key_survives_row_shifts(self):
        # V2 在中部插行,后续行物理行号全部偏移;未变行 recordKey 必须不变。
        result = sync.sync_source(self.root, SOURCE_ID, self.v2)
        old_records = _load_normalized(self.root, _applied_revision(self.root))
        new_records = _load_normalized(self.root, result["revisionId"])
        old_keys = {r["normalizedText"]: r["recordKey"] for r in old_records}
        new_keys = {r["normalizedText"]: r["recordKey"] for r in new_records}
        for text in ("客户新增", "客户详情", "站内通知-无序号补充", "订单列表", "订单导出"):
            self.assertEqual(new_keys[text], old_keys[text],
                             f"unchanged row {text!r} must keep its recordKey")

    def test_duplicate_rows_disambiguated_by_ordinal(self):
        dup = self.tmp / "dup.xlsx"
        build_xlsx(dup, data_rows=ROWS_DUP)
        result = sync.sync_source(self.root, SOURCE_ID, dup)
        records = _load_normalized(self.root, result["revisionId"])
        dups = [r for r in records if r["normalizedText"] == "会员导入"]
        self.assertEqual(len(dups), 2)
        self.assertEqual(dups[0]["recordKey"], dups[1]["recordKey"])
        self.assertEqual(sorted(r["duplicateOrdinal"] for r in dups), [0, 1])
        self.assertNotEqual(dups[0]["sourceOccurrenceId"], dups[1]["sourceOccurrenceId"])


if __name__ == "__main__":
    unittest.main()
