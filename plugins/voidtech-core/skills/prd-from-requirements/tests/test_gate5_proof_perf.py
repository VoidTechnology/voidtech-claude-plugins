"""门 5「渲染器验证证明继承」与「性能基准」fixture（技术设计 §10/§11；ADR-0005 §8）。

补充契约（接 test_gate5_atlas.py）：

- `atlas.proof_inherits(previous_proof, current_env) -> bool`：渲染器验证证明
  的继承判定。八个继承键 `rendererVersion`、`generatorVersion`、
  `schemaVersion`、`assetDigest`、`archifyDigest`、`fixtureDigest`、
  `validationHarnessVersion`、`browserMatrixVersion` 全部相等才继承；
  任一变化（含 Archify、fixture 与验证 harness 更新）都使旧证明失效。
  纯函数、不读文件。
- `atlas.html` 渲染（html 阶段 build_plan 含 `logic-atlas.html`）：自包含
  （无外链 script/css）、顶部自述生成快照。
- 性能基准：真实 Example 工作树（迁移后启用 markdown 阶段），每次
  compile + build_plan 在 5 秒内完成（技术设计 §11 性能门），峰值内存
  低于 1 GiB。
"""

import os
import resource
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

from legacy_fixture import make_legacy_worktree, enable_logic_atlas  # noqa: F401
from test_gate2_example import EXAMPLE

from prdsync import atlas, migration

PROOF = {
    "rendererVersion": "1.0.0",
    "generatorVersion": "1.0.0",
    "schemaVersion": "1",
    "assetDigest": "sha256:" + "ab" * 32,
    "archifyDigest": "sha256:" + "ef" * 32,
    "fixtureDigest": "sha256:" + "cd" * 32,
    "validationHarnessVersion": "1.0.0",
    "browserMatrixVersion": "2026-07",
}


class ProofInheritanceTest(unittest.TestCase):
    def test_identical_keys_inherit(self):
        self.assertTrue(atlas.proof_inherits(PROOF, dict(PROOF)))

    def test_any_key_change_invalidates(self):
        for key in PROOF:
            with self.subTest(key=key):
                changed = dict(PROOF)
                changed[key] = "changed-" + str(changed[key])
                self.assertFalse(atlas.proof_inherits(PROOF, changed),
                                 f"{key} 变化必须使旧证明失效")


class HtmlStageTest(unittest.TestCase):
    def test_html_publish_is_self_contained(self):
        from legacy_fixture import MANUAL_KEY, write_atlas_module
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        write_atlas_module(root)
        enable_logic_atlas(root, "html")
        atlas.publish(root)
        html_path = root / "logic-atlas.html"
        self.assertTrue(html_path.exists())
        html = html_path.read_text(encoding="utf-8")
        # 自包含:不加载任何远程资源;正文含页面与快照自述。
        for marker in ('src="http', "src='http", 'href="http', "href='http"):
            self.assertNotIn(marker, html)
        self.assertIn("客户列表页", html)
        manifest = root / "_generated/logic/manifest.json"
        import json as _json
        digest = _json.loads(manifest.read_text(encoding="utf-8"))[
            "authoritativeSourceDigest"].removeprefix("sha256:")
        self.assertIn(digest[:12], html)


@unittest.skipIf(EXAMPLE is None, "Example worktree not present on this machine")
class ExamplePerformanceTest(unittest.TestCase):
    CONFIRMATIONS = {"SAAS-015+a": "SAAS-900", "MBR-276+a": "MBR-900",
                     "MBR-288+a": "MBR-901", "PTL-210+a": "PTL-900"}
    REPEATS = 3
    BUDGET_SECONDS = 5.0
    MEMORY_BUDGET_BYTES = 1 << 30  # 1 GiB

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._tmp.name) / "example"
        shutil.copytree(EXAMPLE, cls.root)
        # 真实 Example 树可能已在原地完成迁移/Atlas 发布（2026-07-23 起）；
        # 本测试度量的是「对 legacy 内容的一次全新迁移 + Atlas 编译」，
        # 因此先剥离副本上的迁移与 Atlas 产物，还原 legacy 视角。
        for rel in ("prd-worktree.json", "logic-atlas.html"):
            (cls.root / rel).unlink(missing_ok=True)
        for rel in ("_source/reconciliation", "_source/revisions",
                    "_generated/logic"):
            shutil.rmtree(cls.root / rel, ignore_errors=True)
        for rel in ("_source/source-registry.json", "_source/sync-state.json"):
            (cls.root / rel).unlink(missing_ok=True)
        migration.commit_migration(cls.root, confirmations=cls.CONFIRMATIONS)
        enable_logic_atlas(cls.root, "markdown")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_compile_and_render_within_budget(self):
        durations = []
        for _ in range(self.REPEATS):
            start = time.monotonic()
            model = atlas.compile(self.root)
            plan = atlas.build_plan(self.root)
            durations.append(time.monotonic() - start)
            self.assertTrue(model["nodes"], "Example 模型不应为空")
            self.assertTrue(plan)
        for duration in durations:
            self.assertLess(duration, self.BUDGET_SECONDS,
                            f"Atlas 编译渲染超出性能预算: {durations}")

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform != "darwin":
            peak *= 1024  # Linux 报 KB，macOS 报字节
        self.assertLess(peak, self.MEMORY_BUDGET_BYTES,
                        f"峰值内存超出预算: {peak} bytes")

    def test_example_model_exposes_gaps_not_fabrication(self):
        model = atlas.compile(self.root)
        # Example 模块尚无机器可解析章节:必须暴露为缺口,而不是画出完整图。
        self.assertTrue(model["gaps"], "骨架级工作树初次生成应暴露大量缺口")
        self.assertEqual(len([n for n in model["nodes"] if n["kind"] == "requirement"]),
                         563)


if __name__ == "__main__":
    unittest.main()
