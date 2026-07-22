"""只读同步与 rebaseline（技术设计 §3.4/§3.5/§8.2；ADR-0004 §2/§3/§6）。

- `sync_source(root, source_id, input_path, *, fingerprint_columns=None)`：
  只读同步。规范化输入生成不可变 revision（或 no-op），推进 observed/pending
  游标，绝不修改 PRD 主本、绝不推进 appliedRevision、绝不改变生命周期。判重
  以规范化记录内容为准（另存不改内容 → no-op）；`fingerprint_columns` 与
  appliedRevision 的规范化契约摘要不一致时抛 `RebaselineRequired`。
- `rebaseline(root, source_id, *, fingerprint_columns)`：§8.2 六步。从旧
  appliedRevision 的同一原始文件用新规范化规则重建不可变 baseline revision，
  按 locator crosswalk 继承既有映射（`basis: normalization-rebaseline`），经
  operation_engine 提交 rebaseline operation 后把 appliedRevision 推进到新
  baseline。仅因规则变化产生的差异归类为基线重建，不呈现为业务变更。

规范化器（`normalize` 及其辅助）是 migration 与 sync 共用的单一实现：
normalized.jsonl 只保存观测（不含 requirementId），`recordKey` 仅由业务列
规范化内容计算，行号只进 locator、不参与身份。仅使用 Python 标准库。
"""

from __future__ import annotations

import json
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from . import journal_projector, writer_lock
from . import operation_engine as engine
from .canonical_store import (
    atomic_write_bytes,
    atomic_write_json,
    canonical_json_bytes,
    digest_of,
    file_digest,
    read_json,
    sha256_of_bytes,
)

SYNC_STATE_RELPATH = "_source/sync-state.json"
REGISTRY_RELPATH = "_source/source-registry.json"

# 规范化契约版本与固定策略（技术设计 §3.5）。
NORMALIZED_SCHEMA_VERSION = 1
NORMALIZER_VERSION = "1.0.0"
DEFAULT_FINGERPRINT_COLUMNS = ["module", "requirement-text"]
_STRATEGY = {
    "unicode": "NFC",
    "whitespace": "collapse",
    "dates": "iso-from-serial",
    "formulas": "computed-value",
    "mergedCells": "backfill",
    "trailingEmpty": "strip",
}
# xlsx 表头（业务语言）到 kebab-case 逻辑列名的适配器映射。
_HEADER_TO_LOGICAL = {
    "序号": "sequence",
    "模块": "module",
    "需求点": "requirement-text",
}
_PRIMARY_TEXT_COLUMN = "requirement-text"

# 规范化产物与合成裁决使用固定时点，保证确定性（不依赖 wall-clock）。
_IMPORTED_AT = "2026-07-21T00:00:00+08:00"
_DECIDED_AT = "2026-07-21T00:00:00+08:00"
_DECIDED_BY = "prd-from-requirements"
_GENERATOR_VERSION = "1.0.0"

_NORMALIZED_FIELDS = (
    "sourceOccurrenceId", "recordKey", "duplicateOrdinal", "locator", "normalizedText")

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS = {"m": _MAIN_NS, "pr": _PKG_REL_NS, "or": _OFFICE_REL_NS}


class RebaselineRequired(Exception):
    """候选 fingerprint 配置与 appliedRevision 的规范化契约摘要不一致：
    拒绝直接 diff，必须先 rebaseline（技术设计 §8.2 第 1 步）。"""

    def __init__(self, source_id, applied_digest, candidate_digest):
        self.source_id = source_id
        self.applied_digest = applied_digest
        self.candidate_digest = candidate_digest
        super().__init__(
            f"{source_id}: effectiveNormalizationDigest changed "
            f"({applied_digest} -> {candidate_digest}); rebaseline required")


class SourceNotInitialized(Exception):
    """对未迁移的 legacy 工作树（无 sync-state 或该源未注册）调用同步：
    完备性不变式要求先迁移，绝不以 KeyError/TypeError 裸奔。"""

    def __init__(self, source_id):
        self.source_id = source_id
        super().__init__(f"{source_id}: worktree not migrated / source not registered")


class SourceRetired(Exception):
    """源已退休：唯一语义是不再接受新 revision（ADR-0004 §3.6）。"""

    def __init__(self, source_id):
        self.source_id = source_id
        super().__init__(f"{source_id}: source is retired; no new revision accepted")


# ---------------------------------------------------------------- xlsx 读取

