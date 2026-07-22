"""门 1 fixture 共用的最小 PRD 工作树构造与 operation 驱动。"""

import json
import sys
import tempfile
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from prdsync import operation_engine as engine  # noqa: E402
from prdsync import writer_lock  # noqa: E402

NOW = "2026-07-21T10:00:00+08:00"
OCC = "requirements-xlsx@rev-new01/occ-8f91.0"

MATRIX = "00-global/requirement-traceability-matrix.md"
LEDGER = "_generated/requirements-ledger.jsonl"
LEGACY = "01-portal/09-legacy-module/prd.md"
MODULE_PRD = "01-portal/01-module/prd.md"

ORIGINAL_MATRIX = "| REQ-200 | portal | active |\n"
STAGED_MATRIX = "| REQ-200 | portal | active |\n| REQ-201 | portal | active |\n"
STAGED_LEDGER = '{"requirementId":"REQ-200"}\n{"requirementId":"REQ-201"}\n'


class SimulatedCrash(Exception):
    """测试注入的进程中断。"""


def crash_hook(label):
    def hook(point):
        if point == label:
            raise SimulatedCrash(label)
    return hook


def make_worktree(base) -> Path:
    root = Path(base) / "worktree"

    def write(rel, content):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False, indent=2) + "\n"
        path.write_text(content, encoding="utf-8")

    write("prd-worktree.json", {
        "worktreeSchemaVersion": 1,
        "capabilities": {"sourceSync": True, "logicAtlas": False},
        "logicAtlasStage": None,
        "schemaVersions": {"operation": 1, "proposal": 1, "journal": 1,
                           "normalization": 1, "logicModel": None},
    })
    write(MATRIX, ORIGINAL_MATRIX)
    write(MODULE_PRD, "# portal module\n\nREQ-200\n")
    write(LEGACY, "# legacy module\n")
    write("_source/source-registry.json", {
        "sources": [{"sourceId": "requirements-xlsx", "kind": "workbook",
                     "mode": "versioned", "defaultAssertionRole": "normative",
                     "status": "active"}],
        "schemaVersion": 1,
    })
    write("_source/sync-state.json", {
        "sources": {"requirements-xlsx": {"observedRevision": "rev-new01",
                                          "appliedRevision": "rev-base01",
                                          "pendingRevision": "rev-new01"}},
        "schemaVersion": 1,
    })
    write("_source/revisions/requirements-xlsx/rev-base01/normalized.jsonl",
          '{"recordKey":"sha256:aa","normalizedText":"REQ-200 base"}\n')
    write("_source/revisions/requirements-xlsx/rev-new01/normalized.jsonl",
          '{"recordKey":"sha256:aa","normalizedText":"REQ-200 base"}\n'
          '{"recordKey":"sha256:bb","normalizedText":"REQ-201 new"}\n')
    (root / "_source/reconciliation/decisions").mkdir(parents=True, exist_ok=True)
    (root / "_source/reconciliation/operations").mkdir(parents=True, exist_ok=True)
    return root


def temp_worktree(testcase) -> Path:
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    return make_worktree(tmp.name)


def sync_plan():
    """覆盖文件动作全集：改写、新建、删除。"""
    return [
        {"path": MATRIX, "action": "write", "content": STAGED_MATRIX},
        {"path": LEDGER, "action": "write", "content": STAGED_LEDGER},
        {"path": LEGACY, "action": "delete"},
    ]


def sample_records():
    return [{
        "decisionId": "MAP-20260721-001", "action": "map",
        "sourceOccurrenceId": OCC, "requirementId": "REQ-201",
        "assertionRole": "normative", "basis": "manual-confirmation",
        "confidence": "confirmed", "decidedAt": NOW, "decidedBy": "dodo",
        "supersedes": None, "schemaVersion": 1,
    }]


def controller_record():
    return {
        "decisionId": "CTL-20260721-001", "action": "set-lifecycle-controller",
        "requirementId": "REQ-200", "scopeId": "requirement",
        "controllerSourceId": "requirements-xlsx",
        "decidedAt": NOW, "decidedBy": "dodo", "schemaVersion": 1,
    }


def run_operation(root, *, op_id="op-t-001", prop_id="prop-t-001", kind="sync",
                  plan=None, records=None, crash_at=None, hook=None):
    """完整执行一个 operation。

    crash_at："before-segment"（segment 提交前中断）或 "segment-committed"
    （提交后中断）；发布阶段的中断用 hook=crash_hook(label) 注入。
    锁的陈旧接管路径由 test_writer_lock 单独覆盖，此处崩溃后释放锁。
    """
    plan = sync_plan() if plan is None else plan
    records = sample_records() if records is None else records
    if kind == "maintain":
        target_source = target_revision = candidate = None
    else:
        target_source, target_revision = "requirements-xlsx", "rev-new01"
        candidate = target_revision
    proposal = engine.build_proposal(
        root, proposal_id=prop_id, proposal_kind=kind,
        candidate_revision=candidate,
        affected_files=[entry["path"] for entry in plan])
    handle = writer_lock.acquire(root, op_id)
    try:
        engine.create_operation(
            root, proposal, operation_id=op_id, operation_kind=kind, plan=plan,
            target_source=target_source, target_revision=target_revision)
        if crash_at == "before-segment":
            raise SimulatedCrash("before-segment")
        engine.commit_segment(root, op_id, records)
        if crash_at == "segment-committed":
            raise SimulatedCrash("segment-committed")
        engine.validate_operation(root, op_id)
        engine.publish(root, op_id, hook=hook)
    finally:
        handle.release()
    return proposal


_SNAPSHOT_EXCLUDED = (
    "_source/reconciliation/writer.lock",
    "_source/reconciliation/tombstones",
)


def snapshot(root):
    """全树字节快照（排除锁与 tombstone 元数据）。"""
    result = {}
    for path in sorted(Path(root).rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(rel == prefix or rel.startswith(prefix + "/")
               for prefix in _SNAPSHOT_EXCLUDED):
            continue
        result[rel] = path.read_bytes()
    return result
