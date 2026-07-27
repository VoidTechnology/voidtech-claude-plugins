"""门 4「absorbed change / retired source / 未来 effectiveAt」fixture
（技术设计 §11 门 4 三组、§3.6、§7.3；ADR-0004 §2/§5/§6）。

补充契约（接 test_gate4_merge.py）——worker 在 `scripts/prdsync/merge.py` 实现：

- `merge.register_change(root, change_id, requirement_id, normalized_text) -> dict`：
  登记带外变更（change-stream 降级入口）：registry 中按 append-only 注册
  change 源（首次时），写 `_source/changes/<change_id>/manifest.json`（至少含
  `changeId`、`status: "applied"`、`requirementId`、`normalizedText`、
  `retainedForAudit: true`、`sustainsRequirement: true`），并落 journal map
  裁决（`basis: "change-manifest"`、`assertionRole: "normative"`）。
- 来源回填与 absorbed（ADR-0004 §6 步骤 4）：pending revision 中出现与某
  applied change 规范化正文**字节级相等**的 occurrence 时，`propose_sync`
  归类 `"source-backfill"`（沿用原编号、confidence auto、不生成新编号）；
  `commit_proposal` 后原 change `status` 置 `"absorbed"`、
  `sustainsRequirement` 置 false（`retainedForAudit` 恒真）——支撑转移到
  吸收它的 occurrence，此后主表再删除该需求时照常产生撤回候选，
  不被旧 change 永久阻止。
- `merge.propose_source_retirement(root, source_id)` + commit：registry 中该源
  `status` 置 `"retired"`（sourceId 永不删除），此后 `sync.sync_source` 对该源
  抛 `sync.SourceRetired`（不再接受新 revision）。retired 的唯一语义就这一条：
  最后一次 applied 的 assertion 默认**继续有效**，不产生撤回候选。
- `merge.propose_assertion_invalidation(root, source_id)` + commit：独立
  proposal 批量失效该源 assertion——以 `remap` 记录把生效映射的
  `assertionRole` 降为 `"contextual"`（编号不变），提交后按聚合规则产生
  撤回候选。不允许借 registry 状态静默改变需求生命周期。
- 未来 `effectiveAt`（§7.3）：`propose_lifecycle(..., effective_at=<未来时刻>)`
  只保存为 open proposal——不改变当前状态、不写 transition；显式
  `commit_proposal` 时状态才生效（`effectiveAt` 仅是审计字段，随记录保存）。
  实现不得读取墙钟做状态判断。
"""

import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    BACKFILL_TEXT, MANUAL_KEY, ROWS_BASE, ROWS_BACKFILL, build_xlsx,
    make_legacy_worktree,
)

from prdsync import journal_projector, merge, migration, sync
from prdsync.canonical_store import read_json

SOURCE_ID = "requirements-xlsx"
FUTURE = "2033-01-01T00:00:00+08:00"