def _col_letters(cell_ref: str) -> str:
    match = re.match(r"[A-Z]+", cell_ref)
    return match.group(0) if match else ""


def _shared_strings(archive: zipfile.ZipFile):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in si.findall(".//m:t", _NS))
            for si in root.findall("m:si", _NS)]


def _read_data_rows(workbook_path: Path):
    """按工作表出现顺序返回数据行列表：{locator, columns, sequence}。

    表头行以 `_HEADER_TO_LOGICAL` 识别（须同时含 module 与 requirement-text
    列）；其后有非空 requirement-text 的行为数据行（trailingEmpty 策略：
    空正文行不计入）。无序号行照常进入（序号列缺省为空串）。
    """
    result = []
    with zipfile.ZipFile(workbook_path) as archive:
        strings = _shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.attrib["Id"]: rel.attrib["Target"]
                   for rel in rels.findall("pr:Relationship", _NS)}
        rid_key = f"{{{_OFFICE_REL_NS}}}id"
        for sheet in workbook.findall("m:sheets/m:sheet", _NS):
            name = sheet.attrib.get("name", "")
            rid = sheet.attrib.get(rid_key)
            if rid not in targets:
                continue
            target = targets[rid].lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            sheet_root = ET.fromstring(archive.read(path))
            _extract_sheet(result, name, sheet_root, strings)
    return result


def _extract_sheet(result, sheet_name, sheet_root, strings):
    col_to_logical = None
    for row in sheet_root.findall(".//m:sheetData/m:row", _NS):
        try:
            row_num = int(row.attrib.get("r", "0") or 0)
        except ValueError:
            row_num = 0
        cells = {}
        for cell in row.findall("m:c", _NS):
            col = _col_letters(cell.attrib.get("r", ""))
            value_node = cell.find("m:v", _NS)
            if value_node is None:
                continue
            raw = value_node.text or ""
            if cell.attrib.get("t") == "s":
                try:
                    raw = strings[int(raw)]
                except (ValueError, IndexError):
                    pass
            cells[col] = raw

        if col_to_logical is None:
            mapping = {col: _HEADER_TO_LOGICAL[value.strip()]
                       for col, value in cells.items()
                       if value.strip() in _HEADER_TO_LOGICAL}
            logicals = set(mapping.values())
            if {"module", _PRIMARY_TEXT_COLUMN} <= logicals:
                col_to_logical = mapping
            continue

        columns = {logical: cells[col]
                   for col, logical in col_to_logical.items() if col in cells}
        if not columns.get(_PRIMARY_TEXT_COLUMN, "").strip():
            continue
        result.append({
            "locator": {"sheet": sheet_name, "row": row_num},
            "columns": columns,
            "sequence": columns.get("sequence", "").strip(),
        })


# ---------------------------------------------------------------- 规范化

def _normalize_value(value: str) -> str:
    """Unicode NFC + 空白折叠（技术设计 §3.5 strategy）。"""
    text = unicodedata.normalize("NFC", str(value))
    return " ".join(text.split())


def _record_key(columns: dict, fingerprint_columns) -> str:
    payload = {col: columns.get(col, "") for col in fingerprint_columns}
    return sha256_of_bytes(canonical_json_bytes(payload))


def _content_payload(records):
    """revision 无关的规范化内容（排除带 revisionId 的 occurrence ID）。"""
    return [{"recordKey": r["recordKey"], "duplicateOrdinal": r["duplicateOrdinal"],
             "locator": r["locator"], "normalizedText": r["normalizedText"]}
            for r in records]


def normalized_content_digest(records) -> str:
    return sha256_of_bytes(canonical_json_bytes(_content_payload(records)))


def _revision_id(records) -> str:
    """revisionId 由规范化内容派生：内容一致 → 同一 revision（no-op 判重的
    基础）；fingerprint 变化改变 recordKey → 新 revision（rebaseline）。"""
    return "rev-" + normalized_content_digest(records).split(":", 1)[1][:12]


