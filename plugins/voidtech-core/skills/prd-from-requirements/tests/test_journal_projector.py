"""门 1「journal 总序」fixture：乱序文件名/时间戳下投影结果稳定（§3.8、§7.2）。"""

import json
import unittest
from pathlib import Path

from worktree_fixture import NOW, OCC, temp_worktree

from prdsync import journal_projector


def _manifest(root, operation_id, *, phase, commit_point="operationState",
              target_source=None, target_revision=None):
    path = root / journal_projector.OPERATIONS_RELPATH / f"{operation_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "operationId": operation_id, "phase": phase, "commitPoint": commit_point,
        "targetSource": target_source, "targetRevision": target_revision,
    }), encoding="utf-8")


def _segment(root, seq, operation_id, records):
    path = (root / journal_projector.DECISIONS_RELPATH
            / f"{seq:06d}-{operation_id}.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def _map(decision_id, occ, req, decided_at, supersedes=None):
    return {"decisionId": decision_id, "action": "map", "sourceOccurrenceId": occ,
            "requirementId": req, "assertionRole": "normative",
            "basis": "manual-confirmation", "confidence": "confirmed",
            "decidedAt": decided_at, "decidedBy": "dodo",
            "supersedes": supersedes, "schemaVersion": 1}


class TotalOrderTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_worktree(self)
        for op in ("op-j-1", "op-j-2", "op-j-3"):
            _manifest(self.root, op, phase="committed")
        # 未越过提交点的 operation：其 segment 不参与投影。
        _manifest(self.root, "op-j-4", phase="publishing")
        # 同步类 operation 未写 committed，但 appliedRevision 已推进（=rev-base01）
        # ——已越过提交点，segment 必须参与投影。
        _manifest(self.root, "op-j-5", phase="publishing",
                  commit_point="appliedRevision",
                  target_source="requirements-xlsx", target_revision="rev-base01")

        # 故意用乱序的创建顺序和误导性时间戳写入 segment。
        _segment(self.root, 3, "op-j-3",
                 [_map("MAP-3", OCC, "REQ-203", "2026-07-01T00:00:00+08:00")])
        _segment(self.root, 1, "op-j-1",
                 [_map("MAP-1", OCC, "REQ-200", "2026-07-31T23:59:59+08:00")])
        _segment(self.root, 2, "op-j-2",
                 [_map("MAP-2", OCC, "REQ-201", NOW, supersedes="MAP-1")])
        _segment(self.root, 4, "op-j-4",
                 [_map("MAP-4", OCC, "REQ-999", NOW)])
        occ2 = "requirements-xlsx@rev-base01/occ-aaaa.0"
        _segment(self.root, 5, "op-j-5", [_map("MAP-5", occ2, "REQ-100", NOW)])

    def test_projection_stable_and_filtered(self):
        projection = journal_projector.project(self.root)
        # 总序按数值 segmentSeq：occ 的有效裁决是 seq 3 的 MAP-3，
        # 与文件创建顺序、decidedAt 均无关；MAP-1 已被 MAP-2 supersede。
        self.assertEqual(projection["mappings"][OCC]["decisionId"], "MAP-3")
        # 未越过提交点的 op-j-4 不参与投影。
        self.assertNotEqual(projection["mappings"][OCC]["requirementId"], "REQ-999")
        # 同步类 op-j-5 已推进 appliedRevision，参与投影。
        occ2 = "requirements-xlsx@rev-base01/occ-aaaa.0"
        self.assertEqual(projection["mappings"][occ2]["requirementId"], "REQ-100")

    def test_segment_order_is_numeric_not_lexicographic(self):
        paths = [p.name for p in journal_projector.committed_segment_paths(self.root)]
        self.assertEqual(paths, ["000001-op-j-1.jsonl", "000002-op-j-2.jsonl",
                                 "000003-op-j-3.jsonl", "000005-op-j-5.jsonl"])


class SerializationTest(unittest.TestCase):
    def test_jsonl_field_order_follows_schema_declaration(self):
        record = _map("MAP-1", OCC, "REQ-200", NOW)
        line = journal_projector.serialize_records([record]).decode("utf-8").splitlines()[0]
        keys = list(json.loads(line).keys())
        self.assertEqual(keys, journal_projector.record_field_order(record))
        self.assertEqual(keys[0], "decisionId")


if __name__ == "__main__":
    unittest.main()
