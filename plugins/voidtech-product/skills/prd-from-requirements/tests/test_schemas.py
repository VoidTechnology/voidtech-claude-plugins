"""八套权威机器文件 schema 的正反例校验（技术设计 §11 门 1「schema 反例」）。"""

import copy
import sys
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from prdsync.schema_validator import check, load_schema  # noqa: E402

SCHEMAS_DIR = SKILL_ROOT / "schemas"

DIGEST = "sha256:" + "ab" * 32
DIGEST2 = "sha256:" + "cd" * 32
NOW = "2026-07-21T10:00:00+08:00"
OCC = "requirements-xlsx@rev-c261ab57/occ-8f91.0"

VALID = {
    "prd-worktree": {
        "worktreeSchemaVersion": 1,
        "capabilities": {"sourceSync": False, "logicAtlas": False},
        "logicAtlasStage": None,
        "schemaVersions": {"operation": 1, "proposal": 1, "journal": 1, "normalization": 1, "logicModel": None},
    },
    "source-registry": {
        "sources": [
            {"sourceId": "requirements-xlsx", "kind": "workbook", "mode": "versioned",
             "defaultAssertionRole": "normative", "status": "active"},
            {"sourceId": "interview-20260701", "kind": "interview-notes", "mode": "immutable",
             "defaultAssertionRole": "contextual", "status": "retired"},
            {"sourceId": "email-changes", "kind": "change-stream", "mode": "append-only",
             "defaultAssertionRole": "normative", "status": "active"},
        ],
        "schemaVersion": 1,
    },
    "sync-state": {
        "sources": {
            "requirements-xlsx": {"observedRevision": "rev-20260720-a81f",
                                  "appliedRevision": "rev-20260717-c261",
                                  "pendingRevision": "rev-20260720-a81f"},
            "interview-20260701": {"observedRevision": "rev-initial-22ad",
                                   "appliedRevision": "rev-initial-22ad",
                                   "pendingRevision": None},
            "email-changes": {"lastAppliedChangeId": "CHG-20260718-003"},
        },
        "schemaVersion": 1,
    },
    "revision-manifest": {
        "revisionId": "rev-20260721-a81f",
        "sourceId": "requirements-xlsx",
        "originalFileName": "requirements.xlsx",
        "originalContentDigest": DIGEST,
        "normalizedDigest": DIGEST2,
        "recordCount": 563,
        "importedAt": NOW,
        "schemaVersion": 1,
    },
    "normalization-manifest": {
        "normalizedSchemaVersion": 1,
        "normalizerVersion": "1.0.0",
        "adapterConfigDigest": DIGEST,
        "fingerprintColumns": ["module", "requirement-text"],
        "strategy": {"unicode": "NFC", "whitespace": "collapse", "dates": "iso-from-serial",
                     "formulas": "computed-value", "mergedCells": "backfill", "trailingEmpty": "strip"},
        "effectiveNormalizationDigest": DIGEST2,
        "schemaVersion": 1,
    },
    "proposal": {
        "proposalId": "prop-20260721-001",
        "proposalKind": "sync",
        "status": "open",
        "operationBaseDigest": DIGEST,
        "candidateRevision": "rev-20260721-a81f",
        "mappings": [
            {"sourceOccurrenceId": OCC, "requirementId": "REQ-200",
             "classification": "source-backfill", "confidence": "auto"},
            {"sourceOccurrenceId": OCC, "requirementId": None,
             "classification": "new", "confidence": "high"},
        ],
        "ambiguities": [
            {"kind": "duplicate", "detail": "same recordKey twice in sheet membership",
             "occurrences": [OCC], "candidateRequirementIds": ["REQ-200"]},
        ],
        "lifecycleActions": [
            {"requirementId": "REQ-200", "scopeId": "requirement", "lifecycleAction": "withdraw",
             "effectiveAt": NOW, "replacementRequirementId": None},
        ],
        "affectedFiles": ["00-global/requirement-traceability-matrix.md"],
        "proposalDigest": DIGEST2,
        "generatorVersion": "1.0.0",
        "schemaVersion": 1,
    },
    "operation": {
        "operationId": "op-20260721-001",
        "operationKind": "sync",
        "phase": "prepared",
        "commitPoint": "appliedRevision",
        "operationBaseDigest": DIGEST,
        "proposalId": "prop-20260721-001",
        "proposalDigest": DIGEST2,
        "segmentPath": "_source/reconciliation/decisions/000123-op-20260721-001.jsonl",
        "targetSource": "requirements-xlsx",
        "targetRevision": "rev-20260721-a81f",
        "files": [
            {"path": "00-global/requirement-traceability-matrix.md", "action": "write",
             "oldDigest": DIGEST, "newDigest": DIGEST2,
             "stagedPath": "_source/reconciliation/operations/op-20260721-001/staging/00-global/requirement-traceability-matrix.md",
             "backupPath": "_source/reconciliation/operations/op-20260721-001/backup/00-global/requirement-traceability-matrix.md"},
            {"path": "_generated/requirements-ledger.jsonl", "action": "write",
             "oldDigest": None, "newDigest": DIGEST,
             "stagedPath": "_source/reconciliation/operations/op-20260721-001/staging/_generated/requirements-ledger.jsonl",
             "backupPath": None},
            {"path": "01-portal/09-legacy-module/prd.md", "action": "delete",
             "oldDigest": DIGEST, "newDigest": None, "stagedPath": None,
             "backupPath": "_source/reconciliation/operations/op-20260721-001/backup/01-portal/09-legacy-module/prd.md"},
        ],
        "toolVersions": {"normalizer": "1.0.0", "generator": "1.0.0"},
        "schemaVersion": 1,
    },
}