def normalize_records(workbook_path, source_id, fingerprint_columns=None):
    """同 `normalize`，但每条 record 额外带一份 `columns`（规范化后的业务列）。

    `columns` 不进入不可变 revision（不影响 recordKey/revisionId/序列化），仅供
    归并阶段按模块等业务列定位；`normalize` 返回前会剥离它。"""
    fingerprint_columns = list(fingerprint_columns or DEFAULT_FINGERPRINT_COLUMNS)
    records = []
    ordinals = {}
    for row in _read_data_rows(Path(workbook_path)):
        columns = {logical: _normalize_value(value)
                   for logical, value in row["columns"].items()}
        record_key = _record_key(columns, fingerprint_columns)
        ordinal = ordinals.get(record_key, 0)
        ordinals[record_key] = ordinal + 1
        records.append({
            "recordKey": record_key,
            "duplicateOrdinal": ordinal,
            "locator": row["locator"],
            "normalizedText": columns.get(_PRIMARY_TEXT_COLUMN, ""),
            "columns": columns,
        })
    revision_id = _revision_id(records)
    for record in records:
        hex_key = record["recordKey"].split(":", 1)[1][:12]
        record["sourceOccurrenceId"] = (
            f"{source_id}@{revision_id}/occ-{hex_key}.{record['duplicateOrdinal']}")
    return revision_id, records, fingerprint_columns


def normalize(workbook_path, source_id, fingerprint_columns=None):
    """把 xlsx 规范化为不可变观测记录。返回 (revision_id, records,
    fingerprint_columns)。每条 record 含 sourceOccurrenceId、recordKey、
    duplicateOrdinal、locator、normalizedText，不含 requirementId。"""
    revision_id, records, fingerprint_columns = normalize_records(
        workbook_path, source_id, fingerprint_columns)
    for record in records:
        record.pop("columns", None)
    return revision_id, records, fingerprint_columns


def columns_by_occurrence(root, source_id, revision_id):
    """重放某 revision 的原始文件，返回 {sourceOccurrenceId: 规范化业务列}。

    归并阶段用来按模块等业务列定位 occurrence（normalized.jsonl 只存身份指纹，
    不存原始列）；occurrence ID 由内容确定性派生，重放结果与落盘 revision 一致。"""
    rev_dir = revision_dir(root, source_id, revision_id)
    manifest = read_json(rev_dir / "revision-manifest.json")
    norm_manifest = read_json(rev_dir / "normalization-manifest.json")
    workbook = rev_dir / manifest["originalFileName"]
    _, records, _ = normalize_records(
        workbook, source_id, norm_manifest["fingerprintColumns"])
    return {record["sourceOccurrenceId"]: record["columns"] for record in records}


# ---------------------------------------------------------------- 契约摘要

def adapter_config_digest() -> str:
    return digest_of({"columnMap": _HEADER_TO_LOGICAL,
                      "normalizerVersion": NORMALIZER_VERSION})


def effective_normalization_digest(fingerprint_columns) -> str:
    """§3.5：canonical hash(normalizedSchemaVersion + adapterConfigDigest +
    fingerprintColumns + strategy)。任一分量变化即触发 rebaseline。"""
    return digest_of({
        "normalizedSchemaVersion": NORMALIZED_SCHEMA_VERSION,
        "adapterConfigDigest": adapter_config_digest(),
        "fingerprintColumns": list(fingerprint_columns),
        "strategy": _STRATEGY,
    })


def build_revision_manifest(revision_id, source_id, workbook_path, records) -> dict:
    workbook_path = Path(workbook_path)
    return {
        "revisionId": revision_id,
        "sourceId": source_id,
        "originalFileName": workbook_path.name,
        "originalContentDigest": file_digest(workbook_path),
        "normalizedDigest": normalized_content_digest(records),
        "recordCount": len(records),
        "importedAt": _IMPORTED_AT,
        "schemaVersion": 1,
    }


def build_normalization_manifest(fingerprint_columns) -> dict:
    fingerprint_columns = list(fingerprint_columns)
    return {
        "normalizedSchemaVersion": NORMALIZED_SCHEMA_VERSION,
        "normalizerVersion": NORMALIZER_VERSION,
        "adapterConfigDigest": adapter_config_digest(),
        "fingerprintColumns": fingerprint_columns,
        "strategy": dict(_STRATEGY),
        "effectiveNormalizationDigest": effective_normalization_digest(fingerprint_columns),
        "schemaVersion": 1,
    }


