"""门 4「受控合入」核心 fixture（技术设计 §12 第 4 步；ADR-0004 §4/§6 第二阶段）。

被测契约——worker 在 `scripts/prdsync/merge.py` 实现：

- `merge.propose_sync(root, source_id) -> proposal dict`：对该源 pending
  revision 与全局 Requirement Ledger 做三方归并，产出 proposal（过 proposal
  schema，经 operation_engine.build_proposal 落盘）。分类收敛为三桶：
  - 规范化正文**字节级相等**的 occurrence → 自动通道（`classification:
    "unchanged"` 或来源回填 `"source-backfill"`，`confidence: "auto"`，
    requirementId 沿用既有编号）；
  - 有匹配候选但非字节相等（如同模块内存在消失的既有需求）→ 一律确认：
    进 `ambiguities`（`kind: "identity"`，`candidateRequirementIds` 给出
    确定性候选），绝不自动裁决；
  - 无匹配 → `classification: "new"`，`requirementId: null`，等待确认后
    才分配新编号（防重复编号：新编号 = 该前缀现有最大号 + 1，绝不复用）。
  某源 occurrence 消失且无有效支撑时 → `classification:
  "withdrawal-candidate"`（confidence 按 ADR-0004 §6 优先级表），只提候选，
  不改任何生命周期状态。
- `merge.commit_proposal(root, proposal_id, decisions=None) -> operation manifest`：
  按人工裁决提交。`decisions` 把 occurrenceId 映射到 `"TST-002"`（确认既有
  编号）或 `"new"`（分配新编号）。自动桶批量机器裁决（`basis:
  "exact-fingerprint"`、`confidence: "machine"`）与人工确认（`basis:
  "manual-confirmation"`、`confidence: "confirmed"`）同一事务落 journal；
  提交后该源 appliedRevision 推进、pending 清空。歧义与 new 未裁决时抛
  `merge.DecisionRequired`，不提交任何内容。
- `merge.withdrawal_candidates(root) -> list`：按当前有效视图聚合的撤回候选
  （每项至少含 `requirementId`、`confidence`），任何情况下不自动改状态。
- `merge.propose_lifecycle(root, requirement_id, lifecycle_action,
  effective_at=None) -> proposal` 与 commit_proposal 配合：生命周期迁移经
  journal `transition` 记录生效（工况 5 的 journal 侧）。
- 修复门 3 遗留：`sync.sync_source` 的游标更新必须在 writer lock 内执行
  （§2.2 锁内 compare-and-write）——他人持锁时抛 writer_lock.LockHeld；
  对未迁移的 legacy 工作树调用 sync/merge 抛 `sync.SourceNotInitialized`
  （或同名清晰异常），不得以 KeyError/TypeError 裸奔。
"""

import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    MANUAL_KEY, ROWS_REMOVED, ROWS_V2, build_xlsx, make_legacy_worktree,
)
from worktree_fixture import SKILL_ROOT

from prdsync import journal_projector, merge, migration, sync, writer_lock
from prdsync.canonical_store import read_json
from prdsync.schema_validator import check, load_schema

SOURCE_ID = "requirements-xlsx"