VALID_MAINTAIN_OPERATION = {
    **VALID["operation"],
    "operationId": "op-20260721-002",
    "operationKind": "maintain",
    "commitPoint": "operationState",
    "segmentPath": "_source/reconciliation/decisions/000124-op-20260721-002.jsonl",
    "targetSource": None,
    "targetRevision": None,
}

VALID_JOURNAL_RECORDS = [
    {"decisionId": "MAP-20260717-001", "action": "map", "sourceOccurrenceId": OCC,
     "requirementId": "REQ-200", "assertionRole": "normative", "basis": "manual-confirmation",
     "confidence": "confirmed", "decidedAt": NOW, "decidedBy": "dodo", "supersedes": None,
     "schemaVersion": 1},
    {"decisionId": "CTL-20260717-001", "action": "set-lifecycle-controller",
     "requirementId": "REQ-200", "scopeId": "requirement", "controllerSourceId": "requirements-xlsx",
     "decidedAt": NOW, "decidedBy": "dodo", "schemaVersion": 1},
    {"decisionId": "TRN-20260720-001", "transitionId": "TRN-20260720-001", "action": "transition",
     "requirementId": "REQ-200", "from": "active", "to": "withdrawn", "lifecycleAction": "withdraw",
     "effectiveAt": NOW, "decisionSource": "CHG-20260719-002", "decidedAt": NOW, "decidedBy": "dodo",
     "schemaVersion": 1},
]


def mutate(base, **changes):
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if value is ...:
            out.pop(key, None)
        else:
            out[key] = value
    return out


