"""门 2「Example dry-run」fixture（技术设计 §8.1 验收样例、§11 门 2）。

对真实 Example 工作树跑 migration dry-run：稳定得到 559 条自动序号映射候选
与 4 条人工确认项（输入合计 563），缺口清单可复现。

工作树位置：环境变量 `EXAMPLE_PRD_WORKTREE`，缺省
`/Users/dodo/projects/Example-prd-from-requirements/prd`。显式设置了环境
变量但路径不存在时测试失败（防静默跳过）；缺省路径不存在时跳过（其他机器
上的可移植性检查不因此失败）。分析在临时副本上执行，绝不触碰原工作树。
"""

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import legacy_fixture  # noqa: F401  确保 scripts 已加入 sys.path

from prdsync import migration

ENV_VAR = "EXAMPLE_PRD_WORKTREE"
DEFAULT_PATH = "/Users/dodo/projects/Example-prd-from-requirements/prd"
XLSX_SHA256 = "c261ab57e6d6fc8b334d10493bf9758d1bede7f10ff0855c632a12d451d9396d"
MANUAL_KEYS = ["SAAS-015+a", "MBR-276+a", "MBR-288+a", "PTL-210+a"]


def _resolve_example():
    configured = os.environ.get(ENV_VAR)
    if configured:
        if not Path(configured).is_dir():
            raise AssertionError(f"{ENV_VAR} set but not a directory: {configured}")
        return Path(configured)
    default = Path(DEFAULT_PATH)
    return default if default.is_dir() else None


EXAMPLE = _resolve_example()


@unittest.skipIf(EXAMPLE is None, "Example worktree not present on this machine")
class ExampleDryRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._tmp.name) / "example"
        shutil.copytree(EXAMPLE, cls.root)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_input_is_pinned(self):
        xlsx = self.root / "_source/original/需求.xlsx"
        self.assertEqual(hashlib.sha256(xlsx.read_bytes()).hexdigest(), XLSX_SHA256)

    def test_dry_run_yields_559_auto_and_4_manual(self):
        report = migration.analyze(self.root)
        self.assertEqual(len(report["autoCandidates"]), 559)
        self.assertEqual(len(report["manualItems"]), 4)
        self.assertEqual(sorted(item["itemKey"] for item in report["manualItems"]),
                         sorted(MANUAL_KEYS))

    def test_gap_list_is_reproducible(self):
        first = migration.analyze(self.root)
        second = migration.analyze(self.root)
        self.assertEqual(
            json.dumps(first["gaps"], sort_keys=True, ensure_ascii=False, default=str),
            json.dumps(second["gaps"], sort_keys=True, ensure_ascii=False, default=str))


if __name__ == "__main__":
    unittest.main()
