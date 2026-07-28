"""Vendored Archify Lifecycle 渲染桥的降级与确定性修复契约。"""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worktree_fixture import SKILL_ROOT  # noqa: F401

from prdsync import core_archify
from prdsync.core_archify import archify_bridge


IR = {
    "schema_version": 1,
    "diagram_type": "lifecycle",
    "meta": {"title": "订单", "quality_profile": "standard"},
    "lanes": [{"id": "main", "label": "主线"}, {"id": "terminal", "label": "终态"}],
    "states": [
        {"id": "state-a", "type": "start", "label": "待处理", "lane": "main", "col": 0},
        {"id": "state-b", "type": "success", "label": "处理成功", "lane": "terminal", "col": 0},
    ],
    "transitions": [
        {"id": "transition-a", "from": "state-a", "to": "state-b", "label": "确认 → 成功"}
    ],
}


class ArchifyBridgeTest(unittest.TestCase):
    def test_discovers_core_runtime_from_omp_marketplace_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            install_root = home / ".omp/plugins/cache/plugins/voidtech-core"
            registry = home / ".omp/plugins/installed_plugins.json"
            registry.parent.mkdir(parents=True)
            registry.write_text(json.dumps({
                "version": 2,
                "plugins": {
                    "voidtech-core@voidtech": [{
                        "scope": "user",
                        "installPath": str(install_root),
                        "lastUpdated": "2026-07-27T10:00:00Z",
                    }],
                },
            }), encoding="utf-8")

            with mock.patch.dict(
                "os.environ",
                {"HOME": str(home), "CLAUDE_CONFIG_DIR": str(home / "missing-claude")},
            ):
                candidates = list(core_archify._candidate_core_roots())

            self.assertIn(install_root, candidates)

    def test_extracts_exactly_one_svg(self):
        html = "<html><body><svg viewBox=\"0 0 10 10\"><text>状态</text></svg></body></html>"
        self.assertEqual(
            archify_bridge.extract_single_svg(html),
            "<svg viewBox=\"0 0 10 10\"><text>状态</text></svg>",
        )
        with self.assertRaises(ValueError):
            archify_bridge.extract_single_svg("<html></html>")
        with self.assertRaises(ValueError):
            archify_bridge.extract_single_svg("<svg></svg><svg></svg>")

    def test_clean_flow_repairs_follow_frozen_route_sequence(self):
        ir = copy.deepcopy(IR)
        diagnostic = {
            "code": "clean-flow/edge-through-node",
            "subject": {"collection": "transitions", "id": "transition-a", "index": 0},
            "message": "edge crosses unrelated state",
        }

        routes = []
        for _ in range(6):
            self.assertTrue(archify_bridge.apply_diagnostic_repair(ir, diagnostic))
            routes.append((
                ir["transitions"][0].get("route"),
                ir["transitions"][0].get("channelY"),
                ir["transitions"][0].get("channelX"),
            ))

        self.assertEqual(routes, [
            ("straight", None, None),
            ("drop", None, None),
            ("bottom-channel", None, None),
            ("bottom-channel", 410, None),
            ("bottom-channel", 392, None),
            ("right-channel", None, None),
        ])

    def test_layout_constraint_uses_only_bounded_suggested_fix(self):
        ir = copy.deepcopy(IR)
        diagnostic = {
            "code": "layout/constraint",
            "subject": {"diagramType": "lifecycle"},
            "message": (
                'Label "确认 → 成功" overlaps state "state-b" — adjust label.\n'
                '  Suggested fix: labelAt [420, 360] or labelDy +42 (below)'),
        }
        self.assertTrue(archify_bridge.apply_diagnostic_repair(ir, diagnostic))
        self.assertEqual(ir["transitions"][0]["labelAt"], [420, 360])

        unknown = copy.deepcopy(IR)
        self.assertFalse(archify_bridge.apply_diagnostic_repair(unknown, {
            "code": "layout/constraint",
            "subject": {"diagramType": "lifecycle"},
            "message": "unrecognized free text",
        }))
        self.assertEqual(unknown, IR)

    def test_short_cycle_routes_to_same_side_and_label_pair_moves_label_at(self):
        ir = copy.deepcopy(IR)
        reverse = copy.deepcopy(ir["transitions"][0])
        reverse.update({
            "id": "transition-b", "from": "state-b", "to": "state-a",
            "label": "撤销 → 待处理"})
        ir["transitions"].append(reverse)

        self.assertTrue(archify_bridge.apply_diagnostic_repair(ir, {
            "code": "layout/constraint",
            "message": (
                'Transition "确认 → 成功" is too short (10px; minimum 32px) '
                "— route it through a channel or drop its label."),
        }))
        first = ir["transitions"][0]
        self.assertEqual(first["fromSide"], first["toSide"])
        reverse["labelAt"] = [140, 120]
        self.assertIn(first["route"], ("left-channel", "right-channel"))

        first["labelAt"] = [100, 120]
        self.assertTrue(archify_bridge.apply_diagnostic_repair(ir, {
            "code": "layout/constraint",
            "message": (
                'Labels "确认 → 成功" and "撤销 → 待处理" overlap — adjust labelDx/labelDy.\n'
                "  Suggested fix: add labelDy +24 on one edge, adjust labelDx, or remove one label"),
        }))
        self.assertEqual(first["labelAt"], [100, 144])

    def test_render_retries_when_one_of_duplicate_diagnostics_is_repairable(self):
        ir = copy.deepcopy(IR)
        ir["transitions"][0].update({"route": "right-channel"})
        machine = {
            "machineId": "machine-order",
            "scopeId": "01-system/01-orders",
            "object": "订单",
            "states": [],
            "transitions": [],
        }
        diagnostic = {
            "code": "clean-flow/edge-through-node",
            "subject": {
                "collection": "transitions",
                "id": "transition-a",
                "index": 0,
            },
            "message": "edge crosses unrelated state",
        }
        calls = []

        def runner(args, **kwargs):
            calls.append(list(args))
            if len(calls) == 1:
                receipt = {
                    "ok": False,
                    "diagnostics": [diagnostic, diagnostic],
                }
                return SimpleNamespace(
                    returncode=1, stdout=json.dumps(receipt), stderr="")
            Path(args[5]).write_text(
                "<html><svg viewBox=\"0 0 10 10\"></svg></html>",
                encoding="utf-8")
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "diagnostics": []}),
                stderr="")

        result = archify_bridge.render_machine(
            machine, ir, runner=runner,
            runtime={"status": "ok", "major": 20})

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["ir"]["transitions"][0]["route"],
                         "left-channel")

    def test_missing_node_degrades_without_raising(self):
        def missing_runner(*args, **kwargs):
            raise FileNotFoundError("node")

        presentation = archify_bridge.build_presentation(
            {"nodes": [], "edges": []}, runner=missing_runner)

        self.assertTrue(presentation["presentationRisk"])
        self.assertEqual(presentation["runtime"]["status"], "unavailable")
        self.assertEqual(presentation["machines"], [])

    def test_successful_delivery_inlines_svg_and_is_repeatable(self):
        calls = []

        def runner(args, **kwargs):
            calls.append(list(args))
            if args[-1] == "--version" or args[1:] == ["--version"]:
                return SimpleNamespace(returncode=0, stdout="v20.12.0\n", stderr="")
            output = Path(args[5])
            output.write_text(
                '<html><body><svg viewBox="0 0 640 240" data-proof="fixed">'
                '<text>订单</text></svg></body></html>',
                encoding="utf-8")
            receipt = {"schemaVersion": 1, "ok": True, "artifact": {"sha256": "abc", "bytes": 80}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(receipt), stderr="")

        machine = {
            "machineId": "machine-a", "scopeId": "02-backend/01-order", "object": "订单",
            "states": [], "transitions": [],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            first = archify_bridge.render_machine(
                machine, copy.deepcopy(IR), runner=runner, temp_root=Path(temp_dir))
            second = archify_bridge.render_machine(
                machine, copy.deepcopy(IR), runner=runner, temp_root=Path(temp_dir))

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "ok")
        self.assertIn('data-proof="fixed"', first["svg"])
        self.assertEqual(first["attempts"], 1)
        self.assertGreaterEqual(len(calls), 2)

    def test_svg_text_overflow_audit_is_cjk_aware(self):
        clean = ('<svg viewBox="0 0 640 240">'
                 '<text x="320" font-size="12" text-anchor="middle">生效中</text>'
                 '<text data-detail="context" x="320" font-size="7" '
                 'text-anchor="middle">缴费生效</text></svg>')
        self.assertEqual(archify_bridge.svg_text_overflows(clean), [])
        # 中文标题按 CJK 宽度越出 viewBox 右缘（vendor 拉丁口径测不出）。
        clipped = ('<svg viewBox="0 0 200 240">'
                   '<text x="190" font-size="12" text-anchor="middle">'
                   '已建套餐记录但付款凭证未确认到账</text></svg>')
        self.assertEqual(len(archify_bridge.svg_text_overflows(clipped)), 1)
        # 超宽子标签压相邻状态盒。
        wide_sub = ('<svg viewBox="0 0 640 240">'
                    '<text data-detail="context" x="320" font-size="7" '
                    'text-anchor="middle">'
                    '已建套餐记录但付款凭证未确认到账,机构后台权益未开通</text></svg>')
        self.assertEqual(len(archify_bridge.svg_text_overflows(wide_sub)), 1)
        # 缺 viewBox 一律不可信。
        self.assertEqual(
            len(archify_bridge.svg_text_overflows("<svg><text x=\"1\">x</text></svg>")), 1)

    def test_text_overflow_degrades_machine(self):
        def runner(args, **kwargs):
            if args[-1] == "--version" or args[1:] == ["--version"]:
                return SimpleNamespace(returncode=0, stdout="v20.12.0\n", stderr="")
            Path(args[5]).write_text(
                '<html><body><svg viewBox="0 0 100 240">'
                '<text x="90" font-size="12" text-anchor="middle">'
                '已建套餐记录但付款凭证未确认到账</text></svg></body></html>',
                encoding="utf-8")
            receipt = {"schemaVersion": 1, "ok": True}
            return SimpleNamespace(returncode=0, stdout=json.dumps(receipt), stderr="")

        machine = {
            "machineId": "machine-b", "scopeId": "02-backend/01-order", "object": "订单",
            "states": [], "transitions": [],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            result = archify_bridge.render_machine(
                machine, copy.deepcopy(IR), runner=runner, temp_root=Path(temp_dir))
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["diagnostics"][0]["code"], "artifact/text-overflow")
        self.assertNotIn("svg", result)


