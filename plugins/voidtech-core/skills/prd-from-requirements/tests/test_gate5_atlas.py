"""门 5「Logic Atlas」核心 fixture（技术设计 §10/§11 门 5；ADR-0005）。

被测契约——worker 在 `scripts/prdsync/atlas.py` 实现：

- `atlas.compile(root) -> dict`：确定性逻辑模型编译器。只消费权威主本的
  机器可解析章节（模块 prd.md 的「页面契约/数据读写/模块交互（机器可解析）」
  三表，表头列序见 templates/module-prd.md）、追溯矩阵经
  `_generated/requirements-ledger.jsonl`（受验证中间生成物）。输出通过
  schemas/logic-model.schema.json；每个正式 node/edge 必须携带来源
  （schema 强制 minItems 1）；无法解析的模块如实进 `gaps`，绝不按产品经验
  补齐。构建前先检查读取栅栏（存在 publishing/publish-conflict operation
  时抛 effective_view.ReadFenceError）；Atlas 能力未开启抛
  `atlas.AtlasNotEnabled`。两次编译结果逐字节一致。
- `atlas.build_plan(root) -> list`：按 stage 产出发布计划（engine plan 条目）：
  markdown 阶段 = `_generated/logic/logic-model.json`、`_generated/logic/
  logic-atlas.md`、`_generated/logic/manifest.json`、`_generated/logic/
  validation-report.md`；html/polish 阶段另含 `logic-atlas.html`。
  manifest 至少含 `generatorVersion`、`logicModelSchemaVersion`、
  `authoritativeSourceDigest`、`ledgerSourceDigest`、`ledgerArtifactDigest`
  （三摘要，ADR-0005 §6）。logic-atlas.md 顶部自述生成快照（含
  authoritativeSourceDigest 短哈希），不得静态宣称「当前最新」。
- `atlas.publish(root) -> operation manifest`：经 operation_engine 以 maintain
  operation 提交 build_plan（暂存发布协议不绕过）。模型校验失败（如跨模块
  交互指向不存在的模块）抛 `atlas.AtlasValidationError` 且不写任何文件
  ——fail closed，不产出「最新可用」假状态。
- `atlas.check_freshness(root) -> {"contentFresh": bool, "reasons": [...]}`：
  严格只读零写入。重算三摘要与已发布 manifest 比对：任一不一致（含带外改
  主本、旧/坏 Ledger 配新主本）→ contentFresh False；pending revision 与
  pending change 不参与判定——未确认内容不得让 PRD 未变的 Atlas 无故过期。
- `atlas.gate_requirements(root) -> {"stage": str, "steps": [...]}`：内容门
  按阶段裁剪。stage ∈ legacy/markdown/html/polish（无 prd-worktree.json 或
  logicAtlas 未开启 → legacy，steps 为空）。步骤 id 与阻塞性固定为：
  markdown → rebuild-ledger / compile-logic-model / validate-model /
  render-markdown / write-manifest / static-check-markdown（全部 blocking）；
  html → markdown 全部 + render-html / static-check-html（blocking）；
  polish → html 全部 + naturalize-narratives（blocking=False，自然化不阻塞
  日常维护，不可用时回退原文）。
"""

import json
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    ATLAS_MODULE_PRD_BROKEN, MANUAL_KEY, MODULE_A_PRD_RELPATH, ROWS_V2,
    build_xlsx, enable_logic_atlas, make_legacy_worktree, write_atlas_module,
)
from worktree_fixture import SKILL_ROOT, snapshot

from prdsync import atlas, base_cas, effective_view, migration, sync
from prdsync.canonical_store import read_json
from prdsync.schema_validator import check, load_schema

SOURCE_ID = "requirements-xlsx"
MODEL_RELPATH = "_generated/logic/logic-model.json"
MD_RELPATH = "_generated/logic/logic-atlas.md"
MANIFEST_RELPATH = "_generated/logic/manifest.json"
REPORT_RELPATH = "_generated/logic/validation-report.md"


def atlas_worktree(testcase, stage="markdown"):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    write_atlas_module(root)
    enable_logic_atlas(root, stage)
    return root, Path(tmp.name)


class CompileTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = atlas_worktree(self)

    def test_model_is_schema_valid_and_extracts_declared_structure(self):
        model = atlas.compile(self.root)
        errors = check(model, load_schema(SKILL_ROOT / "schemas", "logic-model"))
        self.assertEqual(errors, [])

        pages = [n for n in model["nodes"] if n["kind"] == "page"]
        self.assertEqual({p["title"] for p in pages}, {"客户列表页", "客户详情页"})
        data_objects = [n for n in model["nodes"] if n["kind"] == "dataObject"]
        self.assertTrue(any(n["title"] == "客户" for n in data_objects))
        requirements = [n for n in model["nodes"] if n["kind"] == "requirement"]
        self.assertEqual(len(requirements), 6)
        edge_kinds = {e["kind"] for e in model["edges"]}
        self.assertTrue({"reads", "writes", "interacts"} <= edge_kinds)

    def test_skeleton_module_yields_gaps_not_fabrication(self):
        model = atlas.compile(self.root)
        gap_scopes = {g["scopeId"] for g in model["gaps"]}
        self.assertTrue(any("02-module-b" in s for s in gap_scopes),
                        "骨架级模块必须呈现为缺口")
        # 骨架模块没有页面被凭空补齐。
        module_b_pages = [n for n in model["nodes"]
                         if n["kind"] == "page" and "02-module-b" in n["scopeId"]]
        self.assertEqual(module_b_pages, [])

    def test_compile_is_deterministic(self):
        first = json.dumps(atlas.compile(self.root), sort_keys=True, ensure_ascii=False)
        second = json.dumps(atlas.compile(self.root), sort_keys=True, ensure_ascii=False)
        self.assertEqual(first, second)

    def test_compile_respects_read_fence(self):
        ops_dir = self.root / "_source/reconciliation/operations"
        (ops_dir / "op-fake.json").write_text(
            json.dumps({"operationId": "op-fake", "phase": "publishing",
                        "commitPoint": "operationState",
                        "targetSource": None, "targetRevision": None}),
            encoding="utf-8")
        with self.assertRaises(effective_view.ReadFenceError):
            atlas.compile(self.root)

    def test_compile_requires_capability(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        with self.assertRaises(atlas.AtlasNotEnabled):
            atlas.compile(root)


class PublishAndFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = atlas_worktree(self)
        manifest = atlas.publish(self.root)
        self.assertEqual(manifest["phase"], "committed")

    def test_published_artifacts_and_manifest_digests(self):
        for rel in (MODEL_RELPATH, MD_RELPATH, MANIFEST_RELPATH, REPORT_RELPATH):
            self.assertTrue((self.root / rel).exists(), rel)
        manifest = read_json(self.root / MANIFEST_RELPATH)
        self.assertEqual(manifest["authoritativeSourceDigest"],
                         base_cas.authoritative_source_digest(self.root))
        self.assertEqual(manifest["ledgerSourceDigest"],
                         base_cas.ledger_source_digest(self.root))
        for key in ("generatorVersion", "logicModelSchemaVersion", "ledgerArtifactDigest"):
            self.assertIn(key, manifest)
        # Markdown 视图自述生成快照，不宣称「当前最新」。
        md = (self.root / MD_RELPATH).read_text(encoding="utf-8")
        digest_hex = manifest["authoritativeSourceDigest"].removeprefix("sha256:")
        self.assertIn(digest_hex[:12], md)
        self.assertIn("客户列表页", md)

    def test_fresh_after_publish_then_stale_on_master_edit(self):
        self.assertTrue(atlas.check_freshness(self.root)["contentFresh"])
        (self.root / MODULE_A_PRD_RELPATH).write_text(
            (self.root / MODULE_A_PRD_RELPATH).read_text(encoding="utf-8") + "\n补充说明\n",
            encoding="utf-8")
        before = snapshot(self.root)
        result = atlas.check_freshness(self.root)
        self.assertFalse(result["contentFresh"])
        self.assertEqual(snapshot(self.root), before, "检查器必须零写入")

    def test_pending_revision_does_not_stale_atlas(self):
        v2 = self.tmp / "v2.xlsx"
        build_xlsx(v2, data_rows=ROWS_V2)
        sync.sync_source(self.root, SOURCE_ID, v2)  # 只推进 observed/pending
        self.assertTrue(atlas.check_freshness(self.root)["contentFresh"],
                        "未确认内容不得让 PRD 未变的 Atlas 无故过期")

    def test_tampered_ledger_is_stale(self):
        ledger = self.root / "_generated/requirements-ledger.jsonl"
        ledger.write_text(ledger.read_text(encoding="utf-8") + '{"junk":1}\n',
                          encoding="utf-8")
        self.assertFalse(atlas.check_freshness(self.root)["contentFresh"],
                         "旧/坏 Ledger 配新主本不得 contentFresh")


class FailClosedTest(unittest.TestCase):
    def test_validation_failure_writes_nothing(self):
        root, _ = atlas_worktree(self)
        write_atlas_module(root, ATLAS_MODULE_PRD_BROKEN)  # 指向不存在的模块
        with self.assertRaises(atlas.AtlasValidationError):
            atlas.publish(root)
        self.assertFalse((root / MODEL_RELPATH).exists())
        self.assertFalse((root / MD_RELPATH).exists())


class StageGateTest(unittest.TestCase):
    MARKDOWN_STEPS = ["rebuild-ledger", "compile-logic-model", "validate-model",
                      "render-markdown", "write-manifest", "static-check-markdown"]

    def _steps(self, root):
        gate = atlas.gate_requirements(root)
        return gate["stage"], [(s["id"], s["blocking"]) for s in gate["steps"]]

    def test_legacy_and_disabled_have_no_atlas_steps(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        legacy_root = make_legacy_worktree(tmp.name)
        stage, steps = self._steps(legacy_root)
        self.assertEqual((stage, steps), ("legacy", []))

        migration.commit_migration(legacy_root, confirmations={MANUAL_KEY: "TST-006"})
        stage, steps = self._steps(legacy_root)  # sourceSync 开、logicAtlas 关
        self.assertEqual((stage, steps), ("legacy", []))

    def test_markdown_stage_excludes_html(self):
        root, _ = atlas_worktree(self, stage="markdown")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "markdown")
        self.assertEqual([s for s, _ in steps], self.MARKDOWN_STEPS)
        self.assertTrue(all(blocking for _, blocking in steps))

    def test_html_stage_appends_blocking_html_steps(self):
        root, _ = atlas_worktree(self, stage="html")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "html")
        self.assertEqual([s for s, _ in steps],
                         self.MARKDOWN_STEPS + ["render-html", "static-check-html"])
        self.assertTrue(all(blocking for _, blocking in steps))

    def test_polish_stage_naturalization_is_non_blocking(self):
        root, _ = atlas_worktree(self, stage="polish")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "polish")
        self.assertEqual(steps[-1], ("naturalize-narratives", False))
        self.assertTrue(all(blocking for _, blocking in steps[:-1]))


if __name__ == "__main__":
    unittest.main()
