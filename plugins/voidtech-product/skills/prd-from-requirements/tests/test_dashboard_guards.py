"""generate-dashboard.py 的两条防线。

- 目标必须是工作树根目录: 在模块目录或缺 00-global/ 的目录下运行会凭空
  造出一份没人维护的「幽灵看板」(实测发生过一次),必须拒绝且零写入。
- 变更记录不是数据源: 追溯矩阵、开放问题、深化清单的解析读到变更记录
  小节为止,否则叙述性文本里顺带出现的编号与模块名会被当成真映射。
"""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from worktree_fixture import SKILL_ROOT

DASHBOARD = SKILL_ROOT / "scripts" / "generate-dashboard.py"


def load_dashboard():
    spec = importlib.util.spec_from_file_location("dashboard_under_test", DASHBOARD)
    assert spec is not None and spec.loader is not None, DASHBOARD
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_dashboard(target):
    return subprocess.run(
        [sys.executable, str(DASHBOARD), str(target)],
        capture_output=True, text=True)


def snapshot(root):
    return sorted(p.relative_to(root).as_posix()
                  for p in Path(root).rglob("*") if p.is_file())


class WorktreeRootGuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_module_directory_is_rejected(self):
        module = self.root / "02-account-auth"
        module.mkdir()
        (module / "prd.md").write_text("# 模块\n\n- 深度:骨架级\n", encoding="utf-8")
        before = snapshot(self.root)

        proc = run_dashboard(module)

        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("是模块目录", proc.stdout)
        self.assertEqual(snapshot(self.root), before, "拒绝路径必须零写入")

    def test_directory_without_global_is_rejected(self):
        stray = self.root / "somewhere"
        stray.mkdir()
        before = snapshot(self.root)

        proc = run_dashboard(stray)

        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("没有 00-global/", proc.stdout)
        self.assertEqual(snapshot(self.root), before,
                         "不得为了写看板而创建 00-global/")


class ChangelogIsNotDataTest(unittest.TestCase):
    """变更记录里顺带出现的编号与模块名不得成为映射。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "00-global").mkdir(parents=True)
        self.dashboard = load_dashboard()

    def test_matrix_ranges_ignore_changelog_rows(self):
        (self.root / "00-global" / "requirement-traceability-matrix.md").write_text(
            """# 追溯矩阵

- 深度:骨架级

| 需求区间 | 归属模块 |
|---|---|
| ARC-001~ARC-010 | `01-site-rendering` |

## 变更记录

| 日期 | 版本 | 主题 | commit |
|---|---|---|---|
| 2026-07-29 | 0.2 | `OQ-031` 定案后回扫 `13-system-settings` | `a1b2c3d` |
""",
            encoding="utf-8")

        ranges = self.dashboard.parse_matrix_ranges(self.root)

        self.assertEqual(ranges, [("ARC", 1, 10, "01-site-rendering")])
        self.assertNotIn(
            "OQ", [prefix for prefix, *_ in ranges],
            "变更记录里的 OQ 编号不是需求区间映射")

    def test_oq_catalog_ignores_changelog_rows(self):
        (self.root / "00-global" / "global-open-questions.md").write_text(
            """# 开放问题

| 编号 | 问题 |
|---|---|
| OQ-001 | 会员号编号规则 |

## 变更记录

| 日期 | 版本 | 主题 | commit |
|---|---|---|---|
| 2026-07-29 | 0.2 | 收窄 OQ-002 的陈述 | `a1b2c3d` |
""",
            encoding="utf-8")

        catalog = self.dashboard.parse_oq_catalog(self.root)

        self.assertEqual(sorted(catalog), ["OQ-001"])


if __name__ == "__main__":
    unittest.main()