TRUNCATED_RECEIPT = {
    "ok": False,
    "stage": "receipt",
    "diagnostics": [{
        "code": "delivery/receipt-invalid",
        "message": ("Could not parse the successful artifact-check receipt: "
                    "Unterminated string in JSON at position 64761"),
    }],
}


class OversizedReceiptRecoveryTest(unittest.TestCase):
    """deliver 内层管道截断大回执时，从调用侧用文件回执重做交付并恢复。

    vendored check-render-output.mjs 在 console.log 大 JSON 后立即
    process.exit()，管道上未排空的写会丢；一张渲染正常的图会被误判为交付失败。
    """

    def _runner(self, checker_ok, *, render_fails=False, calls=None):
        def runner(args, **kwargs):
            if calls is not None:
                calls.append(list(args))
            command = args[2] if len(args) > 2 else ""
            if command == "deliver":
                return SimpleNamespace(
                    returncode=1, stdout=json.dumps(TRUNCATED_RECEIPT),
                    stderr="")
            if command == "render":
                if render_fails:
                    return SimpleNamespace(
                        returncode=1, stdout="", stderr="render boom")
                Path(args[5]).write_text(
                    '<html><body><svg viewBox="0 0 640 240">'
                    '<text>订单</text></svg></body></html>',
                    encoding="utf-8")
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if command == "check":
                # 复刻真实行为：check 把回执写到重定向的文件，而非返回 stdout。
                kwargs["stdout"].write(json.dumps({
                    "ok": checker_ok,
                    "checks": [{"name": "single_svg", "ok": True},
                               {"name": "route_rhythm", "ok": checker_ok}],
                    "composition": {
                        "status": "pass" if checker_ok else "fail",
                        "issues": []},
                }))
                return SimpleNamespace(
                    returncode=0 if checker_ok else 1, stdout=None, stderr="")
            raise AssertionError(f"unexpected archify command: {command}")
        return runner

    def _machine(self):
        return {"machineId": "machine-t", "scopeId": "02-backend/01-order",
                "object": "订单", "states": [], "transitions": []}

    def test_truncated_receipt_recovers_when_file_receipt_passes(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp_dir:
            result = archify_bridge.render_machine(
                self._machine(), copy.deepcopy(IR),
                runner=self._runner(True, calls=calls),
                runtime={"status": "ok", "major": 20},
                temp_root=Path(temp_dir))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["diagnostics"], [])
        self.assertIn("<svg", result["svg"])
        # 必须自己重新 render：deliver 在回执阶段失败时不会提升候选产物。
        self.assertIn("render", [call[2] for call in calls])
        self.assertIn("check", [call[2] for call in calls])

    def test_truncated_receipt_degrades_when_file_receipt_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = archify_bridge.render_machine(
                self._machine(), copy.deepcopy(IR),
                runner=self._runner(False),
                runtime={"status": "ok", "major": 20},
                temp_root=Path(temp_dir))
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["diagnostics"][0]["code"], "artifact/check-failed")
        self.assertIn("route_rhythm", result["diagnostics"][0]["message"])

    def test_recovery_render_failure_keeps_original_degradation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = archify_bridge.render_machine(
                self._machine(), copy.deepcopy(IR),
                runner=self._runner(True, render_fails=True),
                runtime={"status": "ok", "major": 20},
                temp_root=Path(temp_dir))
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["diagnostics"][0]["code"],
                         "delivery/receipt-invalid")

    def test_normal_delivery_never_triggers_recovery(self):
        calls = []

        def runner(args, **kwargs):
            calls.append(list(args))
            Path(args[5]).write_text(
                '<html><body><svg viewBox="0 0 640 240">'
                '<text>订单</text></svg></body></html>', encoding="utf-8")
            return SimpleNamespace(
                returncode=0, stdout=json.dumps({"ok": True, "diagnostics": []}),
                stderr="")

        with tempfile.TemporaryDirectory() as temp_dir:
            result = archify_bridge.render_machine(
                self._machine(), copy.deepcopy(IR), runner=runner,
                runtime={"status": "ok", "major": 20},
                temp_root=Path(temp_dir))
        self.assertEqual(result["status"], "ok")
        self.assertEqual([call[2] for call in calls], ["deliver"])


if __name__ == "__main__":
    unittest.main()