def _migrated_worktree(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    return root, Path(tmp.name)


def _state(root):
    return read_json(root / "_source/sync-state.json")["sources"][SOURCE_ID]


class ThreeWayMergeTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = _migrated_worktree(self)
        v2 = self.tmp / "v2.xlsx"
        build_xlsx(v2, data_rows=ROWS_V2)
        sync.sync_source(self.root, SOURCE_ID, v2)

    def test_proposal_buckets(self):
        proposal = merge.propose_sync(self.root, SOURCE_ID)
        self.assertEqual(check(proposal, load_schema(SKILL_ROOT / "schemas", "proposal")), [])

        by_class = {}
        for mapping in proposal["mappings"]:
            by_class.setdefault(mapping["classification"], []).append(mapping)
        # 字节等价 5 行自动沿用编号。
        auto = by_class.get("unchanged", []) + by_class.get("source-backfill", [])
        self.assertEqual(len(auto), 5)
        for mapping in auto:
            self.assertEqual(mapping["confidence"], "auto")
            self.assertIsNotNone(mapping["requirementId"])
        # 无匹配 1 行(订单退款):new 且不预分配编号。
        new = by_class.get("new", [])
        self.assertEqual(len(new), 1)
        self.assertIsNone(new[0]["requirementId"])
        # 正文修改行(客户列表→支持导出)必须走歧义确认,候选指向 TST-002,绝不自动裁决。
        identity = [a for a in proposal["ambiguities"] if a["kind"] == "identity"]
        self.assertEqual(len(identity), 1)
        self.assertIn("TST-002", identity[0]["candidateRequirementIds"])

    def test_commit_requires_decisions(self):
        proposal = merge.propose_sync(self.root, SOURCE_ID)
        applied_before = _state(self.root)["appliedRevision"]
        with self.assertRaises(merge.DecisionRequired):
            merge.commit_proposal(self.root, proposal["proposalId"])
        self.assertEqual(_state(self.root)["appliedRevision"], applied_before)

    def test_commit_with_decisions(self):
        proposal = merge.propose_sync(self.root, SOURCE_ID)
        ambiguous_occ = proposal["ambiguities"][0]["occurrences"][0]
        new_occ = next(m["sourceOccurrenceId"] for m in proposal["mappings"]
                       if m["classification"] == "new")
        manifest = merge.commit_proposal(self.root, proposal["proposalId"], decisions={
            ambiguous_occ: "TST-002",
            new_occ: "new",
        })
        self.assertEqual(manifest["phase"], "committed")

        state = _state(self.root)
        self.assertEqual(state["appliedRevision"], proposal["candidateRevision"])
        self.assertIsNone(state["pendingRevision"])

        projection = journal_projector.project(self.root)
        rev = proposal["candidateRevision"]
        new_mappings = {occ: rec for occ, rec in projection["mappings"].items()
                        if f"@{rev}/" in occ}
        # 完备性:候选 revision 的 7 条 occurrence 全部有生效裁决。
        self.assertEqual(len(new_mappings), 7)
        # 防重复编号:新增行拿到 TST-007(现有最大号 006 + 1),编号不复用。
        ids = {rec["requirementId"] for rec in new_mappings.values()}
        self.assertIn("TST-007", ids)
        self.assertIn("TST-002", ids)
        # 批量机器裁决与人工确认区分记录。
        bases = {rec["basis"] for rec in new_mappings.values()}
        self.assertIn("exact-fingerprint", bases)
        self.assertIn("manual-confirmation", bases)
        machine = [r for r in new_mappings.values() if r["basis"] == "exact-fingerprint"]
        self.assertTrue(all(r["confidence"] == "machine" for r in machine),
                        "批量机器裁决不得呈现为人工确认")


class WithdrawalCandidateTest(unittest.TestCase):
    def test_removed_occurrence_yields_candidate_not_state_change(self):
        root, tmp = _migrated_worktree(self)
        removed = tmp / "removed.xlsx"
        build_xlsx(removed, data_rows=ROWS_REMOVED)
        sync.sync_source(root, SOURCE_ID, removed)

        proposal = merge.propose_sync(root, SOURCE_ID)
        candidates = [m for m in proposal["mappings"]
                      if m["classification"] == "withdrawal-candidate"]
        self.assertEqual([c["requirementId"] for c in candidates], ["TST-005"])
        self.assertEqual(candidates[0]["confidence"], "high")

        merge.commit_proposal(root, proposal["proposalId"], decisions={})
        # 提交同步不改生命周期:TST-005 仍无 transition 记录。
        projection = journal_projector.project(root)
        self.assertNotIn("TST-005", projection["transitions"])
        self.assertEqual([c["requirementId"] for c in merge.withdrawal_candidates(root)],
                         ["TST-005"])

        # 用户裁决撤回:经 lifecycle proposal 落 transition。
        lifecycle = merge.propose_lifecycle(root, "TST-005", "withdraw")
        merge.commit_proposal(root, lifecycle["proposalId"])
        transitions = journal_projector.project(root)["transitions"]["TST-005"]
        self.assertEqual(transitions[-1]["to"], "withdrawn")


class Gate3DebtTest(unittest.TestCase):
    def test_sync_source_requires_writer_lock(self):
        root, tmp = _migrated_worktree(self)
        v2 = tmp / "v2.xlsx"
        build_xlsx(v2, data_rows=ROWS_V2)
        handle = writer_lock.acquire(root, "op-other-writer")
        try:
            with self.assertRaises(writer_lock.LockHeld):
                sync.sync_source(root, SOURCE_ID, v2)
        finally:
            handle.release()

    def test_sync_before_migration_raises_clear_error(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        src = Path(tmp.name) / "input.xlsx"
        build_xlsx(src)
        with self.assertRaises(sync.SourceNotInitialized):
            sync.sync_source(root, SOURCE_ID, src)


if __name__ == "__main__":
    unittest.main()
