"""canonical 序列化、digest 与原子写（技术设计 §7.1）。

协议语义对齐 voidtech-loop 的 statestore.mjs：canonical JSON checksum、
锁内 compare-and-write、tmp + fsync + rename 原子写。仅标准库。
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


class CasError(ValueError):
    """checksum 比对失败：目标文件已被并发修改。"""


def canonical_json_bytes(value) -> bytes:
    """键排序、UTF-8、无多余空白、单个 LF 结尾。"""
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return (text + "\n").encode("utf-8")


def sha256_of_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest_of(value) -> str:
    return sha256_of_bytes(canonical_json_bytes(value))


def file_digest(path) -> str:
    return sha256_of_bytes(Path(path).read_bytes())


def file_digest_or_none(path):
    path = Path(path)
    if not path.exists():
        return None
    return file_digest(path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write_bytes(path, data: bytes) -> None:
    """tmp + fsync + rename；临时文件与目标同目录，保证 rename 原子。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".tmp-{path.name}-{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def atomic_write_json(path, value) -> None:
    atomic_write_bytes(path, canonical_json_bytes(value))


def update_json_if_digest(path, expected_digest, new_value) -> str:
    """读取 checksum → 锁内 compare-and-write（updateStateIfChecksum 语义）。"""
    current = file_digest_or_none(path)
    if current != expected_digest:
        raise CasError(f"{path}: digest {current!r} != expected {expected_digest!r}")
    atomic_write_json(path, new_value)
    return file_digest(path)
