"""存量工作树迁移：只读分析 dry-run 与单一 migration operation 提交。

对应技术设计 §8.1、ADR-0004「分阶段落地·第一阶段」。

- `analyze(root)`：只读、确定性 dry-run。解析追溯矩阵（区间展开）与原始
  xlsx（序号行），产出自动序号映射候选、`xxx+a` 人工确认项与区间级追溯
  缺口。绝不写文件，绝不把无序号行伪造成自动候选。
- `commit_migration(root, confirmations)`：把 `_source/original/` 规范化为
  revision 0，经 operation_engine 提交**单一** migration operation（暂存
  发布协议不绕过）。人工项未全部确认时抛 MigrationBlocked，此时不建 operation、
  不写任何主本、revision 0 不 applied、`capabilities.sourceSync` 不置位——
  完备性不变式不为迁移豁免，无「部分 applied」。全部确认后一次性提交：
  revision 0 applied、能力开关置位、journal 对每条 occurrence 有生效裁决。

仅使用 Python 标准库。
"""

from __future__ import annotations

import hashlib
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from . import operation_engine as engine
from . import writer_lock
from .base_cas import MATRIX_RELPATH
from .canonical_store import canonical_json_bytes

SOURCE_ID = "requirements-xlsx"
REVISION_0 = "rev-0"
ORIGINAL_RELDIR = "_source/original"

# 迁移合成裁决的固定时点与主体：dry-run 与提交都不依赖 wall-clock，保证确定性。
_DECIDED_AT = "2026-07-21T00:00:00+08:00"
_DECIDED_BY = "prd-from-requirements"
_GENERATOR_VERSION = "1.0.0"

MANIFEST_RELPATH = "prd-worktree.json"
REGISTRY_RELPATH = "_source/source-registry.json"
SYNC_STATE_RELPATH = "_source/sync-state.json"
NORMALIZED_RELPATH = f"_source/revisions/{SOURCE_ID}/{REVISION_0}/normalized.jsonl"

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS = {"m": _MAIN_NS, "pr": _PKG_REL_NS, "or": _OFFICE_REL_NS}

# 矩阵表格首列的三种形态。
_MANUAL_RE = re.compile(r"^([A-Z][A-Z0-9]*)-(\d+)\+a$")
_RANGE_RE = re.compile(r"^([A-Z][A-Z0-9]*)-(\d+)\s*~\s*(?:[A-Z][A-Z0-9]*-)?(\d+)$")
_SINGLE_RE = re.compile(r"^([A-Z][A-Z0-9]*)-(\d+)$")
_SECTION_RE = re.compile(r"^##\s*[一二三四五六七八九十]+、\s*(.+?)\s*→")
_ROW_RE = re.compile(r"^\|(.+)\|\s*$")
_DEEPENED_RE = re.compile(r"已深化|行级")


class MigrationBlocked(Exception):
    """人工确认项未全部裁决：完备性不变式不为迁移豁免，禁止提交。"""

    def __init__(self, missing):
        self.missing = list(missing)
        super().__init__(f"unconfirmed manual items: {self.missing}")


# ---------------------------------------------------------------- 矩阵解析

def _split_row(line: str):
    match = _ROW_RE.match(line)
    if not match:
        return None
    return [cell.strip() for cell in match.group(1).split("|")]


def _pad_id(prefix: str, number: int) -> str:
    return f"{prefix}-{number:03d}"


def _parse_matrix(root: Path):
    """按文档顺序解析追溯矩阵，返回 (auto_rows, manual_rows)。

    覆盖率对账及其后的汇总表不参与身份解析（它们是校验用的计数，不是映射）。
    auto_rows 项：{prefix, ids, count, range, module, phase, sheet, deepened}。
    manual_rows 项：{itemKey, module, phase, sheet}。
    """
    text = (root / MATRIX_RELPATH).read_text(encoding="utf-8")
    auto_rows, manual_rows = [], []
    current_sheet = None
    for line in text.splitlines():
        if line.startswith("## 覆盖率对账"):
            break
        section = _SECTION_RE.match(line)
        if section:
            current_sheet = section.group(1)
            continue
        cells = _split_row(line)
        if not cells:
            continue
        first = cells[0]
        module = cells[2] if len(cells) > 2 else ""
        phase = cells[4] if len(cells) > 4 else ""

        manual = _MANUAL_RE.match(first)
        if manual:
            manual_rows.append({
                "itemKey": first,
                "module": module,
                "phase": phase,
                "sheet": current_sheet,
            })
            continue

        rng = _RANGE_RE.match(first)
        if rng:
            prefix, start, end = rng.group(1), int(rng.group(2)), int(rng.group(3))
            ids = [_pad_id(prefix, n) for n in range(start, end + 1)]
        else:
            single = _SINGLE_RE.match(first)
            if not single:
                continue  # 表头、分隔线或非映射行
            prefix = single.group(1)
            ids = [_pad_id(prefix, int(single.group(2)))]

        auto_rows.append({
            "prefix": prefix,
            "ids": ids,
            "count": len(ids),
            "range": first,
            "module": module,
            "phase": phase,
            "sheet": current_sheet,
            "deepened": bool(_DEEPENED_RE.search(module)),
        })
    return auto_rows, manual_rows


