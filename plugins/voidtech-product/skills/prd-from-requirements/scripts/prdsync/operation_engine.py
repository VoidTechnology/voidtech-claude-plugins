"""operation 生命周期：proposal 契约、暂存发布协议与恢复矩阵。

对应技术设计 §2.2（base CAS）、§3.2/§3.3（manifest 与 proposal）、§4（暂存
发布五步与 digest 三态）、§5（恢复矩阵）。调用方持有 writer lock 期间执行
全部写入；恢复入口 recover_worktree 自行处理锁接管。

发布进度记录在 operations/<id>/progress.json（非冻结 schema 文件）：恢复的
正确性由 digest 三态保证，progress 只为 publish-conflict 回滚提供本 operation
已发布文件的逆序清单。
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from . import base_cas, journal_projector, manifest_checks, schema_validator, writer_lock
from .canonical_store import (
    atomic_write_bytes,
    atomic_write_json,
    file_digest,
    file_digest_or_none,
    digest_of,
    read_json,
    sha256_of_bytes,
)

OPERATIONS_RELPATH = "_source/reconciliation/operations"
PROPOSALS_RELPATH = "_source/reconciliation/proposals"
DECISIONS_RELPATH = "_source/reconciliation/decisions"
SYNC_STATE_RELPATH = "_source/sync-state.json"

TERMINAL_PHASES = {"committed", "aborted", "conflict"}
FENCE_PHASES = {"publishing", "publish-conflict"}
SYNC_KINDS = {"sync", "migration", "rebaseline"}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"

PROPOSAL_PAYLOAD_FIELDS = ("candidateRevision", "mappings", "ambiguities",
                           "lifecycleActions", "affectedFiles")


class OperationError(Exception):
    pass


class PathViolation(OperationError):
    """路径穿越、绝对路径或 symlink 越出工作树。"""


class ProposalExpired(OperationError):
    """基线失效：proposal 的 operationBaseDigest 与实时重算不符。"""


class ProposalTampered(OperationError):
    """proposalDigest 与确认载荷重算不符。"""


class BaseChanged(OperationError):
    """进入 publishing 前 base CAS 失败，operation 已置 conflict。"""


class PublishConflict(OperationError):
    """发布途中目标 digest 未知，operation 已置 publish-conflict。"""

    def __init__(self, path):
        super().__init__(f"unknown target digest at {path}")
        self.path = path


class RecoveryChoiceRequired(OperationError):
    """publish-conflict 需要用户在覆盖/保留第三方修改中二选一。"""


# ---------------------------------------------------------------- 基础存取

def _schema(name):
    return schema_validator.load_schema(_SCHEMAS_DIR, name)


def operation_dir(root, operation_id) -> Path:
    return Path(root) / OPERATIONS_RELPATH / operation_id


def manifest_path(root, operation_id) -> Path:
    return Path(root) / OPERATIONS_RELPATH / f"{operation_id}.json"


def load_manifest(root, operation_id):
    return read_json(manifest_path(root, operation_id))


def _save_manifest(root, manifest):
    atomic_write_json(manifest_path(root, manifest["operationId"]), manifest)


def _set_phase(root, manifest, phase):
    manifest["phase"] = phase
    _save_manifest(root, manifest)


def _progress_path(root, operation_id) -> Path:
    return operation_dir(root, operation_id) / "progress.json"


def _load_progress(root, operation_id):
    path = _progress_path(root, operation_id)
    return read_json(path) if path.exists() else []


def list_non_terminal(root):
    return writer_lock.list_non_terminal_operations(root)


# ---------------------------------------------------------------- proposal

def proposal_path(root, proposal_id) -> Path:
    return Path(root) / PROPOSALS_RELPATH / f"{proposal_id}.json"


def compute_proposal_digest(proposal) -> str:
    """覆盖集 = canonical(确认载荷 + operationBaseDigest + schemaVersion +
    generatorVersion)，排除 proposalDigest 自身与可变的 status（§3.0）。"""
    payload = {field: proposal[field] for field in PROPOSAL_PAYLOAD_FIELDS}
    payload["operationBaseDigest"] = proposal["operationBaseDigest"]
    payload["schemaVersion"] = proposal["schemaVersion"]
    payload["generatorVersion"] = proposal["generatorVersion"]
    return digest_of(payload)


def build_proposal(root, *, proposal_id, proposal_kind, candidate_revision=None,
                   mappings=(), ambiguities=(), lifecycle_actions=(),
                   affected_files=(), generator_version="1.0.0"):
    proposal = {
        "proposalId": proposal_id,
        "proposalKind": proposal_kind,
        "status": "open",
        "operationBaseDigest": base_cas.operation_base_digest(root),
        "candidateRevision": candidate_revision,
        "mappings": list(mappings),
        "ambiguities": list(ambiguities),
        "lifecycleActions": list(lifecycle_actions),
        "affectedFiles": list(affected_files),
        "generatorVersion": generator_version,
        "schemaVersion": 1,
    }
    proposal["proposalDigest"] = compute_proposal_digest(proposal)
    errors = schema_validator.check(proposal, _schema("proposal"))
    if errors:
        raise OperationError(f"invalid proposal: {errors}")
    atomic_write_json(proposal_path(root, proposal_id), proposal)
    return proposal


def load_proposal(root, proposal_id):
    return read_json(proposal_path(root, proposal_id))


def set_proposal_status(root, proposal_id, status):
    proposal = load_proposal(root, proposal_id)
    proposal["status"] = status
    atomic_write_json(proposal_path(root, proposal_id), proposal)
    return proposal


# ---------------------------------------------------------------- 路径安全

def _check_rel_path(rel: str):
    if rel.startswith("/") or os.path.isabs(rel):
        raise PathViolation(f"absolute path rejected: {rel}")
    # Windows 盘符绝对路径（C:/evil）与 NTFS ADS（file:stream）：拒绝首段含冒号，
    # 使拒绝不依赖运行平台或文件系统状态。
    if re.match(r"^[A-Za-z]+:", rel):
        raise PathViolation(f"drive/scheme-like path rejected: {rel}")
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise PathViolation(f"path traversal rejected: {rel}")
    if rel.startswith("_source/reconciliation/"):
        raise PathViolation(f"publish target inside reconciliation area: {rel}")


def _check_containment(root: Path, rel: str):
    """realpath 校验：symlink 解析越出工作树即拒绝（§4）。"""
    root_real = Path(os.path.realpath(root))
    candidate = root / rel
    probe = candidate
    while not probe.exists():
        probe = probe.parent
    probe_real = Path(os.path.realpath(probe))
    if root_real != probe_real and root_real not in probe_real.parents:
        raise PathViolation(f"target escapes worktree via symlink: {rel}")


# ---------------------------------------------------------------- 创建与 segment

def _allocate_segment_seq(root) -> int:
    used = set()
    decisions_dir = Path(root) / DECISIONS_RELPATH
    if decisions_dir.is_dir():
        for path in decisions_dir.iterdir():
            match = journal_projector.SEGMENT_RE.match(path.name)
            if match:
                used.add(int(match.group(1)))
    ops_dir = Path(root) / OPERATIONS_RELPATH
    if ops_dir.is_dir():
        for path in ops_dir.glob("*.json"):
            try:
                segment = read_json(path).get("segmentPath", "")
            except (ValueError, OSError):
                continue
            match = journal_projector.SEGMENT_RE.match(Path(segment).name)
            if match:
                used.add(int(match.group(1)))
    return max(used, default=0) + 1


def create_operation(root, proposal, *, operation_id, operation_kind, plan,
                     target_source=None, target_revision=None,
                     tool_versions=None):
    """按已确认 proposal 创建 operation：写暂存、落 manifest（phase prepared）。

    plan 条目：{"path": 工作树相对路径, "action": "write"|"delete",
    "content": bytes|str（write 必填）}。
    """
    root = Path(root)
    if not _ID_RE.match(operation_id.removeprefix("op-")) or not operation_id.startswith("op-"):
        raise OperationError(f"invalid operationId: {operation_id}")

    pending = [op for op in list_non_terminal(root) if op != operation_id]
    if pending:
        raise OperationError(f"non-terminal operations exist, recover first: {pending}")

    if proposal["status"] != "open":
        raise OperationError(f"proposal {proposal['proposalId']} is {proposal['status']}")
    if compute_proposal_digest(proposal) != proposal["proposalDigest"]:
        raise ProposalTampered(proposal["proposalId"])
    current_base = base_cas.operation_base_digest(root)
    if proposal["operationBaseDigest"] != current_base:
        set_proposal_status(root, proposal["proposalId"], "expired")
        raise ProposalExpired(proposal["proposalId"])

    op_dir = operation_dir(root, operation_id)
    files = []
    staged_payloads = {}
    for entry in plan:
        rel, action = entry["path"], entry["action"]
        _check_rel_path(rel)
        _check_containment(root, rel)
        target = root / rel
        old_digest = file_digest_or_none(target)
        if action == "write":
            content = entry["content"]
            data = content.encode("utf-8") if isinstance(content, str) else content
            staged_rel = f"{OPERATIONS_RELPATH}/{operation_id}/staging/{rel}"
            staged_payloads[staged_rel] = data
            files.append({
                "path": rel,
                "action": "write",
                "oldDigest": old_digest,
                "newDigest": sha256_of_bytes(data),
                "stagedPath": staged_rel,
                "backupPath": (f"{OPERATIONS_RELPATH}/{operation_id}/backup/{rel}"
                               if old_digest is not None else None),
            })
        elif action == "delete":
            if old_digest is None:
                raise OperationError(f"delete target missing: {rel}")
            files.append({
                "path": rel,
                "action": "delete",
                "oldDigest": old_digest,
                "newDigest": None,
                "stagedPath": None,
                "backupPath": f"{OPERATIONS_RELPATH}/{operation_id}/backup/{rel}",
            })
        else:
            raise OperationError(f"unknown action: {action}")

    manifest = {
        "operationId": operation_id,
        "operationKind": operation_kind,
        "phase": "prepared",
        "commitPoint": "appliedRevision" if operation_kind in SYNC_KINDS else "operationState",
        "operationBaseDigest": current_base,
        "proposalId": proposal["proposalId"],
        "proposalDigest": proposal["proposalDigest"],
        "segmentPath": f"{DECISIONS_RELPATH}/{_allocate_segment_seq(root):06d}-{operation_id}.jsonl",
        "targetSource": target_source,
        "targetRevision": target_revision,
        "files": files,
        "toolVersions": tool_versions or {"normalizer": "1.0.0", "generator": "1.0.0"},
        "schemaVersion": 1,
    }
    errors = schema_validator.check(manifest, _schema("operation"))
    errors.extend(manifest_checks.check_operation_derived_paths(manifest))
    if errors:
        raise OperationError(f"invalid operation manifest: {errors}")

    for staged_rel, data in staged_payloads.items():
        atomic_write_bytes(root / staged_rel, data)
    op_dir.mkdir(parents=True, exist_ok=True)
    set_proposal_status(root, proposal["proposalId"], "confirmed")
    _save_manifest(root, manifest)
    return manifest


def commit_segment(root, operation_id, records):
    """裁决事务 segment：临时写入 + fsync + 原子 rename 提交（ADR-0004 §4）。"""
    root = Path(root)
    manifest = load_manifest(root, operation_id)
    schema = _schema("journal-record")
    for record in records:
        errors = schema_validator.check(record, schema)
        if errors:
            raise OperationError(f"invalid journal record: {errors}")
    atomic_write_bytes(root / manifest["segmentPath"],
                       journal_projector.serialize_records(records))


def validate_operation(root, operation_id):
    """内容门占位：门 1 只做 base CAS 重算；PRD 结构检查随后续门接入。"""
    root = Path(root)
    manifest = load_manifest(root, operation_id)
    if manifest["phase"] != "prepared":
        raise OperationError(f"cannot validate from phase {manifest['phase']}")
    if not (root / manifest["segmentPath"]).exists():
        raise OperationError("segment not committed yet")
    if base_cas.operation_base_digest(root) != manifest["operationBaseDigest"]:
        _set_phase(root, manifest, "conflict")
        set_proposal_status(root, manifest["proposalId"], "expired")
        raise BaseChanged(operation_id)
    _set_phase(root, manifest, "validated")
    return manifest


# ---------------------------------------------------------------- 发布协议

def _entry_state(root, entry) -> str:
    """digest 三态判定，固定顺序「先 new 后 old、否则冲突」（§4）。"""
    target = Path(root) / entry["path"]
    current = file_digest_or_none(target)
    if entry["action"] == "delete":
        if current is None:
            return "done"
        if current == entry["oldDigest"]:
            return "pending"
        return "conflict"
    if current is not None and current == entry["newDigest"]:
        return "done"
    if entry["oldDigest"] is None and current is None:
        return "pending"
    if entry["oldDigest"] is not None and current == entry["oldDigest"]:
        return "pending"
    return "conflict"


def _publish_entry(root, entry, hook):
    """单文件发布五步：备份快照 → staging 复制为临时文件 → fsync → rename →
    记录进度。绝不把 staging 文件直接 rename 走。"""
    root = Path(root)
    target = root / entry["path"]
    if hook:
        hook(f"before:{entry['path']}")
    if entry["backupPath"] is not None:
        backup = root / entry["backupPath"]
        if not backup.exists() and target.exists():
            atomic_write_bytes(backup, target.read_bytes())
    if hook:
        hook(f"backup:{entry['path']}")
    if entry["action"] == "write":
        atomic_write_bytes(target, (root / entry["stagedPath"]).read_bytes())
    else:
        os.remove(target)


def _revalidate_manifest_paths(root, manifest):
    """发布/恢复消费磁盘上的 manifest 前复验路径约束（防手改/篡改的 manifest
    把写入引出工作树）——创建时的校验不能替代恢复路径上的校验。"""
    errors = manifest_checks.check_operation_derived_paths(manifest)
    if errors:
        raise PathViolation(f"manifest derived paths invalid: {errors}")
    for entry in manifest["files"]:
        _check_rel_path(entry["path"])
        _check_containment(root, entry["path"])


def _continue_publish(root, manifest, hook=None, force_conflicts=False):
    root = Path(root)
    _revalidate_manifest_paths(root, manifest)
    operation_id = manifest["operationId"]
    progress = _load_progress(root, operation_id)
    for entry in manifest["files"]:
        state = _entry_state(root, entry)
        if state == "done":
            continue
        if state == "conflict" and not force_conflicts:
            _set_phase(root, manifest, "publish-conflict")
            raise PublishConflict(entry["path"])
        _publish_entry(root, entry, hook)
        if entry["path"] not in progress:
            progress.append(entry["path"])
            atomic_write_json(_progress_path(root, operation_id), progress)
        if hook:
            hook(f"after:{entry['path']}")
    if hook:
        hook("before-commit")
    _advance_commit_point(root, manifest, hook)


def _advance_commit_point(root, manifest, hook=None):
    """唯一提交点：同步类推进 appliedRevision，非同步类原子翻转 committed。"""
    root = Path(root)
    if manifest["commitPoint"] == "appliedRevision":
        state_path = root / SYNC_STATE_RELPATH
        state = read_json(state_path)
        cursors = state["sources"][manifest["targetSource"]]
        if cursors.get("appliedRevision") != manifest["targetRevision"]:
            cursors["appliedRevision"] = manifest["targetRevision"]
            if cursors.get("pendingRevision") == manifest["targetRevision"]:
                cursors["pendingRevision"] = None
            atomic_write_json(state_path, state)
        if hook:
            hook("after-commit")
        # phase: committed 是提交点之后的观察补写（§3.2）。
        _set_phase(root, manifest, "committed")
    else:
        # 非同步类：phase 原子翻转为 committed 即提交。
        _set_phase(root, manifest, "committed")
        if hook:
            hook("after-commit")


def publish(root, operation_id, hook=None):
    root = Path(root)
    manifest = load_manifest(root, operation_id)
    if manifest["phase"] == "validated":
        # 进入 publishing 前重算 base CAS：不一致禁止覆盖发布（§2.2）。
        if base_cas.operation_base_digest(root) != manifest["operationBaseDigest"]:
            _set_phase(root, manifest, "conflict")
            set_proposal_status(root, manifest["proposalId"], "expired")
            raise BaseChanged(operation_id)
        _set_phase(root, manifest, "publishing")
    elif manifest["phase"] != "publishing":
        raise OperationError(f"cannot publish from phase {manifest['phase']}")
    _continue_publish(root, manifest, hook)
    return load_manifest(root, operation_id)


# ---------------------------------------------------------------- 恢复矩阵

def _rollback_published(root, manifest):
    """保留第三方修改：逆序回滚本 operation 已发布的文件——新建动作删除目标，
    改写与删除动作从 backup 恢复（§4）。"""
    root = Path(root)
    _revalidate_manifest_paths(root, manifest)
    entries = {entry["path"]: entry for entry in manifest["files"]}
    for path in reversed(_load_progress(root, manifest["operationId"])):
        entry = entries[path]
        target = root / path
        if entry["action"] == "write" and entry["oldDigest"] is None:
            if target.exists():
                os.remove(target)
        else:
            atomic_write_bytes(target, (root / entry["backupPath"]).read_bytes())


def _commit_point_passed(root, manifest) -> bool:
    return journal_projector.operation_past_commit_point(root, manifest["operationId"])


def recover_operation(root, operation_id, conflict_choice=None, hook=None):
    """按 §5 恢复矩阵推进单个 operation；调用方持有 writer lock。

    conflict_choice：publish-conflict 时 "override"（覆盖第三方修改）或
    "keep"（保留第三方修改并回滚）。
    返回执行的动作标签。
    """
    root = Path(root)
    manifest = load_manifest(root, operation_id)
    phase = manifest["phase"]

    if phase in TERMINAL_PHASES:
        return "terminal"

    if phase == "prepared":
        if not (root / manifest["segmentPath"]).exists():
            shutil.rmtree(operation_dir(root, operation_id) / "staging", ignore_errors=True)
            _set_phase(root, manifest, "aborted")
            return "aborted"
        if base_cas.operation_base_digest(root) != manifest["operationBaseDigest"]:
            _set_phase(root, manifest, "conflict")
            set_proposal_status(root, manifest["proposalId"], "expired")
            return "conflict"
        validate_operation(root, operation_id)
        publish(root, operation_id, hook)
        return "resumed"

    if phase == "validated":
        publish(root, operation_id, hook)
        return "resumed"

    if phase == "publishing":
        if _commit_point_passed(root, manifest):
            # 提交点已过、committed 未写：据提交点确定性补写，无人工判断。
            _set_phase(root, manifest, "committed")
            return "finalized"
        _continue_publish(root, manifest, hook)
        return "resumed"

    if phase == "publish-conflict":
        if conflict_choice == "override":
            _set_phase(root, manifest, "publishing")
            _continue_publish(root, manifest, hook, force_conflicts=True)
            return "overridden"
        if conflict_choice == "keep":
            _rollback_published(root, manifest)
            _set_phase(root, manifest, "conflict")
            set_proposal_status(root, manifest["proposalId"], "expired")
            return "rolled-back"
        raise RecoveryChoiceRequired(operation_id)

    raise OperationError(f"unknown phase: {phase}")


def recover_worktree(root, conflict_choice=None):
    """恢复入口：处理锁接管与元数据异常后，恢复全部非终态 operation。"""
    root = Path(root)
    try:
        handle = writer_lock.acquire(root, "op-recovery")
    except writer_lock.RecoveryRequired as exc:
        # 锁元数据损坏且恰一个非终态 operation：owner 无法判定，清锁后恢复。
        writer_lock.force_clear(root)
        handle = writer_lock.acquire(root, "op-recovery")
        handle.recovery_required = exc.operation_id
    try:
        if handle.recovery_required:
            recover_operation(root, handle.recovery_required, conflict_choice)
            handle.clear_recovery()
        actions = {}
        for operation_id in list_non_terminal(root):
            actions[operation_id] = recover_operation(root, operation_id, conflict_choice)
        return actions
    finally:
        handle.release()
