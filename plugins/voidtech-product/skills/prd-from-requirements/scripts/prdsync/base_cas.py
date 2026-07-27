"""完整 base CAS 的四分量 operationBaseDigest（技术设计 §2.2）。

operationBaseDigest 覆盖完整读取集：权威主本摘要、Ledger 当前有效输入摘要、
prd-worktree.json 的 canonical bytes 哈希、全部权威 schema 版本集合哈希。
进入 publishing 前重算，不一致即 conflict——带外修改任何主本都会被拦截。
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

from . import journal_projector
from .canonical_store import (
    digest_of, file_digest, file_digest_or_none, read_json, sha256_of_bytes,
)

# 八套权威 schema 的当前版本集合；schema 变更时随 ADR-0002 口径同步更新。
SCHEMA_VERSIONS = {
    "prd-worktree": 1,
    "source-registry": 1,
    "sync-state": 1,
    "revision-manifest": 1,
    "normalization-manifest": 1,
    "proposal": 1,
    "operation": 1,
    "journal-record": 1,
}

SOURCE_REGISTRY_RELPATH = "_source/source-registry.json"
SYNC_STATE_RELPATH = "_source/sync-state.json"
MATRIX_RELPATH = "00-global/requirement-traceability-matrix.md"
WORKTREE_MANIFEST = "prd-worktree.json"

# 权威主本排除生成物与 _source（后者由 ledgerSourceDigest 覆盖）。
_EXCLUDED_TOP = ("_source",)
_EXCLUDED_SEGMENTS = ("_generated",)


def _authoritative_files(root: Path):
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        parts = rel.parts
        if parts[0] in _EXCLUDED_TOP:
            continue
        if any(part in _EXCLUDED_SEGMENTS for part in parts):
            continue
        if str(rel) == WORKTREE_MANIFEST:
            continue  # 由 worktreeCapabilityDigest 单独覆盖
        if str(rel) == "logic-atlas.html":
            continue  # Atlas 发布产物（ADR-0005 布局在根目录）；计入会让发布自我失效
        # NFC 归一路径键：macOS(NFD) 与 Linux/git(NFC) 对同一中文文件名给出
        # 不同字节序列，不归一会造成跨平台假过期/假冲突。
        yield unicodedata.normalize("NFC", rel.as_posix()), path


def authoritative_source_digest(root) -> str:
    """排序后的「相对路径 + 文件哈希」权威主本摘要（ADR-0005 §6）。"""
    root = Path(root)
    items = sorted([rel, file_digest(path)] for rel, path in _authoritative_files(root))
    return digest_of(items)


def ledger_source_digest(root) -> str:
    """Ledger 当前有效输入集合摘要（ADR-0004 §4）。

    applied 游标显式选取：各源 appliedRevision 的 normalized.jsonl、已生效
    change manifest、已越过提交点的裁决 segment、registry、applied 游标投影
    与追溯矩阵。pending 不纳入。
    """
    root = Path(root)
    items = []

    registry_path = root / SOURCE_REGISTRY_RELPATH
    registry = read_json(registry_path) if registry_path.exists() else None
    items.append(["source-registry", digest_of(registry)])

    state_path = root / SYNC_STATE_RELPATH
    state = read_json(state_path) if state_path.exists() else {"sources": {}}
    applied = {
        source_id: cursors.get("appliedRevision")
        for source_id, cursors in sorted(state.get("sources", {}).items())
        if "appliedRevision" in cursors
    }
    items.append(["applied-cursors", digest_of(applied)])

    for source_id, revision in sorted(applied.items()):
        if revision is None:
            continue
        normalized = root / "_source" / "revisions" / source_id / revision / "normalized.jsonl"
        items.append([f"normalized:{source_id}", file_digest_or_none(normalized)])

    changes_dir = root / "_source" / "changes"
    if changes_dir.is_dir():
        for manifest_path in sorted(changes_dir.glob("*/manifest.json")):
            try:
                manifest = read_json(manifest_path)
            except ValueError:
                continue
            if manifest.get("status") in ("applied", "absorbed"):
                items.append([f"change:{manifest_path.parent.name}", file_digest(manifest_path)])

    for segment in journal_projector.committed_segment_paths(root):
        # 空 segment（无裁决记录，如生成物维护 operation）不属于「裁决 segment」，
        # 不进入 Ledger 当前有效输入集合（ADR-0005 §6）。按字节判空并复用同一次
        # 读取做哈希：损坏/非 UTF-8 的 segment 不得让摘要计算崩溃。
        data = segment.read_bytes()
        if data.strip(b"\r\n\t "):
            items.append([f"segment:{segment.name}", sha256_of_bytes(data)])

    items.append(["traceability-matrix", file_digest_or_none(root / MATRIX_RELPATH)])
    items.sort(key=lambda item: item[0])
    return digest_of(items)


def worktree_capability_digest(root) -> str:
    manifest_path = Path(root) / WORKTREE_MANIFEST
    if not manifest_path.exists():
        return digest_of("legacy-absent")
    return digest_of(read_json(manifest_path))


def effective_schema_digest() -> str:
    return digest_of(SCHEMA_VERSIONS)


def operation_base_digest(root) -> str:
    return digest_of({
        "authoritativeSourceDigest": authoritative_source_digest(root),
        "ledgerSourceDigest": ledger_source_digest(root),
        "worktreeCapabilityDigest": worktree_capability_digest(root),
        "effectiveSchemaDigest": effective_schema_digest(),
    })