def serialize_normalized(records) -> bytes:
    """固定字段序的 JSONL（UTF-8、LF）。"""
    lines = []
    for record in records:
        ordered = {key: record[key] for key in _NORMALIZED_FIELDS}
        lines.append(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n").encode("utf-8")


# ---------------------------------------------------------------- revision 存取

def revision_dir(root, source_id, revision_id) -> Path:
    return Path(root) / "_source/revisions" / source_id / revision_id


def revision_reldir(source_id, revision_id) -> str:
    return f"_source/revisions/{source_id}/{revision_id}"


def load_normalized(root, source_id, revision_id):
    text = (revision_dir(root, source_id, revision_id) / "normalized.jsonl").read_text(
        encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def revision_files_plan(source_id, revision_id, workbook_path, records,
                        fingerprint_columns):
    """revision 目录的写入动作全集：原始文件副本 + normalized.jsonl + 两套
    manifest。migration 与 rebaseline 共用（经 operation_engine 发布）。"""
    workbook_path = Path(workbook_path)
    rel = revision_reldir(source_id, revision_id)
    return [
        {"path": f"{rel}/{workbook_path.name}", "action": "write",
         "content": workbook_path.read_bytes()},
        {"path": f"{rel}/normalized.jsonl", "action": "write",
         "content": serialize_normalized(records)},
        {"path": f"{rel}/revision-manifest.json", "action": "write",
         "content": canonical_json_bytes(build_revision_manifest(
             revision_id, source_id, workbook_path, records))},
        {"path": f"{rel}/normalization-manifest.json", "action": "write",
         "content": canonical_json_bytes(build_normalization_manifest(fingerprint_columns))},
    ]


def _write_revision(root, source_id, revision_id, workbook_path, records,
                    fingerprint_columns):
    """只读同步直接落盘不可变 revision（不经 operation：不触碰主本与 applied）。"""
    for entry in revision_files_plan(source_id, revision_id, workbook_path, records,
                                     fingerprint_columns):
        atomic_write_bytes(Path(root) / entry["path"], entry["content"])


# ---------------------------------------------------------------- raw diff

def _raw_diff(old_records, new_records) -> dict:
    """按 (recordKey, duplicateOrdinal) 比对：新增/消失记录列表与未变计数。"""
    def index(records):
        return {(r["recordKey"], r["duplicateOrdinal"]): r for r in records}

    old_index = index(old_records)
    new_index = index(new_records)
    added = [new_index[key] for key in new_index if key not in old_index]
    removed = [old_index[key] for key in old_index if key not in new_index]
    unchanged = sum(1 for key in new_index if key in old_index)
    return {"added": added, "removed": removed, "unchangedCount": unchanged}


# ---------------------------------------------------------------- 只读同步

def _applied_normalization_manifest(root, source_id, applied_revision):
    return read_json(revision_dir(root, source_id, applied_revision)
                     / "normalization-manifest.json")


def _require_initialized(root, source_id):
    """未迁移工作树 / 未注册源一律显式失败，绝不裸奔 KeyError。"""
    state_path = root / SYNC_STATE_RELPATH
    if not state_path.exists():
        raise SourceNotInitialized(source_id)
    state = read_json(state_path)
    cursors = state.get("sources", {}).get(source_id)
    if not isinstance(cursors, dict) or "appliedRevision" not in cursors:
        raise SourceNotInitialized(source_id)
    return state, cursors


def _require_not_retired(root, source_id):
    registry_path = root / REGISTRY_RELPATH
    if not registry_path.exists():
        return
    registry = read_json(registry_path)
    entry = next((s for s in registry.get("sources", [])
                  if s.get("sourceId") == source_id), None)
    if entry is not None and entry.get("status") == "retired":
        raise SourceRetired(source_id)


def sync_source(root, source_id, input_path, *, fingerprint_columns=None) -> dict:
    """只读同步一个源。见模块 docstring 的契约。"""
    root = Path(root)
    input_path = Path(input_path)

    state, cursors = _require_initialized(root, source_id)
    _require_not_retired(root, source_id)
    applied = cursors["appliedRevision"]
    applied_norm = _applied_normalization_manifest(root, source_id, applied)

    if fingerprint_columns is not None:
        columns = list(fingerprint_columns)
    else:
        columns = list(applied_norm["fingerprintColumns"])

    # 规范化契约不一致的只读拒绝，无需持锁（不写任何状态）。
    candidate_digest = effective_normalization_digest(columns)
    if candidate_digest != applied_norm["effectiveNormalizationDigest"]:
        raise RebaselineRequired(source_id, applied_norm["effectiveNormalizationDigest"],
                                 candidate_digest)

    # 游标推进与 revision 落盘必须在 writer lock 内（§2.2 锁内 compare-and-write）；
    # 他人持锁时 acquire 抛 LockHeld。
    handle = writer_lock.acquire(root, "op-sync-readonly")
    try:
        state = read_json(root / SYNC_STATE_RELPATH)
        cursors = state["sources"][source_id]
        applied = cursors["appliedRevision"]

        revision_id, records, columns = normalize(input_path, source_id, columns)
        if revision_id == applied:
            return {"noOp": True, "revisionId": applied}

        _write_revision(root, source_id, revision_id, input_path, records, columns)
        diff = _raw_diff(load_normalized(root, source_id, applied), records)

        # 只读同步只推进 observed/pending；appliedRevision、主本与生命周期不动。
        cursors["observedRevision"] = revision_id
        cursors["pendingRevision"] = revision_id
        atomic_write_json(root / SYNC_STATE_RELPATH, state)
    finally:
        handle.release()

    return {"noOp": False, "revisionId": revision_id, "rawDiff": diff}


# ---------------------------------------------------------------- rebaseline

def _loc_key(locator) -> tuple:
    return (locator["sheet"], locator["row"])


def _rebaseline_journal(records, old_records, projection):
    """crosswalk：新 occurrence 按 locator 对齐旧 occurrence，继承其 requirementId。

    同一原始文件 → locator 一一对应，身份 1:1 继承（技术设计 §8.2 第 3 步）。
    """
    old_occ_by_loc = {_loc_key(r["locator"]): r["sourceOccurrenceId"] for r in old_records}
    journal = []
    for index, record in enumerate(records, start=1):
        old_occ = old_occ_by_loc[_loc_key(record["locator"])]
        requirement_id = projection["mappings"][old_occ]["requirementId"]
        journal.append({
            "decisionId": f"MAP-rebase-{index:04d}",
            "action": "map",
            "sourceOccurrenceId": record["sourceOccurrenceId"],
            "requirementId": requirement_id,
            "assertionRole": "normative",
            "basis": "normalization-rebaseline",
            "confidence": "machine",
            "decidedAt": _DECIDED_AT,
            "decidedBy": _DECIDED_BY,
            "supersedes": None,
            "schemaVersion": 1,
        })
    return journal


def rebaseline(root, source_id, *, fingerprint_columns) -> dict:
    """§8.2 基线重建。返回至少含 `revisionId`。"""
    root = Path(root)
    state = read_json(root / SYNC_STATE_RELPATH)
    cursors = state["sources"][source_id]
    old_revision = cursors["appliedRevision"]
    old_dir = revision_dir(root, source_id, old_revision)
    old_manifest = read_json(old_dir / "revision-manifest.json")
    workbook_path = old_dir / old_manifest["originalFileName"]

    columns = list(fingerprint_columns)
    new_revision, records, columns = normalize(workbook_path, source_id, columns)

    old_records = load_normalized(root, source_id, old_revision)
    projection = journal_projector.project(root)
    journal = _rebaseline_journal(records, old_records, projection)

    # 暂存 sync-state：observed/pending 指向新 baseline；appliedRevision 保持旧值,
    # 由 operation 唯一提交点推进（见 operation_engine._advance_commit_point）。
    new_state = read_json(root / SYNC_STATE_RELPATH)
    new_cursors = new_state["sources"][source_id]
    new_cursors["observedRevision"] = new_revision
    new_cursors["pendingRevision"] = new_revision

    plan = [{"path": SYNC_STATE_RELPATH, "action": "write",
             "content": canonical_json_bytes(new_state)}]
    plan.extend(revision_files_plan(source_id, new_revision, workbook_path, records, columns))

    proposal_mappings = [{
        "sourceOccurrenceId": record["sourceOccurrenceId"],
        "requirementId": entry["requirementId"],
        "classification": "unchanged",
        "confidence": "auto",
    } for record, entry in zip(records, journal)]

    operation_id = "op-rebaseline"
    proposal = engine.build_proposal(
        root, proposal_id="prop-rebaseline", proposal_kind="rebaseline",
        candidate_revision=new_revision, mappings=proposal_mappings,
        affected_files=[entry["path"] for entry in plan],
        generator_version=_GENERATOR_VERSION)

    handle = writer_lock.acquire(root, operation_id)
    try:
        engine.create_operation(
            root, proposal, operation_id=operation_id, operation_kind="rebaseline",
            plan=plan, target_source=source_id, target_revision=new_revision)
        engine.commit_segment(root, operation_id, journal)
        engine.validate_operation(root, operation_id)
        engine.publish(root, operation_id)
    finally:
        handle.release()

    return {"revisionId": new_revision, "operation": engine.load_manifest(root, operation_id)}
