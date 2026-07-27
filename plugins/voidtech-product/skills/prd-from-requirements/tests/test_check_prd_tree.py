"""check-prd-tree.py 改造后的行为契约（技术设计 §9、§10;ADR-0004）。

- legacy 工作树（无 prd-worktree.json）通过检查,行为与改造前一致。
- 读取栅栏（publishing）: 退出码 3、报告 operation id、零写入（mtime +
  内容快照对比）。
- 默认模式排除 `_source/reconciliation/`: staging 镜像不重复计入。
- `--operation-id` 模式经 overlay resolver 看到 staging 版本,且同一逻辑
  文件只出现一次。
- Logic Atlas 能力开启后带外改主本 → 检查失败并报 stale（§10）。
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    MANUAL_KEY, MODULE_A_PRD_RELPATH, enable_logic_atlas,
    make_legacy_worktree, write_atlas_module,
)
from worktree_fixture import SKILL_ROOT

from prdsync import atlas, migration
from prdsync.writer_lock import OPERATIONS_RELPATH

CHECKER = SKILL_ROOT / "scripts" / "check-prd-tree.py"


def run_checker(root, *extra):
    return subprocess.run(
        [sys.executable, str(CHECKER), str(root), *extra],
        capture_output=True, text=True)


def clean_legacy_worktree(testcase) -> Path:
    """legacy fixture 树本身缺模块主本「深度」声明,补齐得到最小干净树。"""
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    for module, title in (("01-module-a", "模块甲"), ("02-module-b", "模块乙")):
        (root / f"01-test-system/{module}/prd.md").write_text(
            f"# {title}\n\n- 深度:骨架级\n\n骨架级模块主本。\n", encoding="utf-8")
    return root


def full_snapshot(root):
    """全树 {相对路径: (mtime_ns, 内容字节)} 快照,用于零写入断言。"""
    result = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_file():
            stat = path.stat()
            result[path.relative_to(root).as_posix()] = (stat.st_mtime_ns, path.read_bytes())
    return result


def write_operation_manifest(root, op_id, phase, files=()):
    ops_dir = Path(root) / OPERATIONS_RELPATH
    ops_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"operationId": op_id, "phase": phase, "files": list(files)}
    (ops_dir / f"{op_id}.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def stage_module_a_with_todo(root, op_id="op-stage-1"):
    """暂存一份引入 TODO 错误的模块甲主本,返回 staging 相对路径。"""
    staged_rel = f"{OPERATIONS_RELPATH}/{op_id}/staging/{MODULE_A_PRD_RELPATH}"
    staged = Path(root) / staged_rel
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(
        "# 模块甲\n\n- 深度:骨架级\n\n骨架级模块主本。\n\nTODO 待补详情\n",
        encoding="utf-8")
    write_operation_manifest(root, op_id, "staged", files=[
        {"action": "write", "path": MODULE_A_PRD_RELPATH, "stagedPath": staged_rel},
    ])
    return staged_rel


class LegacyWorktreeTest(unittest.TestCase):
    def test_clean_legacy_worktree_passes(self):
        root = clean_legacy_worktree(self)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("检查完成: 3 个文件, 0 个错误, 0 个警告", proc.stdout)


class AcceptanceStructureTest(unittest.TestCase):
    def test_acceptance_module_requires_auditable_logic_tables(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            "# 模块甲\n\n- 深度:验收级\n\n只有叙述，没有审计结构。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("验收级模块缺少审计结构", proc.stdout)
        self.assertIn("页面数据读写（机器可解析）", proc.stdout)


    def test_navigation_label_is_not_a_business_state(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            """# 模块甲

- 深度:骨架级

```mermaid
stateDiagram-v2
    正常 --> 已注销
```

进入「转为会员」/会员列表。
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("疑似幽灵状态「转为会员」", proc.stdout)


    def test_acceptance_module_rejects_empty_audit_tables(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        sections = "\n\n".join(
            f"## {marker}\n\n| 占位列 |\n|---|"
            for marker in (
                "页面契约（机器可解析）",
                "核心流程（机器可解析）",
                "流程状态影响（机器可解析）",
                "页面交互（机器可解析）",
                "状态机与状态流转",
                "页面数据读写（机器可解析）"))
        module.write_text(
            f"# 模块甲\n\n- 深度:验收级\n\n{sections}\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("审计结构没有数据行", proc.stdout)


class ReadFenceTest(unittest.TestCase):
    def test_publishing_operation_exits_3_and_writes_nothing(self):
        root = clean_legacy_worktree(self)
        write_operation_manifest(root, "op-fence-1", "publishing")
        before = full_snapshot(root)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn("op-fence-1", proc.stderr)
        self.assertIn("prd-sync recover", proc.stderr)
        self.assertEqual(full_snapshot(root), before, "读取栅栏路径必须零写入")


class OverlayViewTest(unittest.TestCase):
    def test_default_mode_excludes_staging_mirror(self):
        root = clean_legacy_worktree(self)
        stage_module_a_with_todo(root)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("TODO", proc.stdout, "staging 镜像不得计入默认扫描")
        self.assertIn("检查完成: 3 个文件", proc.stdout, "staging 副本不得重复计入文件数")

    def test_operation_id_mode_sees_staged_version_exactly_once(self):
        root = clean_legacy_worktree(self)
        staged_rel = stage_module_a_with_todo(root, op_id="op-stage-2")
        proc = run_checker(root, "--operation-id", "op-stage-2")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertEqual(
            proc.stdout.count("残留 TODO"), 1,
            "同一逻辑文件只能出现一次: " + proc.stdout)
        self.assertIn(f"{MODULE_A_PRD_RELPATH}:7: 残留 TODO", proc.stdout,
                      "错误必须落在逻辑相对路径上")
        self.assertNotIn(staged_rel, proc.stdout, "不得暴露 staging 物理路径")
        self.assertIn("检查完成: 3 个文件", proc.stdout)

    def test_operation_id_mode_missing_manifest_is_usage_error(self):
        root = clean_legacy_worktree(self)
        proc = run_checker(root, "--operation-id", "op-ghost")
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)


class AtlasFreshnessTest(unittest.TestCase):
    def test_out_of_band_master_edit_reports_stale(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        write_atlas_module(root)
        enable_logic_atlas(root)
        atlas.publish(root)

        fresh_proc = run_checker(root)
        self.assertNotIn("stale", fresh_proc.stdout,
                         "发布后未带外修改不得报 stale")

        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            module.read_text(encoding="utf-8") + "\n带外补充说明\n",
            encoding="utf-8")
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("stale", proc.stdout)
        self.assertIn("authoritativeSourceDigest", proc.stdout)


if __name__ == "__main__":
    unittest.main()
