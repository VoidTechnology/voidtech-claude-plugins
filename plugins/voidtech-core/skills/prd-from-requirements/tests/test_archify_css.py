"""Archify SVG 样式搬运契约：纯类名 SVG 必须带着作用域化配色落地。

2026-07-24 黑块回归的守门：导入裸 SVG 而不搬模板 CSS 时，所有元素回落
SVG 默认 fill:black。本套测试锁定抽取器的确定性、作用域前缀、主题桥接
与 fail-closed 降级。
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from worktree_fixture import SKILL_ROOT  # noqa: F401

from prdsync import archify_bridge


TOKENS = {"t-primary", "c-backend"}
PRESETS = {"blueprint"}


class LifecycleSvgCssTest(unittest.TestCase):
    def test_extraction_is_deterministic_and_scoped(self):
        first = archify_bridge.lifecycle_svg_css(TOKENS, PRESETS)
        second = archify_bridge.lifecycle_svg_css(TOKENS, PRESETS)
        self.assertIsNotNone(first)
        self.assertEqual(first, second)
        for line in first.splitlines():
            self.assertTrue(
                line.startswith(".archify-lifecycle-svg")
                or line.startswith("@media (prefers-color-scheme: dark){"
                                   ".archify-lifecycle-svg")
                or line.startswith(':root[data-theme="light"] '
                                   ".archify-lifecycle-svg")
                or line.startswith(':root[data-theme="dark"] '
                                   ".archify-lifecycle-svg"),
                f"未作用域化的规则泄漏: {line[:80]}")

    def test_theme_bridge_and_semantic_classes_present(self):
        css = archify_bridge.lifecycle_svg_css(TOKENS, PRESETS)
        self.assertIn('.archify-lifecycle-svg svg[data-preset="blueprint"]'
                      "{background:var(--bg);", css)
        self.assertIn("@media (prefers-color-scheme: dark)", css)
        self.assertIn(':root[data-theme="dark"] .archify-lifecycle-svg', css)
        self.assertIn(".archify-lifecycle-svg .t-primary{", css)
        self.assertIn("--backend-fill:", css)
        self.assertNotIn("@import", css)
        self.assertNotIn("<", css)

    def test_unknown_tokens_or_presets_fail_closed(self):
        self.assertIsNone(archify_bridge.lifecycle_svg_css(set(), PRESETS))
        self.assertIsNone(archify_bridge.lifecycle_svg_css(TOKENS, set()))
        self.assertIsNone(
            archify_bridge.lifecycle_svg_css(TOKENS, {"no-such-preset"}))
        self.assertIsNone(
            archify_bridge.lifecycle_svg_css({"no-such-class"}, PRESETS))

    def test_broken_template_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "template.html"
            broken.write_text("<html>no style here</html>", encoding="utf-8")
            self.assertIsNone(archify_bridge.lifecycle_svg_css(
                TOKENS, PRESETS, template_path=broken))

    def test_svg_style_inputs_collects_tokens_and_presets(self):
        tokens, presets = archify_bridge.svg_style_inputs([
            '<svg data-preset="blueprint"><text class="t-primary x">A</text>'
            '<rect class="c-backend"/></svg>',
        ])
        self.assertEqual(presets, {"blueprint"})
        self.assertEqual(tokens, {"t-primary", "x", "c-backend"})

    def test_build_presentation_degrades_when_css_unextractable(self):
        model = {"nodes": [], "edges": [], "scopes": [], "gaps": []}
        machines = [{
            "machineId": "m-1", "scopeId": "s", "object": "订单",
            "states": [], "transitions": [],
        }]
        original_extract = archify_bridge.lifecycle_ir.extract_machines
        original_build = archify_bridge.lifecycle_ir.build_lifecycle_ir
        original_render = archify_bridge.render_machine
        original_css = archify_bridge.lifecycle_svg_css
        archify_bridge.lifecycle_ir.extract_machines = lambda _m: machines
        archify_bridge.lifecycle_ir.build_lifecycle_ir = lambda _m: {}
        archify_bridge.render_machine = (
            lambda machine, ir, **_kw: {
                "machineId": machine["machineId"],
                "scopeId": machine["scopeId"],
                "object": machine["object"],
                "status": "ok", "attempts": 1, "diagnostics": [],
                "svg": '<svg data-preset="blueprint">'
                       '<text class="t-primary">x</text></svg>',
                "svgDigest": "sha256:x", "ir": {}, "irDigest": "sha256:x",
            })
        archify_bridge.lifecycle_svg_css = lambda *_a, **_kw: None
        fake_runner = lambda *a, **kw: SimpleNamespace(
            returncode=0, stdout="v22.0.0\n", stderr="")
        try:
            payload = archify_bridge.build_presentation(
                model, runner=fake_runner, executable="node")
        finally:
            archify_bridge.lifecycle_ir.extract_machines = original_extract
            archify_bridge.lifecycle_ir.build_lifecycle_ir = original_build
            archify_bridge.render_machine = original_render
            archify_bridge.lifecycle_svg_css = original_css
        self.assertEqual(payload["css"], "")
        self.assertIsNone(payload["cssDigest"])
        machine = payload["machines"][0]
        self.assertEqual(machine["status"], "degraded")
        self.assertNotIn("svg", machine)
        self.assertEqual(machine["diagnostics"][0]["code"],
                         "artifact/css-extraction-failed")
        self.assertEqual(len(payload["presentationRisk"]), 1)


if __name__ == "__main__":
    unittest.main()
