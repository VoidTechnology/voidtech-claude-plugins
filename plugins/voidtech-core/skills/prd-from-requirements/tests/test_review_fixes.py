"""/review 独立评审发现的缺陷回归钉（2026-07-23 门 5 合入前修复批次）。

覆盖：F1 空正文/重复 recordKey 身份污染、F2 html Atlas 自我失效、
F3 页面多行动作合并、F4 损坏 segment 摘要崩溃、F6 读取栅栏与生成物对账、
F10 证明空洞继承、合并单元格回填、表头劫持、读写双边、schema 字符类收紧。
"""

import json
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    ATLAS_MODULE_PRD, MANUAL_KEY, ROWS_BASE, build_xlsx, enable_logic_atlas,
    make_legacy_worktree, write_atlas_module,
)
from worktree_fixture import SKILL_ROOT, snapshot

from prdsync import atlas, journal_projector, merge, migration, sync
from prdsync.canonical_store import read_json
from prdsync.schema_validator import check, load_schema

SOURCE_ID = "requirements-xlsx"

# 同一页面两行动作 + 读写行 + 交互重复行。
MULTI_ACTION_PRD = """# 模块甲 PRD

## 3. 需求范围

### 3.4 模块交互（机器可解析）

| 目标模块 | 方向 | 触发 | 失败传播 |
|---|---|---|---|
| 02-module-b | 调用 | 下单查询 | 提示重试 |
| 02-module-b | 调用 | 退款查询 | 提示重试 |

## 5. 核心用户路径

### 5.0 页面契约（机器可解析）

| 页面 | 入口 | 角色 | 前置条件 | 用户动作 | 系统结果 |
|---|---|---|---|---|---|
| 客户列表页 | 主导航 | 管理员 | 已登录 | 查看列表 | 展示分页 |
| 客户列表页 | 主导航 | 管理员 | 已登录 | 导出列表 | 下载文件 |

## 7. 字段与数据规则

### 7.0 数据读写（机器可解析）

| 数据对象 | 操作 | 权威来源 | 同步方式 |
|---|---|---|---|
| 客户 | 读写 | 01-module-a | 实时 |
"""


