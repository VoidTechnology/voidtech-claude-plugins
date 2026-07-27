"""operation manifest 跨字段推导校验的正反例（技术设计 §3.0「校验器重算比对」）。"""

import copy
import sys
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from prdsync.manifest_checks import check_operation_derived_paths  # noqa: E402
from test_schemas import VALID  # noqa: E402


class DerivedPathTest(unittest.TestCase):
    def test_valid_operation_passes(self):
        self.assertEqual(check_operation_derived_paths(VALID["operation"]), [])

    def test_staged_path_of_other_operation_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][0]["stagedPath"] = bad["files"][0]["stagedPath"].replace(
            "op-20260721-001", "op-20260721-999")
        errors = check_operation_derived_paths(bad)
        self.assertTrue(errors, "stagedPath belonging to another operation must be rejected")

    def test_staged_path_mismatching_target_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][0]["stagedPath"] = (
            "_source/reconciliation/operations/op-20260721-001/staging/other.md")
        errors = check_operation_derived_paths(bad)
        self.assertTrue(errors, "stagedPath not derived from files[].path must be rejected")

    def test_backup_path_mismatch_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][2]["backupPath"] = (
            "_source/reconciliation/operations/op-20260721-001/backup/other.md")
        errors = check_operation_derived_paths(bad)
        self.assertTrue(errors, "backupPath not derived from files[].path must be rejected")

    def test_null_fields_skipped(self):
        op = copy.deepcopy(VALID["operation"])
        # 新建条目 backupPath 为 null、删除条目 stagedPath 为 null，均不参与比对。
        self.assertEqual(check_operation_derived_paths(op), [])


if __name__ == "__main__":
    unittest.main()
