"""prd-sync CLI 端到端（技术设计 §9；ADR-0004 §6 固定流程的接线层）。

CLI 是 prdsync 引擎的薄封装，本组测试只验证接线契约，不重测引擎语义：

- 退出码映射：0 成功 / 3 读取栅栏 / 4 需人工裁决（MigrationBlocked、
  DecisionRequired）。
- 单 versioned 源自动推断（sync/propose 不带 --source）。
- --json 输出可被 json.loads（机器 payload 契约）。
- 通过 subprocess 调真实进程：退出码断言必须真实，不 mock。
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import MANUAL_KEY, ROWS_V2, build_xlsx, make_legacy_worktree
from worktree_fixture import SKILL_ROOT

from prdsync import operation_engine as engine
from prdsync.canonical_store import read_json

CLI = SKILL_ROOT / "scripts" / "prd-sync.py"
SOURCE_ID = "requirements-xlsx"


def run_cli(*args):
    return subprocess.run(
        [sys.executable, str(CLI), *[str(a) for a in args]],
        capture_output=True, text=True)


def run_json(*args, expect=0):
    proc = run_cli(*args, "--json")
    assert proc.returncode == expect, (
        f"exit {proc.returncode} != {expect}\nstdout: {proc.stdout}\n"
        f"stderr: {proc.stderr}")
    return json.loads(proc.stdout)


class CliCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.root = make_legacy_worktree(self.tmp)

    def migrate(self):
        proc = run_cli("migrate", self.root, "--confirm", f"{MANUAL_KEY}=TST-006")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def sync_v2(self):
        v2 = self.tmp / "v2.xlsx"
        build_xlsx(v2, data_rows=ROWS_V2)
        return run_json("sync", self.root, "--input", v2)


class MigrateTest(CliCase):
    def test_dry_run_lists_manual_items(self):
        proc = run_cli("migrate", self.root, "--dry-run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(MANUAL_KEY, proc.stdout)
        self.assertIn("人工确认项：1 条", proc.stdout)
        self.assertIn("自动候选：5 条", proc.stdout)
        # --json 机器 payload 契约。
        payload = run_json("migrate", self.root, "--dry-run")
        self.assertTrue(payload["dryRun"])
        self.assertEqual([i["itemKey"] for i in payload["manualItems"]],
                         [MANUAL_KEY])
        self.assertEqual(len(payload["autoCandidates"]), 5)

    def test_migrate_without_confirmations_degrades_to_dry_run(self):
        proc = run_cli("migrate", self.root)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("按 dry-run 处理", proc.stdout)
        # 未提交：工作树仍无机器清单。
        self.assertFalse((self.root / "prd-worktree.json").exists())

    def test_partial_confirmations_exit_4(self):
        proc = run_cli("migrate", self.root, "--confirm", "BOGUS+a=TST-999")
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertIn(MANUAL_KEY, proc.stderr)

    def test_commit_enables_source_sync_in_status(self):
        self.migrate()
        payload = run_json("status", self.root)
        self.assertTrue(payload["capabilities"]["sourceSync"])
        source = next(s for s in payload["sources"]
                      if s["sourceId"] == SOURCE_ID)
        self.assertIsNotNone(source["appliedRevision"])
        self.assertIsNone(source["pendingRevision"])
        self.assertEqual(payload["readFence"], [])


class SyncNoOpTest(CliCase):
    def test_reimporting_applied_content_reports_noop(self):
        self.migrate()
        # 同一内容另存（zip 时间戳不同 → 二进制不同，规范化内容一致）。
        resaved = self.tmp / "resaved.xlsx"
        build_xlsx(resaved, date_time=(2026, 7, 15, 12, 0, 0))
        payload = run_json("sync", self.root, "--input", resaved)
        self.assertTrue(payload["noOp"])
        proc = run_cli("sync", self.root, "--input", resaved)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("no-op", proc.stdout)


class ProposeConfirmFlowTest(CliCase):
    def setUp(self):
        super().setUp()
        self.migrate()
        result = self.sync_v2()
        self.assertFalse(result["noOp"])
        self.revision = result["revisionId"]

    def _decisions(self, proposal):
        ambiguous_occ = proposal["ambiguities"][0]["occurrences"][0]
        new_occ = next(m["sourceOccurrenceId"] for m in proposal["mappings"]
                       if m["classification"] == "new")
        return ambiguous_occ, new_occ

    def test_full_chain_and_decision_required_exit_4(self):
        proposal = run_json("propose", self.root)
        self.assertEqual(proposal["candidateRevision"], self.revision)
        self.assertTrue(proposal["ambiguities"])

        # 存在未裁决项：退出码 4，且 stderr 列出待裁决 occurrence。
        proc = run_cli("confirm", self.root, proposal["proposalId"])
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        ambiguous_occ, new_occ = self._decisions(proposal)
        self.assertIn(ambiguous_occ, proc.stderr)

        manifest = run_json(
            "confirm", self.root, proposal["proposalId"],
            "--decision", f"{ambiguous_occ}=TST-002",
            "--decision", f"{new_occ}=new")
        self.assertEqual(manifest["phase"], "committed")

        status = run_json("status", self.root)
        source = next(s for s in status["sources"]
                      if s["sourceId"] == SOURCE_ID)
        self.assertEqual(source["appliedRevision"], self.revision)
        self.assertIsNone(source["pendingRevision"])


class ReadFenceTest(CliCase):
    def _committed_operation(self):
        self.sync_v2()
        proposal = run_json("propose", self.root)
        ambiguous_occ = proposal["ambiguities"][0]["occurrences"][0]
        new_occ = next(m["sourceOccurrenceId"] for m in proposal["mappings"]
                       if m["classification"] == "new")
        manifest = run_json(
            "confirm", self.root, proposal["proposalId"],
            "--decision", f"{ambiguous_occ}=TST-002",
            "--decision", f"{new_occ}=new")
        return manifest["operationId"]

    def test_fence_exit_3_and_recover_restores(self):
        self.migrate()
        operation_id = self._committed_operation()

        # 人为把已提交 operation 的 manifest 拨回 publishing → 读取栅栏生效。
        manifest = engine.load_manifest(self.root, operation_id)
        manifest["phase"] = "publishing"
        engine._save_manifest(self.root, manifest)

        proc = run_cli("propose", self.root)
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn("recover", proc.stderr)

        # status 只报告不崩溃。
        status = run_json("status", self.root)
        self.assertEqual(status["readFence"], [operation_id])

        # recover：提交点已过 → 确定性补写 committed，恢复正常。
        recovered = run_json("recover", self.root)
        self.assertEqual(recovered["actions"][operation_id], "finalized")
        status = run_json("status", self.root)
        self.assertEqual(status["readFence"], [])
        proc = run_cli("propose", self.root)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class LifecycleTest(CliCase):
    def test_lifecycle_proposal_then_confirm_updates_ledger(self):
        self.migrate()
        proposal = run_json("lifecycle", self.root, "TST-005", "withdraw")
        self.assertEqual(proposal["proposalId"], "prop-lc-tst-005-withdraw")
        self.assertEqual(proposal["lifecycleActions"][0]["lifecycleAction"],
                         "withdraw")

        manifest = run_json("confirm", self.root, proposal["proposalId"])
        self.assertEqual(manifest["phase"], "committed")

        ledger_lines = (self.root / "_generated/requirements-ledger.jsonl") \
            .read_text(encoding="utf-8").splitlines()
        states = {rec["requirementId"]: rec["state"]
                  for rec in map(json.loads, ledger_lines)}
        self.assertEqual(states["TST-005"], "withdrawn")


class AtlasEnableTest(CliCase):
    def test_enable_before_migration_exits_1(self):
        proc = run_cli("atlas", self.root, "--enable", "markdown")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("先执行 migrate", proc.stderr)

    def test_enable_flips_capability_and_gate_steps(self):
        self.migrate()
        proc = run_cli("atlas", self.root, "--enable", "markdown")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        manifest = json.loads((Path(self.root) / "prd-worktree.json").read_text(
            encoding="utf-8"))
        self.assertTrue(manifest["capabilities"]["logicAtlas"])
        self.assertEqual(manifest["logicAtlasStage"], "markdown")
        self.assertEqual(manifest["schemaVersions"]["logicModel"], 1)
        gate = run_json("atlas", self.root, "--gate")
        self.assertEqual(gate["stage"], "markdown")
        self.assertTrue(gate["steps"])


class UsageTest(unittest.TestCase):
    def test_unknown_command_exits_2(self):
        proc = run_cli("frobnicate", "/tmp")
        self.assertEqual(proc.returncode, 2)

    def test_missing_worktree_exits_1(self):
        proc = run_cli("status", "/nonexistent/prd-worktree-xyz")
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
