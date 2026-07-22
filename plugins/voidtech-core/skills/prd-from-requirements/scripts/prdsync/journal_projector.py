"""journal 总序、supersedes 与有效裁决投影（技术设计 §3.8、§7.2）。

总序 = 按数值 segmentSeq 升序，段内按记录出现顺序；不依赖文件名字典序、
不依赖 decidedAt。只有所属 operation 已越过提交点的 segment 参与投影。
生命周期重放与双有效裁决的完整机械检查随门 4 落地。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import schema_validator
from .canonical_store import read_json

DECISIONS_RELPATH = "_source/reconciliation/decisions"
OPERATIONS_RELPATH = "_source/reconciliation/operations"
SYNC_STATE_RELPATH = "_source/sync-state.json"
SEGMENT_RE = re.compile(r"^(\d{6})-(op-[a-z0-9][a-z0-9-]*)\.jsonl$")

_SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"
_journal_schema_cache = None


def _journal_schema():
    global _journal_schema_cache
    if _journal_schema_cache is None:
        _journal_schema_cache = schema_validator.load_schema(_SCHEMAS_DIR, "journal-record")
    return _journal_schema_cache


def record_field_order(record):
    """按 schema 声明序返回该记录的字段顺序（JSONL 固定字段序，§7.1）。"""
    for branch in _journal_schema()["oneOf"]:
        if not schema_validator.validate(record, branch):
            return list(branch["properties"].keys())
    raise ValueError(f"record matches no journal-record branch: {record.get('decisionId')}")


def serialize_records(records) -> bytes:
    """按 schema 声明的字段序序列化为 JSONL（UTF-8、LF、记录顺序即语义顺序）。"""
    lines = []
    for record in records:
        order = record_field_order(record)
        ordered = {key: record[key] for key in order if key in record}
        extra = set(record) - set(ordered)
        if extra:
            raise ValueError(f"record has fields outside schema order: {sorted(extra)}")
        lines.append(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n").encode("utf-8")


def operation_past_commit_point(root, operation_id) -> bool:
    """同步类以 appliedRevision 推进为提交点；非同步类以 phase 翻转为 committed。"""
    manifest_path = Path(root) / OPERATIONS_RELPATH / f"{operation_id}.json"
    try:
        manifest = read_json(manifest_path)
    except (OSError, ValueError):
        return False
    if manifest.get("phase") == "committed":
        return True
    if manifest.get("commitPoint") == "appliedRevision":
        try:
            state = read_json(Path(root) / SYNC_STATE_RELPATH)
            cursors = state["sources"][manifest["targetSource"]]
        except (OSError, ValueError, KeyError):
            return False
        return cursors.get("appliedRevision") == manifest.get("targetRevision")
    return False


def committed_segment_paths(root):
    """已提交且所属 operation 已越过提交点的 segment，按数值 segmentSeq 升序。"""
    decisions_dir = Path(root) / DECISIONS_RELPATH
    if not decisions_dir.is_dir():
        return []
    entries = []
    for path in decisions_dir.iterdir():
        match = SEGMENT_RE.match(path.name)
        if not match:
            continue  # 临时 segment 或无关文件不参与投影
        seq, operation_id = int(match.group(1)), match.group(2)
        if operation_past_commit_point(root, operation_id):
            entries.append((seq, path))
    entries.sort(key=lambda item: item[0])
    return [path for _, path in entries]


def load_records(root):
    """按总序返回全部有效视图内的 journal 记录。"""
    records = []
    for path in committed_segment_paths(root):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
    return records


def project(root):
    """有效裁决投影：总序下未被 supersede 的最新记录。

    返回 {mappings: occurrenceId → record, controllers: (requirementId, scopeId)
    → record, transitions: requirementId → [record, ...]}。
    """
    records = load_records(root)
    superseded = {r["supersedes"] for r in records if r.get("supersedes")}
    mappings, controllers, transitions = {}, {}, {}
    for record in records:
        if record["decisionId"] in superseded:
            continue
        action = record["action"]
        if action in ("map", "remap"):
            mappings[record["sourceOccurrenceId"]] = record
        elif action == "set-lifecycle-controller":
            controllers[(record["requirementId"], record["scopeId"])] = record
        elif action == "transition":
            transitions.setdefault(record["requirementId"], []).append(record)
    return {"mappings": mappings, "controllers": controllers, "transitions": transitions}
