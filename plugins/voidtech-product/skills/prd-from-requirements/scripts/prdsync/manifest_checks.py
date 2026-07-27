"""operation manifest 的跨字段推导校验（技术设计 §3.0）。

JSON Schema 子集表达不了「stagedPath / backupPath 必须逐字节等于由
operationId 与 path 推导出的唯一位置」，此处重算比对。
proposalDigest 覆盖集重算依赖 canonical 序列化，随 canonical_store 落地。
"""

from __future__ import annotations


def check_operation_derived_paths(operation):
    """返回错误列表；空列表表示通过。输入应先通过 operation schema 校验。"""
    errors = []
    operation_id = operation.get("operationId", "")
    base = f"_source/reconciliation/operations/{operation_id}"
    for i, entry in enumerate(operation.get("files", [])):
        path = entry.get("path", "")
        derived = {
            "stagedPath": f"{base}/staging/{path}",
            "backupPath": f"{base}/backup/{path}",
        }
        for field, expected in derived.items():
            actual = entry.get(field)
            if actual is not None and actual != expected:
                errors.append(
                    f"$.files[{i}].{field}: {actual!r} != derived {expected!r}"
                )
    return errors
