"""当前有效视图、operation overlay resolver 与读取栅栏（技术设计 §6、§9）。

overlay resolver 返回「逻辑路径 → 实际文件」映射：默认排除
`_source/reconciliation/`；带 operation-id 时以该 operation 的 staging 覆盖
原路径、delete 移除条目，同一逻辑文件只出现一次。存在 publishing /
publish-conflict 状态的 operation 时构成读取栅栏，读取当前有效视图必须先
恢复或拒绝读取。
"""

from __future__ import annotations

from pathlib import Path

from .canonical_store import read_json
from .writer_lock import OPERATIONS_RELPATH

FENCE_PHASES = {"publishing", "publish-conflict"}
_EXCLUDED_PREFIX = "_source/reconciliation/"


class ReadFenceError(Exception):
    """存在未完成发布的 operation，读取方必须先恢复或拒绝读取。"""

    def __init__(self, operation_ids):
        super().__init__(f"read fence active: {sorted(operation_ids)}")
        self.operation_ids = sorted(operation_ids)


def blocking_operations(root):
    ops_dir = Path(root) / OPERATIONS_RELPATH
    blocking = []
    if not ops_dir.is_dir():
        return blocking
    for path in sorted(ops_dir.glob("*.json")):
        try:
            manifest = read_json(path)
        except (OSError, ValueError):
            continue
        if manifest.get("phase") in FENCE_PHASES:
            blocking.append(manifest.get("operationId", path.stem))
    return blocking


def assert_read_fence(root):
    blocking = blocking_operations(root)
    if blocking:
        raise ReadFenceError(blocking)


def resolve_view(root, operation_id=None):
    """返回 {逻辑相对路径: 实际文件 Path}。

    operation_id 为 None 时读取当前有效视图（先验证读取栅栏）；给定时返回
    「当前有效视图 + 该 operation staging」的预提交合成视图。
    """
    root = Path(root)
    if operation_id is None:
        assert_read_fence(root)

    mapping = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(_EXCLUDED_PREFIX):
            continue
        mapping[rel] = path

    if operation_id is not None:
        manifest = read_json(Path(root) / OPERATIONS_RELPATH / f"{operation_id}.json")
        for entry in manifest["files"]:
            if entry["action"] == "write":
                mapping[entry["path"]] = root / entry["stagedPath"]
            else:
                mapping.pop(entry["path"], None)
    return mapping