# ---------------------------------------------------------------- xlsx 读取

def _find_workbook(root: Path):
    originals = sorted((root / ORIGINAL_RELDIR).glob("*.xlsx"))
    return originals[0] if originals else None


def _col_letters(cell_ref: str) -> str:
    match = re.match(r"[A-Z]+", cell_ref)
    return match.group(0) if match else ""


def _shared_strings(archive: zipfile.ZipFile):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in si.findall(".//m:t", _NS))
            for si in root.findall("m:si", _NS)]


def _sheet_sequence_rows(root: Path):
    """返回 {sheet 名: [(rowRef, seqValue), ...]}——各 sheet 首列为数字序号的
    数据行，按工作表内出现顺序。无序号行不进入（对齐即身份确认的边界）。"""
    workbook_path = _find_workbook(root)
    if workbook_path is None:
        return {}
    result = {}
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
            rows = []
            for row in sheet_root.findall(".//m:sheetData/m:row", _NS):
                row_ref = row.attrib.get("r", "")
                for cell in row.findall("m:c", _NS):
                    ref = cell.attrib.get("r", "")
                    if _col_letters(ref) != "A":
                        continue
                    value_node = cell.find("m:v", _NS)
                    if value_node is None:
                        break
                    raw = value_node.text or ""
                    if cell.attrib.get("t") == "s":
                        try:
                            raw = strings[int(raw)]
                        except (ValueError, IndexError):
                            pass
                    raw = raw.strip()
                    if re.fullmatch(r"\d+", raw):
                        rows.append((row_ref or f"A?{raw}", raw))
                    break
            result[name] = rows
    return result


# ---------------------------------------------------------------- occurrence

def _occurrence_id(locator: str, requirement_key: str) -> str:
    digest = hashlib.sha256(
        f"{SOURCE_ID}\x00{locator}\x00{requirement_key}".encode("utf-8")
    ).hexdigest()[:12]
    return f"{SOURCE_ID}@{REVISION_0}/occ-{digest}.0"


def _build_auto_candidates(root: Path, auto_rows):
    """区间展开 × 原表序号行对齐：把矩阵各分组的序号 ID 逐一对齐到对应
    sheet 的序号行。sheet 缺失或行数不齐时退化为按 ID 定位（计数仍以矩阵为准），
    不因原表读取失败改变自动候选数量。"""
    sheet_rows = _sheet_sequence_rows(root)
    consumed = {}
    candidates = []
    for row in auto_rows:
        rows_for_sheet = sheet_rows.get(row["sheet"], [])
        for req_id in row["ids"]:
            index = consumed.get(row["sheet"], 0)
            if index < len(rows_for_sheet):
                row_ref, seq_value = rows_for_sheet[index]
                locator = f"{row['sheet']}!{row_ref}"
                aligned = {"sheet": row["sheet"], "row": row_ref, "seq": seq_value}
            else:
                locator = req_id
                aligned = {"sheet": row["sheet"], "row": None, "seq": None}
            consumed[row["sheet"]] = index + 1
            candidates.append({
                "requirementId": req_id,
                "sourceOccurrenceId": _occurrence_id(locator, req_id),
                "range": row["range"],
                "module": row["module"],
                "phase": row["phase"],
                **aligned,
            })
    return candidates


def _build_manual_items(manual_rows):
    items = []
    for row in manual_rows:
        items.append({
            "itemKey": row["itemKey"],
            "sourceOccurrenceId": _occurrence_id(f"manual!{row['itemKey']}", row["itemKey"]),
            "module": row["module"],
            "phase": row["phase"],
            "sheet": row["sheet"],
        })
    return items


def _build_gaps(auto_rows):
    """区间级追溯缺口：矩阵仅按序号区间聚合、未深化到行级的分组如实呈现，
    不伪造行级映射。已深化（行级）的分组不计入缺口。"""
    gaps = []
    for row in auto_rows:
        if row["deepened"]:
            continue
        gaps.append({
            "requirementRange": row["range"],
            "count": row["count"],
            "module": row["module"],
            "phase": row["phase"],
            "granularity": "interval-level",
        })
    return gaps


# ---------------------------------------------------------------- 公共接口

def analyze(root) -> dict:
    """只读 dry-run：返回 autoCandidates / manualItems / gaps。确定性、零写入。"""
    root = Path(root)
    auto_rows, manual_rows = _parse_matrix(root)
    return {
        "autoCandidates": _build_auto_candidates(root, auto_rows),
        "manualItems": _build_manual_items(manual_rows),
        "gaps": _build_gaps(auto_rows),
    }


