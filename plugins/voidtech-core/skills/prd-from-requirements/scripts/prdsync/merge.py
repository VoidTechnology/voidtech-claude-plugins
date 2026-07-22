"""受控合入：三方归并、批量机器裁决与人工确认、生命周期与来源治理。

对应 ADR-0004 §4/§5/§6/§7 与技术设计 §3.3/§3.6/§3.7/§7.3；门 4「受控增量合入」。

- `propose_sync(root, source_id) -> proposal`：对该源 pending revision 与全局
  Requirement Ledger 做三方归并（三桶分类 + 歧义确认 + 撤回候选），经
  operation_engine.build_proposal 落盘 candidate overlay，不改任何主本/生命周期。
- `commit_proposal(root, proposal_id, decisions=None) -> operation manifest`：
  按人工裁决提交。sync 类批量机器裁决（exact-fingerprint/machine）与人工确认
  （manual-confirmation/confirmed）同事务落 journal，appliedRevision 推进、pending
  清空；歧义/new 未裁决抛 DecisionRequired，不提交任何内容。maintain 类（生命周期、
  来源退休、assertion 失效）提交点为 operationState。
- `withdrawal_candidates(root) -> list`：按当前有效视图（applied 游标 + 有效 change）
  聚合的撤回候选，任何情况下不自动改状态。
- `register_change(...)`：change-stream 降级入口；来源回填吸收（absorbed）后
  sustainsRequirement 置 false，支撑转移到吸收它的 occurrence。
- `propose_source_retirement` / `propose_assertion_invalidation` / `propose_lifecycle`：
  见各函数 docstring。未来 effectiveAt 只作审计字段，状态在提交时生效，不读墙钟。

仅使用 Python 标准库。
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from . import journal_projector, sync, writer_lock
from . import operation_engine as engine
from .canonical_store import canonical_json_bytes, read_json

REGISTRY_RELPATH = "_source/source-registry.json"
SYNC_STATE_RELPATH = "_source/sync-state.json"
CHANGES_RELDIR = "_source/changes"
LEDGER_RELPATH = "_generated/requirements-ledger.jsonl"
CHANGE_SOURCE_ID = "change-stream"
REQUIREMENT_SCOPE = "requirement"

_DECIDED_AT = "2026-07-21T00:00:00+08:00"
_DECIDED_BY = "prd-from-requirements"
_GENERATOR_VERSION = "1.0.0"

_ACTIVE = "active"
_REQ_ID_RE = re.compile(r"^([A-Z][A-Z0-9]*)-(\d+)$")

# 生命周期动作 → 目标状态（合法性由后续机械检查依 journal transition 历史验证）。
_TARGET_STATE = {
    "withdraw": "withdrawn",
    "deprecate": "deprecated",
    "supersede": "superseded",
    "remove": "removed",
    "reactivate": "active",
    "cancel-deprecation": "active",
}


class DecisionRequired(Exception):
    """存在歧义项或 new 占位未裁决：不提交任何内容。"""

    def __init__(self, occurrences):
        self.occurrences = list(occurrences)
        super().__init__(f"decision required for occurrences: {self.occurrences}")


# ---------------------------------------------------------------- 有效视图上下文

def _registry(root):
    return read_json(Path(root) / REGISTRY_RELPATH)


def _sync_state(root):
    return read_json(Path(root) / SYNC_STATE_RELPATH)


def _versioned_sources(root):
    return [s["sourceId"] for s in _registry(root)["sources"]
            if s.get("mode") == "versioned"]


def _load_changes(root):
    """{changeId: manifest}（全部 change manifest，按 changeId 排序）。"""
    changes = {}
    changes_dir = Path(root) / CHANGES_RELDIR
    if changes_dir.is_dir():
        for manifest_path in sorted(changes_dir.glob("*/manifest.json")):
            try:
                manifest = read_json(manifest_path)
            except ValueError:
                continue
            changes[manifest["changeId"]] = manifest
    return changes


def _context(root):
    """当前有效视图：applied 游标选取的源 occurrence 映射 + change manifest。

    applied：{occId: {"text", "req", "role", "source"}}——各 versioned 源
    appliedRevision 的 occurrence 与其有效 journal 映射的联结（历史 revision 的
    occurrence 不属于当前来源存在）。
    """
    root = Path(root)
    state = _sync_state(root)
    projection = journal_projector.project(root)
    mappings = projection["mappings"]

    applied = {}
    for source_id in _versioned_sources(root):
        cursors = state["sources"].get(source_id)
        if not isinstance(cursors, dict):
            continue
        revision = cursors.get("appliedRevision")
        if not revision:
            continue
        for record in sync.load_normalized(root, source_id, revision):
            occ = record["sourceOccurrenceId"]
            mapping = mappings.get(occ)
            if mapping is None:
                continue
            applied[occ] = {
                "text": record["normalizedText"],
                "req": mapping["requirementId"],
                "role": mapping["assertionRole"],
                "source": source_id,
            }

    return {
        "state": state,
        "projection": projection,
        "mappings": mappings,
        "applied": applied,
        "changes": _load_changes(root),
    }


def _lifecycle_states(projection):
    """需求当前生命周期状态（transition 链末态；无 transition 隐式 active）。"""
    states = {}
    for req, transitions in projection["transitions"].items():
        states[req] = transitions[-1]["to"]
    return states


def _existing_ids(ctx):
    ids = {rec["requirementId"] for rec in ctx["mappings"].values()}
    ids |= set(ctx["projection"]["transitions"].keys())
    return {i for i in ids if i}


def _role_map(ctx, role_override=None):
    """requirementId → 当前有效支撑角色集合。role_override 覆盖指定 occ 的角色
    （用于反映同事务内尚未提交的 remap，使生成物投影与提交后一致）。"""
    role_override = role_override or {}
    roles = {}
    for occ, info in ctx["applied"].items():
        role = role_override.get(occ, info["role"])
        roles.setdefault(info["req"], set()).add(role)
    for manifest in ctx["changes"].values():
        if manifest.get("status") == "applied" and manifest.get("sustainsRequirement"):
            roles.setdefault(manifest["requirementId"], set()).add("normative")
    return roles


def _remaining_roles(ctx, requirement_id, exclude_occ):
    roles = set()
    for occ, info in ctx["applied"].items():
        if occ != exclude_occ and info["req"] == requirement_id:
            roles.add(info["role"])
    for manifest in ctx["changes"].values():
        if (manifest.get("status") == "applied" and manifest.get("sustainsRequirement")
                and manifest.get("requirementId") == requirement_id):
            roles.add("normative")
    return roles


def _sustains(roles):
    return "normative" in roles or "overriding" in roles


def _candidate_confidence(roles):
    """§6 优先级表：全无有效来源 → 高置信；仅 corroborating/contextual → 低置信。"""
    return "high" if not roles else "low"


# ---------------------------------------------------------------- 撤回候选聚合

def withdrawal_candidates(root):
    """按当前有效视图聚合撤回候选（不改任何状态）。"""
    ctx = _context(root)
    roles = _role_map(ctx)
    states = _lifecycle_states(ctx["projection"])
    candidates = []
    for req in sorted(_existing_ids(ctx)):
        if states.get(req, _ACTIVE) != _ACTIVE:
            continue
        req_roles = roles.get(req, set())
        if _sustains(req_roles):
            continue
        candidates.append({"requirementId": req,
                           "confidence": _candidate_confidence(req_roles)})
    return candidates


# ---------------------------------------------------------------- 三方归并 proposal

def _text_to_source_req(ctx):
    idx = {}
    for info in ctx["applied"].values():
        idx.setdefault(info["text"], info["req"])
    return idx


def _text_to_change(ctx):
    idx = {}
    for change_id, manifest in ctx["changes"].items():
        if manifest.get("status") == "applied" and manifest.get("sustainsRequirement"):
            idx.setdefault(manifest["normalizedText"], (change_id, manifest["requirementId"]))
    return idx


def _map_entry(occ, requirement_id, classification, confidence):
    return {"sourceOccurrenceId": occ, "requirementId": requirement_id,
            "classification": classification, "confidence": confidence}


def _rev_slug(revision_id):
    return revision_id.split("-", 1)[1]


def propose_sync(root, source_id):
    """三方归并该源 pending revision，产出可审阅 proposal（三桶 + 歧义 + 撤回候选）。"""
    root = Path(root)
    ctx = _context(root)
    cursors = ctx["state"]["sources"][source_id]
    applied_rev = cursors["appliedRevision"]
    candidate_rev = cursors.get("pendingRevision") or applied_rev

    pending_records = sync.load_normalized(root, source_id, candidate_rev)
    pending_cols = sync.columns_by_occurrence(root, source_id, candidate_rev)
    applied_records = sync.load_normalized(root, source_id, applied_rev)
    applied_cols = sync.columns_by_occurrence(root, source_id, applied_rev)
    applied_occ_req = {
        r["sourceOccurrenceId"]: ctx["mappings"][r["sourceOccurrenceId"]]["requirementId"]
        for r in applied_records if r["sourceOccurrenceId"] in ctx["mappings"]}

    text_src = _text_to_source_req(ctx)
    text_chg = _text_to_change(ctx)
    pending_texts = {r["normalizedText"] for r in pending_records}

    mappings = []
    ambiguities = []
    affected = [SYNC_STATE_RELPATH]

    # 分桶：字节等价 → 自动通道；否则待定（added）。
    added = []
    for record in pending_records:
        occ = record["sourceOccurrenceId"]
        text = record["normalizedText"]
        if text in text_src:
            mappings.append(_map_entry(occ, text_src[text], "unchanged", "auto"))
        elif text in text_chg:
            mappings.append(_map_entry(occ, text_chg[text][1], "source-backfill", "auto"))
        else:
            added.append(record)

    # 该源 applied revision 中字节消失的 occurrence。
    disappeared = [r for r in applied_records
                   if r["normalizedText"] not in pending_texts
                   and r["sourceOccurrenceId"] in applied_occ_req]

    # 歧义确认：added occurrence 与同模块内消失的既有需求配对（绝不自动裁决）。
    claimed = set()
    for record in added:
        occ = record["sourceOccurrenceId"]
        module = pending_cols.get(occ, {}).get("module")
        candidates = [d for d in disappeared
                      if d["sourceOccurrenceId"] not in claimed
                      and applied_cols.get(d["sourceOccurrenceId"], {}).get("module") == module]
        if candidates:
            chosen = candidates[0]
            claimed.add(chosen["sourceOccurrenceId"])
            candidate_ids = sorted({applied_occ_req[c["sourceOccurrenceId"]]
                                    for c in candidates})
            ambiguities.append({
                "kind": "identity",
                "detail": f"模块「{module}」内正文变化，疑似既有需求的内容变更，需人工确认身份",
                "occurrences": [occ],
                "candidateRequirementIds": candidate_ids,
            })
        else:
            mappings.append(_map_entry(occ, None, "new", "high"))

    # 撤回候选：未被歧义认领的消失 occurrence，按剩余有效支撑判定。
    for record in disappeared:
        occ = record["sourceOccurrenceId"]
        if occ in claimed:
            continue
        requirement_id = applied_occ_req[occ]
        remaining = _remaining_roles(ctx, requirement_id, exclude_occ=occ)
        if _sustains(remaining):
            continue  # 单源移除但仍有 normative/overriding 支撑，不产生候选
        mappings.append(_map_entry(occ, requirement_id, "withdrawal-candidate",
                                   _candidate_confidence(remaining)))

    proposal_id = f"prop-sync-{_rev_slug(candidate_rev)}"
    return engine.build_proposal(
        root, proposal_id=proposal_id, proposal_kind="sync",
        candidate_revision=candidate_rev, mappings=mappings, ambiguities=ambiguities,
        affected_files=affected, generator_version=_GENERATOR_VERSION)


# ---------------------------------------------------------------- 编号分配

def _allocate_ids(existing_ids, count, prefix=None):
    """防重复编号：新编号 = **该前缀**现有最大号 + 1，绝不复用。

    prefix 为 None 时退回「全局最大号所属前缀」——仅在无法从上下文推断前缀时
    使用（单前缀工作树下两者等价）。
    """
    if count == 0:
        return []
    parsed = []
    for req in existing_ids:
        match = _REQ_ID_RE.match(req)
        if match:
            parsed.append((match.group(1), int(match.group(2))))
    if prefix is None:
        prefix = max(parsed, key=lambda item: item[1])[0] if parsed else "TST"
    top = max((number for p, number in parsed if p == prefix), default=0)
    return [f"{prefix}-{top + k:03d}" for k in range(1, count + 1)]


# ---------------------------------------------------------------- 生成物投影

def _render_ledger_plan(existing_ids, states, roles):
    """当前 Requirement Ledger 读模型（生成物，供机械检查/审阅；确定性 JSONL）。"""
    lines = []
    for req in sorted(existing_ids):
        lines.append(json.dumps({
            "requirementId": req,
            "state": states.get(req, _ACTIVE),
            "sustained": sorted(roles.get(req, set())),
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    content = ("\n".join(lines) + "\n").encode("utf-8") if lines else b"\n"
    return {"path": LEDGER_RELPATH, "action": "write", "content": content}


# ---------------------------------------------------------------- 提交

def commit_proposal(root, proposal_id, decisions=None):
    """按人工裁决提交 proposal（见模块 docstring 的契约）。"""
    root = Path(root)
    proposal = engine.load_proposal(root, proposal_id)
    if proposal["proposalKind"] == "sync":
        return _commit_sync(root, proposal, dict(decisions or {}))
    if proposal["lifecycleActions"]:
        return _commit_lifecycle(root, proposal)
    if proposal_id.startswith("prop-retire-"):
        return _commit_retirement(root, proposal)
    if proposal_id.startswith("prop-invalidate-"):
        return _commit_invalidation(root, proposal)
    raise engine.OperationError(f"unknown maintain proposal: {proposal_id}")


def _run(root, proposal, operation_id, operation_kind, plan, journal_records,
         target_source=None, target_revision=None):
    handle = writer_lock.acquire(root, operation_id)
    try:
        engine.create_operation(
            root, proposal, operation_id=operation_id, operation_kind=operation_kind,
            plan=plan, target_source=target_source, target_revision=target_revision)
        engine.commit_segment(root, operation_id, journal_records)
        engine.validate_operation(root, operation_id)
        engine.publish(root, operation_id)
    finally:
        handle.release()
    return engine.load_manifest(root, operation_id)


def _commit_sync(root, proposal, decisions):
    ctx = _context(root)
    candidate_rev = proposal["candidateRevision"]
    source_id = next(sid for sid, cursors in ctx["state"]["sources"].items()
                     if isinstance(cursors, dict)
                     and cursors.get("pendingRevision") == candidate_rev)
    pending_records = sync.load_normalized(root, source_id, candidate_rev)
    pending_by_occ = {r["sourceOccurrenceId"]: r for r in pending_records}

    ambiguity_occs = []
    for ambiguity in proposal["ambiguities"]:
        ambiguity_occs.extend(ambiguity.get("occurrences", []))

    # 歧义与 new 必须有裁决，否则不提交任何内容。
    missing = [occ for occ in ambiguity_occs if occ not in decisions]
    missing += [m["sourceOccurrenceId"] for m in proposal["mappings"]
                if m["classification"] == "new" and m["sourceOccurrenceId"] not in decisions]
    if missing:
        raise DecisionRequired(missing)

    # occId → (requirementId, basis, confidence)；new 裁决延后统一分配编号。
    resolved = {}
    to_allocate = []
    for mapping in proposal["mappings"]:
        occ, classification = mapping["sourceOccurrenceId"], mapping["classification"]
        if classification in ("unchanged", "source-backfill"):
            resolved[occ] = (mapping["requirementId"], "exact-fingerprint", "machine")
        elif classification == "new":
            if decisions[occ] == "new":
                to_allocate.append(occ)
            else:
                resolved[occ] = (decisions[occ], "manual-confirmation", "confirmed")
        # withdrawal-candidate：只提候选，不落裁决、不改生命周期。
    for occ in ambiguity_occs:
        if decisions[occ] == "new":
            to_allocate.append(occ)
        else:
            resolved[occ] = (decisions[occ], "manual-confirmation", "confirmed")

    # 新编号前缀跟随所属 sheet：以同 sheet 已裁决 occurrence 的编号前缀投票，
    # 多前缀工作树（如 SAAS/MBR/PTL 并存）不会把新需求编进别的系统。
    occ_sheet = {}
    for record in pending_records:
        locator = record.get("locator") or {}
        occ_sheet[record["sourceOccurrenceId"]] = (
            locator.get("sheet") if isinstance(locator, dict) else None)
    sheet_votes = {}
    for occ, (requirement_id, _basis, _conf) in resolved.items():
        match = _REQ_ID_RE.match(requirement_id or "")
        sheet = occ_sheet.get(occ)
        if match and sheet:
            votes = sheet_votes.setdefault(sheet, {})
            votes[match.group(1)] = votes.get(match.group(1), 0) + 1

    def _prefix_for(occ):
        votes = sheet_votes.get(occ_sheet.get(occ), {})
        if not votes:
            return None
        return max(sorted(votes), key=lambda p: votes[p])

    existing = set(_existing_ids(ctx))
    by_prefix = {}
    for occ in to_allocate:
        by_prefix.setdefault(_prefix_for(occ), []).append(occ)
    for prefix in sorted(by_prefix, key=lambda p: p or ""):
        occs = by_prefix[prefix]
        new_ids = _allocate_ids(existing, len(occs), prefix=prefix)
        existing.update(new_ids)
        for occ, requirement_id in zip(occs, new_ids):
            resolved[occ] = (requirement_id, "manual-confirmation", "confirmed")

    # 完备性：candidate revision 的每条 occurrence 都获得生效裁决（按 occurrence
    # 出现次序，稳定确定性）。
    records = []
    for index, record in enumerate(pending_records, start=1):
        occ = record["sourceOccurrenceId"]
        if occ not in resolved:
            continue
        requirement_id, basis, confidence = resolved[occ]
        records.append({
            "decisionId": f"MAP-{_rev_slug(candidate_rev)}-{index:04d}",
            "action": "map",
            "sourceOccurrenceId": occ,
            "requirementId": requirement_id,
            "assertionRole": "normative",
            "basis": basis,
            "confidence": confidence,
            "decidedAt": _DECIDED_AT,
            "decidedBy": _DECIDED_BY,
            "supersedes": None,
            "schemaVersion": 1,
        })

    # sync-state：appliedRevision 推进、pending 清空（提交点由 operation 保证）。
    state = read_json(root / SYNC_STATE_RELPATH)
    cursors = state["sources"][source_id]
    cursors["appliedRevision"] = candidate_rev
    cursors["observedRevision"] = candidate_rev
    cursors["pendingRevision"] = None
    plan = [{"path": SYNC_STATE_RELPATH, "action": "write",
             "content": canonical_json_bytes(state)}]

    # 来源回填吸收：被 revision 命中的 applied change 置 absorbed、sustains 转 false，
    # retainedForAudit 恒真——支撑转移到吸收它的 occurrence。
    for mapping in proposal["mappings"]:
        if mapping["classification"] != "source-backfill":
            continue
        text = pending_by_occ[mapping["sourceOccurrenceId"]]["normalizedText"]
        change_id = _find_change(ctx, text, mapping["requirementId"])
        if change_id is None:
            continue
        manifest = dict(ctx["changes"][change_id])
        manifest["status"] = "absorbed"
        manifest["sustainsRequirement"] = False
        manifest["retainedForAudit"] = True
        plan.append({"path": f"{CHANGES_RELDIR}/{change_id}/manifest.json",
                     "action": "write", "content": canonical_json_bytes(manifest)})

    operation_id = f"op-sync-{_rev_slug(candidate_rev)}"
    return _run(root, proposal, operation_id, "sync", plan, records,
                target_source=source_id, target_revision=candidate_rev)


def _find_change(ctx, text, requirement_id):
    for change_id, manifest in ctx["changes"].items():
        if (manifest.get("status") == "applied"
                and manifest.get("normalizedText") == text
                and manifest.get("requirementId") == requirement_id):
            return change_id
    return None


# ---------------------------------------------------------------- 生命周期

def propose_lifecycle(root, requirement_id, lifecycle_action, effective_at=None):
    """生命周期迁移提案。未来 effectiveAt 只保存为 open proposal——不改状态、
    不写 transition；显式 commit_proposal 时状态才生效（§7.3，不读墙钟）。"""
    root = Path(root)
    lifecycle_actions = [{
        "requirementId": requirement_id,
        "scopeId": REQUIREMENT_SCOPE,
        "lifecycleAction": lifecycle_action,
        "effectiveAt": effective_at,
    }]
    proposal_id = f"prop-lc-{requirement_id.lower()}-{lifecycle_action}"
    return engine.build_proposal(
        root, proposal_id=proposal_id, proposal_kind="maintain",
        candidate_revision=None, lifecycle_actions=lifecycle_actions,
        affected_files=[LEDGER_RELPATH], generator_version=_GENERATOR_VERSION)


def _commit_lifecycle(root, proposal):
    ctx = _context(root)
    states = _lifecycle_states(ctx["projection"])
    records = []
    for index, action in enumerate(proposal["lifecycleActions"], start=1):
        requirement_id = action["requirementId"]
        lifecycle_action = action["lifecycleAction"]
        transition_id = f"TRN-{requirement_id}-{index:04d}"
        records.append({
            "decisionId": transition_id,
            "transitionId": transition_id,
            "action": "transition",
            "requirementId": requirement_id,
            "from": states.get(requirement_id, _ACTIVE),
            "to": _TARGET_STATE[lifecycle_action],
            "lifecycleAction": lifecycle_action,
            # effectiveAt 是审计字段：状态在提交时生效，值随记录保存。
            "effectiveAt": action.get("effectiveAt") or _DECIDED_AT,
            "decisionSource": "manual-confirmation",
            "decidedAt": _DECIDED_AT,
            "decidedBy": _DECIDED_BY,
            "supersedes": None,
            "schemaVersion": 1,
        })

    projected_states = dict(states)
    for record in records:
        projected_states[record["requirementId"]] = record["to"]
    plan = [_render_ledger_plan(_existing_ids(ctx), projected_states, _role_map(ctx))]

    operation_id = proposal["proposalId"].replace("prop-", "op-", 1)
    return _run(root, proposal, operation_id, "maintain", plan, records)


# ---------------------------------------------------------------- 来源退休

def propose_source_retirement(root, source_id):
    """退休源提案。retired 唯一语义：不再接受新 revision；最后一次 applied 的
    assertion 默认继续有效，不产生撤回候选。"""
    root = Path(root)
    proposal_id = f"prop-retire-{source_id}"
    return engine.build_proposal(
        root, proposal_id=proposal_id, proposal_kind="maintain",
        candidate_revision=None, affected_files=[REGISTRY_RELPATH],
        generator_version=_GENERATOR_VERSION)


def _commit_retirement(root, proposal):
    source_id = proposal["proposalId"][len("prop-retire-"):]
    registry = _registry(root)
    updated = dict(registry)
    updated["sources"] = [dict(source, status="retired")
                          if source["sourceId"] == source_id else source
                          for source in registry["sources"]]
    plan = [{"path": REGISTRY_RELPATH, "action": "write",
             "content": canonical_json_bytes(updated)}]
    operation_id = f"op-retire-{source_id}"
    return _run(root, proposal, operation_id, "maintain", plan, [])


# ---------------------------------------------------------------- assertion 失效

def propose_assertion_invalidation(root, source_id):
    """批量失效该源 assertion 的提案（不借 registry 状态静默改需求生命周期）。"""
    root = Path(root)
    proposal_id = f"prop-invalidate-{source_id}"
    return engine.build_proposal(
        root, proposal_id=proposal_id, proposal_kind="maintain",
        candidate_revision=None, affected_files=[LEDGER_RELPATH],
        generator_version=_GENERATOR_VERSION)


def _commit_invalidation(root, proposal):
    source_id = proposal["proposalId"][len("prop-invalidate-"):]
    ctx = _context(root)
    records = []
    role_override = {}
    index = 0
    for occ, info in ctx["applied"].items():
        if info["source"] != source_id:
            continue
        current = ctx["mappings"][occ]
        index += 1
        records.append({
            "decisionId": f"MAP-inv-{source_id}-{index:04d}",
            "action": "remap",
            "sourceOccurrenceId": occ,
            "requirementId": current["requirementId"],
            # 角色降为 contextual，编号不变。
            "assertionRole": "contextual",
            "basis": current["basis"],
            "confidence": current["confidence"],
            "decidedAt": _DECIDED_AT,
            "decidedBy": _DECIDED_BY,
            "supersedes": None,
            "schemaVersion": 1,
        })
        role_override[occ] = "contextual"

    plan = [_render_ledger_plan(_existing_ids(ctx), _lifecycle_states(ctx["projection"]),
                                _role_map(ctx, role_override))]
    operation_id = f"op-invalidate-{source_id}"
    return _run(root, proposal, operation_id, "maintain", plan, records)


# ---------------------------------------------------------------- 带外变更登记

def register_change(root, change_id, requirement_id, normalized_text):
    """登记带外变更（change-stream 降级入口）：append-only 注册 change 源、写
    change manifest（applied / sustainsRequirement）、落 change-manifest map 裁决。"""
    root = Path(root)
    slug = change_id.lower()
    occ_hex = hashlib.sha256(
        f"{CHANGE_SOURCE_ID}\x00{change_id}\x00{normalized_text}".encode("utf-8")
    ).hexdigest()[:12]
    occ = f"{CHANGE_SOURCE_ID}@rev-{slug}/occ-{occ_hex}.0"
    decision_id = f"MAP-{slug}-0001"

    manifest = {
        "changeId": change_id,
        "status": "applied",
        "requirementId": requirement_id,
        "normalizedText": normalized_text,
        "retainedForAudit": True,
        "sustainsRequirement": True,
        "decisionId": decision_id,
        "schemaVersion": 1,
    }
    plan = [{"path": f"{CHANGES_RELDIR}/{change_id}/manifest.json",
             "action": "write", "content": canonical_json_bytes(manifest)}]

    # change 源按 append-only 注册（首次时）。
    registry = _registry(root)
    if not any(s["sourceId"] == CHANGE_SOURCE_ID for s in registry["sources"]):
        updated = dict(registry)
        updated["sources"] = registry["sources"] + [{
            "sourceId": CHANGE_SOURCE_ID, "kind": "change-stream", "mode": "append-only",
            "defaultAssertionRole": "normative", "status": "active"}]
        plan.append({"path": REGISTRY_RELPATH, "action": "write",
                     "content": canonical_json_bytes(updated)})

    records = [{
        "decisionId": decision_id,
        "action": "map",
        "sourceOccurrenceId": occ,
        "requirementId": requirement_id,
        "assertionRole": "normative",
        "basis": "change-manifest",
        "confidence": "confirmed",
        "decidedAt": _DECIDED_AT,
        "decidedBy": _DECIDED_BY,
        "supersedes": None,
        "schemaVersion": 1,
    }]

    proposal_id = f"prop-change-{slug}"
    proposal = engine.build_proposal(
        root, proposal_id=proposal_id, proposal_kind="maintain",
        candidate_revision=None,
        affected_files=[entry["path"] for entry in plan],
        generator_version=_GENERATOR_VERSION)
    operation_id = f"op-change-{slug}"
    return _run(root, proposal, operation_id, "maintain", plan, records)