def _migrated_worktree(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    return root, Path(tmp.name)


def _change_manifest(root, change_id):
    return read_json(root / "_source/changes" / change_id / "manifest.json")


class AbsorbedChangeTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = _migrated_worktree(self)
        merge.register_change(self.root, "CHG-20260722-001",
                              requirement_id="TST-100",
                              normalized_text=BACKFILL_TEXT)

    def test_register_change_creates_effective_assertion(self):
        manifest = _change_manifest(self.root, "CHG-20260722-001")
        self.assertEqual(manifest["status"], "applied")
        self.assertTrue(manifest["sustainsRequirement"])
        projection = journal_projector.project(self.root)
        change_records = [r for r in projection["mappings"].values()
                          if r["basis"] == "change-manifest"]
        self.assertEqual(len(change_records), 1)
        self.assertEqual(change_records[0]["requirementId"], "TST-100")
        # 带外合入的需求不因主表缺席而成为撤回候选(仍有 normative 支撑)。
        self.assertEqual(merge.withdrawal_candidates(self.root), [])

    def _commit_backfill(self):
        backfill = self.tmp / "backfill.xlsx"
        build_xlsx(backfill, data_rows=ROWS_BACKFILL)
        sync.sync_source(self.root, SOURCE_ID, backfill)
        proposal = merge.propose_sync(self.root, SOURCE_ID)
        backfills = [m for m in proposal["mappings"]
                     if m["classification"] == "source-backfill"
                     and m["requirementId"] == "TST-100"]
        self.assertEqual(len(backfills), 1, "byte-equal change must backfill, not new")
        self.assertEqual(backfills[0]["confidence"], "auto")
        merge.commit_proposal(self.root, proposal["proposalId"], decisions={})
        return proposal

    def test_backfill_absorbs_change(self):
        self._commit_backfill()
        manifest = _change_manifest(self.root, "CHG-20260722-001")
        self.assertEqual(manifest["status"], "absorbed")
        self.assertFalse(manifest["sustainsRequirement"])
        self.assertTrue(manifest["retainedForAudit"])
        # 编号沿用,不产生 TST-101。
        ids = {r["requirementId"]
               for r in journal_projector.project(self.root)["mappings"].values()}
        self.assertIn("TST-100", ids)
        self.assertNotIn("TST-101", ids)

    def test_absorbed_change_does_not_block_withdrawal(self):
        self._commit_backfill()
        # 主表随后又删掉该需求:撤回候选照常产生,不被旧 change 阻止。
        base_again = self.tmp / "base-again.xlsx"
        build_xlsx(base_again, data_rows=ROWS_BASE, date_time=(2026, 7, 23, 0, 0, 0))
        sync.sync_source(self.root, SOURCE_ID, base_again)
        proposal = merge.propose_sync(self.root, SOURCE_ID)
        candidates = [m["requirementId"] for m in proposal["mappings"]
                      if m["classification"] == "withdrawal-candidate"]
        self.assertIn("TST-100", candidates)


class RetiredSourceTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = _migrated_worktree(self)
        proposal = merge.propose_source_retirement(self.root, SOURCE_ID)
        merge.commit_proposal(self.root, proposal["proposalId"])

    def test_retired_source_rejects_new_revisions(self):
        registry = read_json(self.root / "_source/source-registry.json")
        entry = next(s for s in registry["sources"] if s["sourceId"] == SOURCE_ID)
        self.assertEqual(entry["status"], "retired")
        new_input = self.tmp / "new.xlsx"
        build_xlsx(new_input, date_time=(2026, 7, 23, 0, 0, 0))
        with self.assertRaises(sync.SourceRetired):
            sync.sync_source(self.root, SOURCE_ID, new_input)

    def test_assertions_stay_effective_until_invalidated(self):
        # retired 只意味着不再接受新 revision:assertion 默认继续有效。
        self.assertEqual(merge.withdrawal_candidates(self.root), [])
        projection = journal_projector.project(self.root)
        self.assertEqual(len(projection["mappings"]), 6)

        proposal = merge.propose_assertion_invalidation(self.root, SOURCE_ID)
        merge.commit_proposal(self.root, proposal["proposalId"])
        # 批量失效后:角色降为 contextual、编号保留,撤回候选覆盖全部需求。
        projection = journal_projector.project(self.root)
        roles = {r["assertionRole"] for r in projection["mappings"].values()}
        self.assertEqual(roles, {"contextual"})
        candidates = {c["requirementId"] for c in merge.withdrawal_candidates(self.root)}
        self.assertEqual(candidates,
                         {"TST-001", "TST-002", "TST-003", "TST-004", "TST-005", "TST-006"})


class FutureEffectiveAtTest(unittest.TestCase):
    def test_future_lifecycle_stays_open_until_explicit_commit(self):
        root, _ = _migrated_worktree(self)
        proposal = merge.propose_lifecycle(root, "TST-004", "withdraw",
                                           effective_at=FUTURE)
        # 提案不改状态:无 transition、proposal 保持 open。
        self.assertEqual(proposal["status"], "open")
        self.assertNotIn("TST-004", journal_projector.project(root)["transitions"])
        stored = read_json(root / "_source/reconciliation/proposals"
                           / f"{proposal['proposalId']}.json")
        self.assertEqual(stored["status"], "open")
        self.assertEqual(stored["lifecycleActions"][0]["effectiveAt"], FUTURE)

        # 显式确认提交:状态在提交时生效,effectiveAt 只是审计字段。
        merge.commit_proposal(root, proposal["proposalId"])
        transitions = journal_projector.project(root)["transitions"]["TST-004"]
        self.assertEqual(transitions[-1]["to"], "withdrawn")
        self.assertEqual(transitions[-1]["effectiveAt"], FUTURE)


if __name__ == "__main__":
    unittest.main()