def _migrated(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    return root, Path(tmp.name)


class EmptyTextIdentityTest(unittest.TestCase):
    """F1：空正文/重复 recordKey 的记录永不进自动通道，重同步不得归并编号。"""

    ROWS_EMPTY_PAIR = ROWS_BASE + [(6, "模块乙", None), (7, "模块乙", None)]

    def _sync_and_propose(self, root, tmp, name):
        path = tmp / name
        build_xlsx(path, data_rows=self.ROWS_EMPTY_PAIR,
                   date_time=(2026, 7, 23, 0, 0, len(name) % 60))
        sync.sync_source(root, SOURCE_ID, path)
        return merge.propose_sync(root, SOURCE_ID)

    def test_duplicate_empty_rows_never_auto_map(self):
        root, tmp = _migrated(self)
        proposal = self._sync_and_propose(root, tmp, "v-empty.xlsx")
        dup = [a for a in proposal["ambiguities"] if a["kind"] == "duplicate"]
        self.assertEqual(len(dup), 2, "两条空正文行必须都进歧义确认")
        decisions = {a["occurrences"][0]: "new" for a in dup}
        merge.commit_proposal(root, proposal["proposalId"], decisions=decisions)
        ids = {r["requirementId"]
               for r in journal_projector.project(root)["mappings"].values()}
        self.assertLessEqual({"TST-007", "TST-008"}, ids, "两行各得独立编号")

        # 重同步同内容（另存）：绝不自动把两条 occurrence 归并到同一编号。
        resaved = tmp / "resync.xlsx"
        build_xlsx(resaved, data_rows=self.ROWS_EMPTY_PAIR,
                   date_time=(2026, 7, 24, 0, 0, 0))
        result = sync.sync_source(root, SOURCE_ID, resaved)
        if not result["noOp"]:
            proposal2 = merge.propose_sync(root, SOURCE_ID)
            auto = [m for m in proposal2["mappings"] if m["confidence"] == "auto"
                    and m["sourceOccurrenceId"].startswith(f"{SOURCE_ID}@")]
            auto_ids = [m["requirementId"] for m in auto]
            self.assertNotIn("TST-007", [i for i in auto_ids if auto_ids.count(i) > 1])
            dup2 = [a for a in proposal2["ambiguities"] if a["kind"] == "duplicate"]
            self.assertEqual(len(dup2), 2)
            for ambiguity in dup2:
                self.assertEqual(sorted(ambiguity["candidateRequirementIds"]),
                                 ["TST-007", "TST-008"])


class MergedCellBackfillTest(unittest.TestCase):
    """§3.5 mergedCells backfill 的合成覆盖（不再只靠可跳过的 Example 测试）。"""

    ROWS_MERGED = ROWS_BASE + [(6, "模块乙", "批量导入"), (7, "模块乙", None)]

    def test_vertical_merge_backfills_continuation_row(self):
        root, tmp = _migrated(self)
        merged = tmp / "merged.xlsx"
        # 数据行从第 3 行起：第 6/7 条数据 = 第 9/10 行，正文列 C9:C10 合并。
        build_xlsx(merged, data_rows=self.ROWS_MERGED, merges=["C9:C10"])
        result = sync.sync_source(root, SOURCE_ID, merged)
        records = [json.loads(line) for line in (
            root / "_source/revisions" / SOURCE_ID / result["revisionId"]
            / "normalized.jsonl").read_text(encoding="utf-8").splitlines() if line]
        merged_rows = [r for r in records if r["normalizedText"] == "批量导入"]
        self.assertEqual(len(merged_rows), 2, "合并续行必须按锚点回填而不是丢弃")
        self.assertEqual(sorted(r["duplicateOrdinal"] for r in merged_rows), [0, 1])

    def test_hostile_giant_merge_is_ignored(self):
        root, tmp = _migrated(self)
        hostile = tmp / "hostile.xlsx"
        build_xlsx(hostile, merges=["A1:XFD1048576"],
                   date_time=(2026, 7, 23, 1, 0, 0))
        result = sync.sync_source(root, SOURCE_ID, hostile)  # 不挂、不耗尽内存
        self.assertTrue(result["noOp"], "超界合并区域被忽略后内容与基线一致")


class HeaderHijackTest(unittest.TestCase):
    """表头识别需 ≥2 逻辑列命中：正文里的「需求点」字面量不得劫持表头。"""

    ROWS_WITH_LITERAL = [(1, "模块甲", "需求点"), *ROWS_BASE[1:]]

    def test_body_literal_does_not_hijack_header(self):
        root, tmp = _migrated(self)
        tricky = tmp / "tricky.xlsx"
        build_xlsx(tricky, data_rows=self.ROWS_WITH_LITERAL)
        result = sync.sync_source(root, SOURCE_ID, tricky)
        records = [json.loads(line) for line in (
            root / "_source/revisions" / SOURCE_ID / result["revisionId"]
            / "normalized.jsonl").read_text(encoding="utf-8").splitlines() if line]
        self.assertEqual(len(records), len(ROWS_BASE), "数据行数不因字面量劫持而塌缩")


class AtlasCompileFixesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = make_legacy_worktree(tmp.name)
        migration.commit_migration(self.root, confirmations={MANUAL_KEY: "TST-006"})
        write_atlas_module(self.root, MULTI_ACTION_PRD)
        enable_logic_atlas(self.root, "markdown")

    def test_multi_action_rows_merge_into_one_page_node(self):
        model = atlas.compile(self.root)
        pages = [n for n in model["nodes"] if n["kind"] == "page"]
        self.assertEqual(len(pages), 1, "同页多行动作必须合并为一个节点")
        self.assertEqual(len(pages[0]["detail"]["actions"]), 2)
        node_ids = [n["nodeId"] for n in model["nodes"]]
        self.assertEqual(len(node_ids), len(set(node_ids)), "无重复 nodeId")
        edge_ids = [e["edgeId"] for e in model["edges"]]
        self.assertEqual(len(edge_ids), len(set(edge_ids)), "无重复 edgeId")

    def test_rw_row_emits_both_edges(self):
        model = atlas.compile(self.root)
        kinds = {e["kind"] for e in model["edges"]}
        self.assertIn("reads", kinds)
        self.assertIn("writes", kinds, "「读写」行的写边不得被静默丢弃")


class AtlasFreshnessFixesTest(unittest.TestCase):
    def _atlas_root(self, stage):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        write_atlas_module(root, ATLAS_MODULE_PRD)
        enable_logic_atlas(root, stage)
        return root

    def test_html_stage_publish_is_fresh(self):
        # F2：html 发布产物不得让 Atlas 自我失效。
        root = self._atlas_root("html")
        atlas.publish(root)
        result = atlas.check_freshness(root)
        self.assertTrue(result["contentFresh"], result["reasons"])

    def test_adjudication_segment_makes_atlas_stale(self):
        # base_cas 空 segment 过滤的反向钉：真实裁决必须触发过期。
        root = self._atlas_root("markdown")
        atlas.publish(root)
        proposal = merge.propose_lifecycle(root, "TST-004", "withdraw")
        merge.commit_proposal(root, proposal["proposalId"])
        result = atlas.check_freshness(root)
        self.assertFalse(result["contentFresh"])
        self.assertIn("ledgerSourceDigest", result["reasons"])

    def test_corrupt_segment_reports_stale_not_crash(self):
        # F4：非 UTF-8 segment 不得让摘要计算崩溃。
        root = self._atlas_root("markdown")
        atlas.publish(root)
        segment = next((root / "_source/reconciliation/decisions").glob("*.jsonl"))
        segment.write_bytes(b"\xff\xfe corrupted \x80\x81\n")
        result = atlas.check_freshness(root)  # 不抛异常
        self.assertFalse(result["contentFresh"])

    def test_artifact_tampering_is_detected(self):
        # F6：带外篡改 _generated 下的 Atlas 内容必须可检测。
        root = self._atlas_root("markdown")
        atlas.publish(root)
        md = root / "_generated/logic/logic-atlas.md"
        md.write_text(md.read_text(encoding="utf-8") + "\n带外篡改\n", encoding="utf-8")
        result = atlas.check_freshness(root)
        self.assertFalse(result["contentFresh"])
        self.assertTrue(any(r.startswith("artifact:") for r in result["reasons"]))

    def test_read_fence_blocks_fresh_and_writes_nothing(self):
        # F6：读取栅栏期间不得宣称 fresh；检查器零写入。
        root = self._atlas_root("markdown")
        atlas.publish(root)
        ops_dir = root / "_source/reconciliation/operations"
        (ops_dir / "op-fence.json").write_text(json.dumps(
            {"operationId": "op-fence", "phase": "publishing",
             "commitPoint": "operationState",
             "targetSource": None, "targetRevision": None}), encoding="utf-8")
        before = snapshot(root)
        result = atlas.check_freshness(root)
        self.assertEqual(result["reasons"], ["read-fence"])
        self.assertEqual(snapshot(root), before)

    def test_republish_uses_new_operation_id(self):
        # 固定 op-atlas 复用会覆盖已 committed manifest：ID 必须随内容变化。
        root = self._atlas_root("markdown")
        first = atlas.publish(root)
        module = root / "01-test-system/01-module-a/prd.md"
        module.write_text(module.read_text(encoding="utf-8") + "\n补充\n",
                          encoding="utf-8")
        second = atlas.publish(root)
        self.assertNotEqual(first["operationId"], second["operationId"])
        self.assertTrue(atlas.check_freshness(root)["contentFresh"])


class ProofStrictTest(unittest.TestCase):
    def test_empty_proof_does_not_inherit(self):
        # F10：空证明对空环境不构成验证证据。
        self.assertFalse(atlas.proof_inherits({}, {}))
        partial = {"rendererVersion": "1.0.0"}
        self.assertFalse(atlas.proof_inherits(partial, dict(partial)))


class SchemaCharsetTest(unittest.TestCase):
    def _operation(self):
        from test_schemas import VALID
        import copy
        return copy.deepcopy(VALID["operation"])

    def test_operation_path_negatives(self):
        schema = load_schema(SKILL_ROOT / "schemas", "operation")
        for bad in ("../escape.md", "/abs.md", "a\\b.md", "a\x01b.md",
                    "a\x7fb.md", "a‮b.md"):
            with self.subTest(path=bad):
                op = self._operation()
                op["files"][0]["path"] = bad
                self.assertTrue(check(op, schema), f"path {bad!r} must be rejected")

    def test_proposal_control_char_negative(self):
        from test_schemas import VALID, mutate
        schema = load_schema(SKILL_ROOT / "schemas", "proposal")
        self.assertTrue(check(mutate(VALID["proposal"],
                                     affectedFiles=["doc‮.md"]), schema))


if __name__ == "__main__":
    unittest.main()