class SchemaExamplesTest(unittest.TestCase):
    def schema(self, name):
        return load_schema(SCHEMAS_DIR, name)

    def assert_valid(self, name, value):
        errors = check(value, self.schema(name))
        self.assertEqual(errors, [], f"{name}: expected valid, got {errors}")

    def assert_invalid(self, name, value, label):
        errors = check(value, self.schema(name))
        self.assertTrue(errors, f"{name}: counterexample not rejected: {label}")

    def test_positive_examples(self):
        for name, value in VALID.items():
            with self.subTest(schema=name):
                self.assert_valid(name, value)

    def test_maintain_operation_valid(self):
        self.assert_valid("operation", VALID_MAINTAIN_OPERATION)

    def test_journal_records_valid(self):
        for record in VALID_JOURNAL_RECORDS:
            with self.subTest(action=record["action"]):
                self.assert_valid("journal-record", record)

    def test_additional_property_rejected_everywhere(self):
        for name, value in VALID.items():
            with self.subTest(schema=name):
                self.assert_invalid(name, mutate(value, unexpectedField=1), "extra top-level field")
        self.assert_invalid("journal-record",
                            mutate(VALID_JOURNAL_RECORDS[0], unexpectedField=1),
                            "extra field on journal record")

    def test_worktree_bad_stage(self):
        self.assert_invalid("prd-worktree", mutate(VALID["prd-worktree"], logicAtlasStage="pdf"), "unknown stage")

    def test_worktree_capability_stage_consistency(self):
        enabled = copy.deepcopy(VALID["prd-worktree"])
        enabled["capabilities"]["logicAtlas"] = True
        enabled["logicAtlasStage"] = "markdown"
        self.assert_valid("prd-worktree", enabled)

        stage_missing = copy.deepcopy(enabled)
        stage_missing["logicAtlasStage"] = None
        self.assert_invalid("prd-worktree", stage_missing, "logicAtlas on without stage")

        stage_orphan = copy.deepcopy(VALID["prd-worktree"])
        stage_orphan["logicAtlasStage"] = "markdown"
        self.assert_invalid("prd-worktree", stage_orphan, "stage set while logicAtlas off")

    def test_registry_overriding_not_a_default_role(self):
        bad = copy.deepcopy(VALID["source-registry"])
        bad["sources"][0]["defaultAssertionRole"] = "overriding"
        self.assert_invalid("source-registry", bad, "overriding as default role")

    def test_sync_state_mixed_cursor_rejected(self):
        bad = copy.deepcopy(VALID["sync-state"])
        bad["sources"]["requirements-xlsx"]["lastAppliedChangeId"] = "CHG-1"
        self.assert_invalid("sync-state", bad, "cursor matching both shapes must fail oneOf")

    def test_sync_state_bad_source_key(self):
        bad = copy.deepcopy(VALID["sync-state"])
        bad["sources"]["Bad_Source"] = {"lastAppliedChangeId": None}
        self.assert_invalid("sync-state", bad, "sourceId charset violation")

    def test_revision_manifest_bad_digest(self):
        self.assert_invalid("revision-manifest",
                            mutate(VALID["revision-manifest"], normalizedDigest="sha256:short"),
                            "malformed digest")

    def test_normalization_manifest_missing_strategy_key(self):
        bad = copy.deepcopy(VALID["normalization-manifest"])
        del bad["strategy"]["mergedCells"]
        self.assert_invalid("normalization-manifest", bad, "strategy key missing")

    def test_proposal_path_traversal_rejected(self):
        self.assert_invalid("proposal",
                            mutate(VALID["proposal"], affectedFiles=["../outside.md"]),
                            "path traversal in affectedFiles")
        self.assert_invalid("proposal",
                            mutate(VALID["proposal"], affectedFiles=["/etc/passwd"]),
                            "absolute path in affectedFiles")
        self.assert_invalid("proposal",
                            mutate(VALID["proposal"], affectedFiles=["a\\b.md"]),
                            "backslash in affectedFiles")

    def test_unicode_paths_accepted(self):
        # 真实工作树的原件路径含中文（如 需求.xlsx），路径契约必须放行。
        self.assert_valid("proposal", mutate(
            VALID["proposal"],
            affectedFiles=["_source/revisions/requirements-xlsx/rev-a1/需求.xlsx"]))
        op = copy.deepcopy(VALID["operation"])
        op["files"][1]["path"] = "_generated/需求账本.jsonl"
        op["files"][1]["stagedPath"] = (
            "_source/reconciliation/operations/op-20260721-001/staging/_generated/需求账本.jsonl")
        self.assert_valid("operation", op)

    def test_proposal_bad_status(self):
        self.assert_invalid("proposal", mutate(VALID["proposal"], status="draft"), "unknown status")

    def test_operation_maintain_with_target_rejected(self):
        self.assert_invalid("operation",
                            mutate(VALID_MAINTAIN_OPERATION, targetSource="requirements-xlsx"),
                            "maintain must not carry targetSource")
        self.assert_invalid("operation",
                            mutate(VALID_MAINTAIN_OPERATION, commitPoint="appliedRevision"),
                            "maintain commit point must be operationState")

    def test_operation_sync_without_target_rejected(self):
        self.assert_invalid("operation",
                            mutate(VALID["operation"], targetRevision=None),
                            "sync must carry targetRevision")

    def test_operation_delete_with_staged_path_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][2]["stagedPath"] = bad["files"][0]["stagedPath"]
        self.assert_invalid("operation", bad, "delete entry must not carry stagedPath")

    def test_operation_create_with_backup_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][1]["backupPath"] = bad["files"][0]["backupPath"]
        self.assert_invalid("operation", bad, "create entry must not carry backupPath")

    def test_operation_target_inside_reconciliation_rejected(self):
        bad = copy.deepcopy(VALID["operation"])
        bad["files"][0]["path"] = "_source/reconciliation/decisions/000001-op-x.jsonl"
        self.assert_invalid("operation", bad, "publish target must not be inside reconciliation area")

    def test_journal_overriding_requires_reference(self):
        overriding = mutate(VALID_JOURNAL_RECORDS[0],
                            assertionRole="overriding",
                            overridesDecisionIds=["MAP-20260601-004"])
        self.assert_valid("journal-record", overriding)
        self.assert_invalid("journal-record",
                            mutate(overriding, overridesDecisionIds=...),
                            "overriding without overridesDecisionIds")
        self.assert_invalid("journal-record",
                            mutate(VALID_JOURNAL_RECORDS[0], overridesDecisionIds=["MAP-20260601-004"]),
                            "non-overriding must not carry overridesDecisionIds")

    def test_journal_bad_confidence(self):
        self.assert_invalid("journal-record",
                            mutate(VALID_JOURNAL_RECORDS[0], confidence="sure"),
                            "unknown confidence")

    def test_journal_transition_bad_state(self):
        self.assert_invalid("journal-record",
                            mutate(VALID_JOURNAL_RECORDS[2], to="deleted"),
                            "unknown lifecycle state")

    def test_journal_controller_missing_scope(self):
        self.assert_invalid("journal-record",
                            mutate(VALID_JOURNAL_RECORDS[1], scopeId=...),
                            "controller record without scopeId")


if __name__ == "__main__":
    unittest.main()