def _plan_files(occurrences):
    """迁移 operation 的文件动作全集：一次性建立机器清单、注册表、同步游标与
    revision 0 规范化产物。sync-state 先写 pending，提交点再推进 applied。"""
    manifest = {
        "worktreeSchemaVersion": 1,
        "capabilities": {"sourceSync": True, "logicAtlas": False},
        "logicAtlasStage": None,
        "schemaVersions": {"operation": 1, "proposal": 1, "journal": 1,
                           "normalization": 1, "logicModel": None},
    }
    registry = {
        "sources": [{"sourceId": SOURCE_ID, "kind": "workbook", "mode": "versioned",
                     "defaultAssertionRole": "normative", "status": "active"}],
        "schemaVersion": 1,
    }
    sync_state = {
        "sources": {SOURCE_ID: {"observedRevision": REVISION_0,
                                "appliedRevision": None,
                                "pendingRevision": REVISION_0}},
        "schemaVersion": 1,
    }
    normalized_lines = []
    for occ in occurrences:
        normalized_lines.append(canonical_json_bytes({
            "occurrenceId": occ["sourceOccurrenceId"],
            "recordKey": "sha256:" + hashlib.sha256(
                occ["sourceOccurrenceId"].encode("utf-8")).hexdigest(),
            "requirementId": occ["requirementId"],
            "normalizedText": occ["normalizedText"],
        }).decode("utf-8").rstrip("\n"))
    normalized = ("\n".join(normalized_lines) + "\n").encode("utf-8")
    return [
        {"path": MANIFEST_RELPATH, "action": "write",
         "content": canonical_json_bytes(manifest)},
        {"path": REGISTRY_RELPATH, "action": "write",
         "content": canonical_json_bytes(registry)},
        {"path": SYNC_STATE_RELPATH, "action": "write",
         "content": canonical_json_bytes(sync_state)},
        {"path": NORMALIZED_RELPATH, "action": "write", "content": normalized},
    ]


def _journal_records(occurrences):
    records = []
    for index, occ in enumerate(occurrences, start=1):
        records.append({
            "decisionId": f"MAP-mig-{index:04d}",
            "action": "map",
            "sourceOccurrenceId": occ["sourceOccurrenceId"],
            "requirementId": occ["requirementId"],
            "assertionRole": "normative",
            "basis": occ["basis"],
            "confidence": occ["confidence"],
            "decidedAt": _DECIDED_AT,
            "decidedBy": _DECIDED_BY,
            "supersedes": None,
            "schemaVersion": 1,
        })
    return records


def _proposal_mappings(occurrences):
    return [{
        "sourceOccurrenceId": occ["sourceOccurrenceId"],
        "requirementId": occ["requirementId"],
        "classification": "source-backfill",
        "confidence": "auto" if occ["basis"] == "migration-backfill" else "high",
    } for occ in occurrences]


def commit_migration(root, confirmations) -> dict:
    """按用户确认提交单一 migration operation。confirmations 把 itemKey 映射到
    裁决的需求编号。人工项未全部确认时抛 MigrationBlocked（不建 operation、
    不写主本）。"""
    root = Path(root)
    confirmations = dict(confirmations or {})
    report = analyze(root)

    missing = [item["itemKey"] for item in report["manualItems"]
               if item["itemKey"] not in confirmations]
    if missing:
        raise MigrationBlocked(missing)

    # 完备性：revision 0 的每条 occurrence（自动 + 人工确认）都获得生效裁决。
    occurrences = []
    for candidate in report["autoCandidates"]:
        occurrences.append({
            "sourceOccurrenceId": candidate["sourceOccurrenceId"],
            "requirementId": candidate["requirementId"],
            "normalizedText": f"{candidate['requirementId']} {candidate['module']}".strip(),
            "basis": "migration-backfill",
            "confidence": "machine",
        })
    for item in report["manualItems"]:
        occurrences.append({
            "sourceOccurrenceId": item["sourceOccurrenceId"],
            "requirementId": confirmations[item["itemKey"]],
            "normalizedText": f"{item['itemKey']} {item['module']}".strip(),
            "basis": "manual-confirmation",
            "confidence": "confirmed",
        })

    plan = _plan_files(occurrences)
    operation_id = "op-migration"
    proposal = engine.build_proposal(
        root, proposal_id="prop-migration", proposal_kind="migration",
        candidate_revision=REVISION_0,
        mappings=_proposal_mappings(occurrences),
        affected_files=[entry["path"] for entry in plan],
        generator_version=_GENERATOR_VERSION)

    handle = writer_lock.acquire(root, operation_id)
    try:
        engine.create_operation(
            root, proposal, operation_id=operation_id, operation_kind="migration",
            plan=plan, target_source=SOURCE_ID, target_revision=REVISION_0)
        engine.commit_segment(root, operation_id, _journal_records(occurrences))
        engine.validate_operation(root, operation_id)
        engine.publish(root, operation_id)
    finally:
        handle.release()

    return engine.load_manifest(root, operation_id)
