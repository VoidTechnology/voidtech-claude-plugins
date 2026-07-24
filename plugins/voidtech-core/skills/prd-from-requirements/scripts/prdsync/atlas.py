"""Logic Atlas 确定性编译器与分层内容门（ADR-0005、技术设计 §10/§11 门 5）。

PRD 工作树是写模型，Logic Atlas 是从权威主本确定性编译的只读投影，不建立第二套
权威内容。本模块实现 ADR-0005 的结构与行为两层编译、渲染、发布与新鲜度判定：

- `compile(root)`：消费模块 prd.md 的页面契约、核心流程、边缘状态、业务状态机、
  模块边界、数据读写、模块交互与需求身份读模型（经 requirements-ledger 单一解析
  路径），生成结构与行为两层 Logic Atlas。无法解析的内容如实进 gaps，绝不按产品
  经验补齐；构建前检查读取栅栏，能力未开启抛 AtlasNotEnabled；两次编译逐字节一致。
- `build_plan(root)`：按 stage 产出发布计划（engine plan 条目）；markdown 阶段落
  logic-model.json / logic-atlas.md / manifest.json / validation-report.md 与重建的
  ledger，html/polish 阶段另含自包含 logic-atlas.html。manifest 含三摘要。
- `publish(root)`：经 operation_engine 以 maintain operation 提交 build_plan；模型
  校验失败抛 AtlasValidationError 且零写入（fail closed）。
- `check_freshness(root)`：严格只读，三摘要比对；pending 不参与。
- `gate_requirements(root)`：内容门按阶段（legacy/markdown/html/polish）裁剪步骤。
- `proof_inherits(previous_proof, current_env)`：渲染器验证证明七键继承纯函数。

仅使用 Python 标准库。
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path

from . import base_cas, effective_view, merge
from . import operation_engine as engine
from . import writer_lock
from .canonical_store import (
    canonical_json_bytes,
    file_digest_or_none,
    read_json,
    sha256_of_bytes,
)

GENERATOR_VERSION = "1.4.0"
LOGIC_MODEL_SCHEMA_VERSION = 1

WORKTREE_MANIFEST_RELPATH = "prd-worktree.json"
MATRIX_RELPATH = base_cas.MATRIX_RELPATH
LEDGER_RELPATH = merge.LEDGER_RELPATH

MODEL_RELPATH = "_generated/logic/logic-model.json"
MD_RELPATH = "_generated/logic/logic-atlas.md"
MANIFEST_RELPATH = "_generated/logic/manifest.json"
REPORT_RELPATH = "_generated/logic/validation-report.md"
HTML_RELPATH = "logic-atlas.html"

WORKTREE_SCOPE_ID = "prd-worktree"
_EXCLUDED_TOP = ("_source", "_generated")

# 机器可解析表的定位标记与固定表头（列序不得改动；对齐 templates/module-prd.md）。
_PAGE_MARKER = "页面契约（机器可解析）"
_FLOW_MARKER = "核心流程（机器可解析）"
_DATA_MARKER = "数据读写（机器可解析）"
_PAGE_DATA_MARKER = "页面数据读写（机器可解析）"
_INTERACT_MARKER = "模块交互（机器可解析）"
_PAGE_HEADER = ["页面", "入口", "角色", "前置条件", "用户动作", "系统结果"]
_FLOW_HEADER = ["流程", "步骤ID", "关联页面", "角色", "用户动作/触发", "条件/分支",
                "系统结果", "下一步", "失败处理", "需求编号"]
_IMPACT_MARKER = "流程状态影响（机器可解析）"
_IMPACT_HEADER = ["流程", "步骤ID", "交互ID", "业务对象", "当前状态", "下一状态",
                  "依赖模块/系统", "失败传播", "需求编号"]
_LEGACY_IMPACT_HEADER = ["流程", "步骤ID", "业务对象", "当前状态", "下一状态",
                         "依赖模块/系统", "失败传播", "需求编号"]
_INTERACTION_MARKER = "页面交互（机器可解析）"
_INTERACTION_HEADER = ["流程", "步骤ID", "交互ID", "页面", "容器/状态", "控件",
                       "事件", "可用条件", "即时反馈", "系统动作", "成功结果",
                       "失败与恢复", "下一交互", "需求编号"]
_INTERACTION_EVENTS = {"进入", "点击", "输入", "选择", "提交", "系统触发"}
_INTERACTION_PAGE_STATE_HEADER = [
    "步骤ID", "交互ID", "页面", "状态", "触发条件", "系统行为",
    "用户可执行操作", "验收要点"]
_STEP_PAGE_STATE_HEADER = ["步骤ID", "页面", "状态", "触发条件", "系统行为",
                           "用户可执行操作", "验收要点"]
_PAGE_STATE_HEADER = ["页面", "状态", "触发条件", "系统行为", "用户可执行操作", "验收要点"]
_LEGACY_PAGE_STATE_HEADER = ["状态", "触发条件", "系统行为", "用户可执行操作", "验收要点"]
_BOUNDARY_MARKER = "模块边界"
_BOUNDARY_HEADER = ["边界项", "本模块负责", "不负责", "依赖模块/系统"]
_STATE_MARKER = "状态机与状态流转"
_LOCAL_STATE_HEADER = ["对象", "当前状态", "状态含义", "进入条件", "可执行操作",
                       "下一状态", "是否可逆", "操作人", "通知/日志"]
_STATE_REFERENCE_HEADER_GENERIC = ["对象", "状态机主本", "本端可见状态与操作差异"]
_STATE_REFERENCE_HEADER = ["对象", "状态机主本", "本端(机构后台)可见状态与操作差异"]
_DOMAIN_STATE_PREFIX = ["对象", "当前状态", "进入条件", "可执行操作", "下一状态"]
_DOMAIN_STATE_SUFFIX = ["是否可逆", "通知/日志"]
_DATA_HEADER = ["数据对象", "操作", "权威来源", "同步方式"]
_PAGE_DATA_HEADER = ["流程", "步骤ID", "页面", "数据对象", "操作", "需求编号"]
_INTERACT_HEADER = ["目标模块", "方向", "触发", "失败传播"]
_REQ_ID_RE = re.compile(r"\b[A-Z][A-Z0-9]*-\d+\b")

# 内容门步骤（ADR-0005 §10；阻塞性见 test_gate5_atlas.py docstring）。
_MARKDOWN_STEPS = ["rebuild-ledger", "compile-logic-model", "validate-model",
                   "render-markdown", "write-manifest", "static-check-markdown"]
_HTML_STEPS = ["render-html", "static-check-html"]
_POLISH_STEP = "naturalize-narratives"

# 渲染器验证证明的继承键（ADR-0005 §8）。
_PROOF_INHERIT_KEYS = ("rendererVersion", "generatorVersion", "schemaVersion",
                       "assetDigest", "fixtureDigest", "validationHarnessVersion",
                       "browserMatrixVersion")


class AtlasNotEnabled(Exception):
    """工作树未开启 logicAtlas 能力：Atlas 不适用。"""


class AtlasValidationError(Exception):
    """逻辑模型校验失败（如跨模块交互指向不存在的模块）：fail closed，不写任何文件。"""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__(f"logic model validation failed: {self.errors}")


# ---------------------------------------------------------------- 能力与阶段

def _worktree_manifest(root):
    path = Path(root) / WORKTREE_MANIFEST_RELPATH
    if not path.exists():
        return None
    try:
        return read_json(path)
    except (OSError, ValueError):
        return None


def _atlas_stage(manifest):
    """返回已开启的阶段，未开启返回 None。"""
    if not manifest:
        return None
    if not manifest.get("capabilities", {}).get("logicAtlas"):
        return None
    return manifest.get("logicAtlasStage")


def _require_enabled(root):
    manifest = _worktree_manifest(root)
    stage = _atlas_stage(manifest)
    if stage is None:
        raise AtlasNotEnabled(f"logicAtlas capability not enabled: {root}")
    return stage


# ---------------------------------------------------------------- 机器可解析表解析

def _cells(line):
    inner = line.strip()[1:-1]
    return [cell.strip() for cell in inner.split("|")]


def _is_separator(cells):
    return all(set(cell) <= set("-: ") and "-" in cell for cell in cells)


def _table_after(lines, start):
    """从 start 行起扫描：跳过空行与引用块，返回第一张连续 markdown 表的
    (header, data_rows)；下一个标题前无表返回 (None, [])。"""
    i = start
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith("#"):
            return None, []
        if stripped.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(_cells(lines[i]))
                i += 1
            if not rows:
                return None, []
            header = rows[0]
            data = [row for row in rows[1:] if not _is_separator(row)]
            return header, data
        i += 1
    return None, []


def _find_section_table(text, marker):
    """定位含 marker 的机器可解析章节的表。

    返回 ("absent", None, [])：章节缺失；("ok", header, data)：找到表；
    ("empty", None, [])：章节在但显式写「无」（无表）。"""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#") and marker in line:
            header, data = _table_after(lines, i + 1)
            if header is None:
                return "empty", None, []
            return "ok", header, data
    return "absent", None, []

def _page_state_tables(text):
    """提取各核心路径小节内的「边缘状态」表，保留所属路径标题。"""
    lines = text.splitlines()
    section_title = None
    found = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r"^###\s+\d+(?:\.\d+)+\s+", stripped):
            section_title = re.sub(
                r"^###\s+\d+(?:\.\d+)+\s+", "", stripped).strip()
        if stripped == "**边缘状态**":
            header, rows = _table_after(lines, i + 1)
            found.append((section_title or "未命名流程", header, rows))
    return found

def _all_markdown_tables(text):
    """按文档顺序返回全部 markdown 表。"""
    lines = text.splitlines()
    tables = []
    i = 0
    while i < len(lines):
        if not lines[i].strip().startswith("|"):
            i += 1
            continue
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            rows.append(_cells(lines[i]))
            i += 1
        if rows:
            tables.append((
                rows[0],
                [row for row in rows[1:] if not _is_separator(row)],
            ))
    return tables


def _tables_for_state_reference(text, reference):
    """优先读取 `§x.y` 指向的小节；无节号时退回全文表集合。"""
    match = re.search(r"§\s*(\d+(?:\.\d+)*)", reference)
    if not match:
        return _all_markdown_tables(text)
    section = match.group(1)
    lines = text.splitlines()
    start = None
    level = None
    heading_re = re.compile(
        rf"^(#{{1,6}})\s+{re.escape(section)}(?:\s|$)")
    for index, line in enumerate(lines):
        heading = heading_re.match(line.strip())
        if heading:
            start = index
            level = len(heading.group(1))
            break
    if start is None:
        return []
    end = len(lines)
    for index in range(start + 1, len(lines)):
        heading = re.match(r"^(#{1,6})\s+", lines[index].strip())
        if heading and level is not None and len(heading.group(1)) <= level:
            end = index
            break
    return _all_markdown_tables("\n".join(lines[start:end]))


def _is_domain_state_header(header):
    return (
        len(header) == 8
        and header[:5] == _DOMAIN_STATE_PREFIX
        and header[5].startswith("触发方式")
        and header[6:] == _DOMAIN_STATE_SUFFIX
    )


def _resolve_domain_spec(root, module_scope, reference):
    """把状态机主本引用解析到工作树内文件；拒绝穿越与工作树外路径。"""
    root = Path(root).resolve()
    match = re.search(r"([A-Za-z0-9._/-]+\.md)", reference)
    if match:
        rel = match.group(1)
        candidates = [root / module_scope / rel, root / rel]
    else:
        stem_match = re.search(r"([A-Za-z0-9._/-]+)\s*§", reference)
        if not stem_match:
            return None
        stem = Path(stem_match.group(1)).name
        candidates = [root / "00-global" / "domain-specs" / f"{stem}.md"]
    for candidate in candidates:
        resolved = candidate.resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        if resolved.is_file():
            return resolved
    return None


def _object_matches(reference_name, declared_name):
    normalized = reference_name.replace("（", "(").replace("）", ")")
    parts = [part.strip() for part in re.split(r"[/=()]", normalized) if part.strip()]
    return declared_name == reference_name or declared_name in parts


def _next_states(text):
    value = (text or "").strip()
    if not value or value in {"—", "-", "无"}:
        return []
    return [item.strip() for item in re.split(r"\s*/\s*|、", value)
            if item.strip()]

def _terminal_result(state_name):
    """识别显式「终态」标记；返回 None 表示它仍是普通业务状态。"""
    match = re.match(
        r"^终态(?:\s*[\(（:：]\s*(.*?)[\)）]?\s*)?$",
        (state_name or "").strip())
    return match.group(1).strip() if match and match.group(1) else (
        "" if match else None)
def _declared_items(text):
    """拆分显式列举项；只认列表分隔符，不按自然语言逗号猜测。"""
    value = (text or "").strip()
    if not value:
        return []
    return [
        item.strip()
        for item in re.split(r"\s*(?:/|、|；|;|\n)\s*", value)
        if item.strip()
    ]

def _declared_action_results(text):
    """拆分显式动作，并把箭头两侧保留为动作/结果，不猜测自然语言语义。"""
    pairs = []
    for item in _declared_items(text):
        action_result = re.split(
            r"\s*(?:->|=>|→|⇒)\s*", item, maxsplit=1)
        action = action_result[0].strip()
        result = action_result[1].strip() if len(action_result) == 2 else ""
        if action and (action, result) not in pairs:
            pairs.append((action, result))
    return pairs


def _requirement_summary(text):
    """把规范化需求正文压成可扫描的一句话，不解释或补写业务含义。"""
    value = re.sub(r"[*_`]+", "", text or "")
    value = re.sub(r"\s+", " ", value).strip()
    return value[:160]




def _flow_title_key(title):
    """边缘状态小节标题可带需求号后缀；匹配流程时只去掉该后缀。"""
    return re.sub(r"\([^)]*[A-Z][A-Z0-9]*-\d+[^)]*\)\s*$", "", title).strip()


def _flow_page_titles(text):
    """多页面步骤使用带空格的 ` / ` 分隔，避免误拆页面名内部符号。"""
    return [item.strip() for item in re.split(r"\s+/\s+", text or "")
            if item.strip()]


# ---------------------------------------------------------------- 作用域发现
def _resolve_module_scope(reference, module_scopes):
    if reference in module_scopes:
        return reference
    matches = [
        scope for scope in module_scopes
        if scope.split("/")[-1] == reference
    ]
    return matches[0] if len(matches) == 1 else None



def _module_prds(root):
    """发现全部模块 prd.md：返回 [(module_scope_id, system_scope_id, path)]，
    按 module_scope_id 排序。结构为 <系统>/<模块>/prd.md（排除 _source/_generated）。"""
    root = Path(root)
    found = []
    for path in sorted(root.rglob("prd.md")):
        rel_parts = path.relative_to(root).parts
        if rel_parts[0] in _EXCLUDED_TOP:
            continue
        if len(rel_parts) < 2:
            continue  # 需至少 <目录>/prd.md
        module_scope = "/".join(rel_parts[:-1])
        system_scope = "/".join(rel_parts[:-2]) if len(rel_parts) >= 3 else None
        found.append((module_scope, system_scope, path))
    found.sort(key=lambda item: item[0])
    return found


def _build_page_catalog(module_prds):
    """预索引结构化页面，供前向及跨模块限定引用确定性解析。"""
    catalog = {}
    for module_scope, _system_scope, path in module_prds:
        status, header, rows = _find_section_table(
            path.read_text(encoding="utf-8"), _PAGE_MARKER)
        titles = set()
        if status == "ok" and header == _PAGE_HEADER:
            titles = {
                row[0] for row in rows
                if len(row) >= len(_PAGE_HEADER) and row[0]
            }
        catalog[module_scope] = titles
    return catalog


def _resolve_page_reference(module_scope, reference, module_scopes, page_catalog):
    """解析本模块页面或 `<module-scope>::<页面名>`；不做末段或同名猜测。"""
    if "::" not in reference:
        if reference in page_catalog.get(module_scope, set()):
            return f"page:{module_scope}:{reference}", None
        return None, f"引用未声明页面: {reference}"
    parts = reference.split("::")
    if len(parts) != 2 or not all(part.strip() for part in parts):
        return None, f"页面限定引用格式无效: {reference}"
    target_scope, page_title = (part.strip() for part in parts)
    if target_scope not in module_scopes:
        return None, f"页面限定引用模块不存在: {target_scope}"
    if page_title not in page_catalog.get(target_scope, set()):
        return None, f"跨模块页面未结构化: {target_scope}::{page_title}"
    return f"page:{target_scope}:{page_title}", None


def _first_heading(path):
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip() or path.parent.name
    return path.parent.name


def _build_scopes(module_prds):
    scopes = [{"scopeId": WORKTREE_SCOPE_ID, "kind": "worktree",
               "title": "PRD 工作树", "path": None, "parentScopeId": None}]
    systems = {}
    module_scopes = []
    for module_scope, system_scope, path in module_prds:
        if system_scope and system_scope not in systems:
            systems[system_scope] = {
                "scopeId": system_scope, "kind": "system",
                "title": system_scope.split("/")[-1], "path": system_scope,
                "parentScopeId": WORKTREE_SCOPE_ID}
        module_scopes.append({
            "scopeId": module_scope, "kind": "module",
            "title": _first_heading(path), "path": module_scope,
            "parentScopeId": system_scope or WORKTREE_SCOPE_ID})
    scopes.extend(sorted(systems.values(), key=lambda s: s["scopeId"]))
    scopes.extend(module_scopes)
    return scopes


# ---------------------------------------------------------------- 需求身份读模型

def _ledger_content(root):
    """确定性重建 Requirement Ledger 读模型内容（复用受控合入的投影，单一解析路径）。"""
    ctx = merge._context(root)
    return merge._render_ledger_plan(
        merge._existing_ids(ctx),
        merge._lifecycle_states(ctx["projection"]),
        merge._role_map(ctx))["content"]


def _requirement_nodes(root):
    ctx = merge._context(root)
    states = merge._lifecycle_states(ctx["projection"])
    requirement_ids = merge._existing_ids(ctx)
    candidates = {}
    role_priority = {
        "overriding": 0,
        "normative": 1,
        "corroborating": 2,
        "contextual": 3,
    }
    for occurrence_id, info in ctx["applied"].items():
        text = _requirement_summary(info["text"])
        if not text:
            continue
        candidate = (
            role_priority.get(info["role"], 9),
            info["source"],
            occurrence_id,
            text,
            info["role"],
        )
        candidates.setdefault(info["req"], []).append(candidate)
    for change_id, manifest in ctx["changes"].items():
        if (manifest.get("status") != "applied"
                or not manifest.get("sustainsRequirement")):
            continue
        text = _requirement_summary(manifest.get("normalizedText", ""))
        if not text:
            continue
        candidates.setdefault(manifest["requirementId"], []).append((
            role_priority["normative"],
            merge.CHANGE_SOURCE_ID,
            change_id,
            text,
            "normative",
        ))

    nodes = []
    for req in sorted(requirement_ids):
        state = states.get(req, merge._ACTIVE)
        status = "original" if state == merge._ACTIVE else "adjudicated"
        selected = min(candidates.get(req, []), default=None)
        nodes.append({
            "nodeId": f"req:{req}",
            "kind": "requirement",
            "scopeId": WORKTREE_SCOPE_ID,
            "title": req,
            "status": status,
            "sources": [{"path": MATRIX_RELPATH, "anchor": req,
                         "requirementIds": [req], "oqIds": []}],
            "detail": {
                "state": state,
                "summary": selected[3] if selected else "",
                "assertionRole": selected[4] if selected else None,
                "sourceCount": len(candidates.get(req, [])),
            },
        })
    return nodes


def _module_source(module_scope, anchor):
    return {"path": f"{module_scope}/prd.md", "anchor": anchor,
            "requirementIds": [], "oqIds": []}

def _requirement_ids(text):
    value = text or ""
    ids = set(_REQ_ID_RE.findall(value))
    for prefix, start_text, end_text in re.findall(
            r"\b([A-Z][A-Z0-9]*)-(\d+)~(\d+)\b", value):
        start, end = int(start_text), int(end_text)
        if end < start or end - start > 1000:
            continue
        width = max(len(start_text), len(end_text))
        ids.update(
            f"{prefix}-{number:0{width}d}"
            for number in range(start, end + 1))
    return sorted(ids)


def _source_with_requirements(module_scope, anchor, text=""):
    source = _module_source(module_scope, anchor)
    source["requirementIds"] = _requirement_ids(text)
    return source


def _compile_module(root, module_scope, text, module_scopes, page_catalog,
                    nodes, edges, gaps):
    """解析单模块结构化契约，向 nodes/edges/gaps 追加确定性读模型。"""
    page_titles = {}
    flow_ids_by_title = {}
    flow_keys_by_exact_title = {}
    flow_steps_by_title = {}
    interaction_nodes_by_title = {}
    seen_edge_ids = set()
    business_state_nodes = {}
    external_dependency_nodes = {}

    def _add_edge(edge):
        # 同一逻辑边多行声明时合并来源，绝不产出重复 edgeId。
        if edge["edgeId"] in seen_edge_ids:
            return
        seen_edge_ids.add(edge["edgeId"])
        edges.append(edge)

    def _ensure_business_state(object_name, state_name, sources, detail):
        node_id = f"state:{module_scope}:{object_name}:{state_name}"
        existing = business_state_nodes.get(node_id)
        if existing is None:
            existing = {
                "nodeId": node_id, "kind": "state", "scopeId": module_scope,
                "title": state_name, "status": "original", "sources": sources,
                "detail": {"category": "businessState",
                           "object": object_name, **detail},
            }
            business_state_nodes[node_id] = existing
            nodes.append(existing)
        elif existing["detail"].get("declaredAsTargetOnly"):
            existing["sources"] = sources
            existing["detail"] = {
                "category": "businessState", "object": object_name, **detail}
        return node_id

    def _add_state_row(fields, sources):
        object_name = fields["object"]
        current = fields["current"]
        current_id = _ensure_business_state(
            object_name, current, sources, {
                "meaning": fields.get("meaning", ""),
                "entryCondition": fields.get("entryCondition", ""),
                "actions": fields.get("actions", ""),
                "reversible": fields.get("reversible", ""),
                "actor": fields.get("actor", ""),
                "triggerMode": fields.get("triggerMode", ""),
                "notifications": fields.get("notifications", ""),
                "moduleDifference": fields.get("moduleDifference", ""),
            })
        action_results = (
            _declared_action_results(fields.get("actions", ""))
            or [("", "")])
        for target in _next_states(fields.get("nextState", "")):
            terminal_result = _terminal_result(target)
            if terminal_result is not None:
                current_node = business_state_nodes[current_id]
                current_node["detail"]["declaredTerminal"] = True
                current_node["detail"]["terminalResult"] = terminal_result
                continue
            target_id = _ensure_business_state(
                object_name, target, sources, {"declaredAsTargetOnly": True})
            for action, result in action_results:
                _add_edge({
                    "edgeId": (
                        f"transition:{module_scope}:{object_name}:"
                        f"{current}->{target}:{action}:{result}"),
                    "kind": "transition", "from": current_id, "to": target_id,
                    "status": "original", "sources": sources,
                    "detail": {
                        "condition": fields.get("entryCondition", ""),
                        "action": action,
                        "result": result,
                        "reversible": fields.get("reversible", ""),
                        "actor": fields.get("actor", ""),
                        "triggerMode": fields.get("triggerMode", ""),
                        "notifications": fields.get("notifications", ""),
                        "moduleDifference": fields.get("moduleDifference", ""),
                    }})

    status, header, rows = _find_section_table(text, _PAGE_MARKER)
    if status == "absent":
        gaps.append({"gapId": f"gap:{module_scope}:page-contract",
                     "scopeId": module_scope, "kind": "missing-section",
                     "detail": "模块缺少「页面契约（机器可解析）」章节，页面关系待深化",
                     "backlogRef": None})
    elif status == "ok" and header != _PAGE_HEADER:
        gaps.append({"gapId": f"gap:{module_scope}:page-contract",
                     "scopeId": module_scope, "kind": "unparsed",
                     "detail": f"页面契约表头列序不符，无法机械解析: {header}",
                     "backlogRef": None})
    elif status == "ok":
        source = _module_source(module_scope, _PAGE_MARKER)
        # 真实 PRD 常见「同一页面一行一个动作」——按页面标题合并成一个节点，
        # 动作聚合进 detail.actions，绝不产出重复 nodeId。
        page_nodes = {}
        for row_index, row in enumerate(rows, 1):
            if len(row) < len(_PAGE_HEADER) or not row[0]:
                continue
            title, entry = row[0], row[1]
            node = page_nodes.get(title)
            if node is None:
                node_id = f"page:{module_scope}:{title}"
                page_titles[title] = node_id
                node = {
                    "nodeId": node_id, "kind": "page", "scopeId": module_scope,
                    "title": title, "status": "original", "sources": [source],
                    "detail": {
                        "entry": entry, "role": row[2],
                        "precondition": row[3], "actions": [],
                        "sharedResults": [],
                    },
                }
                page_nodes[title] = node
                nodes.append(node)
            declared_actions = _declared_items(row[4]) or [row[4]]
            if len(declared_actions) == 1:
                node["detail"]["actions"].append({
                    "action": declared_actions[0], "result": row[5]})
                continue
            node["detail"]["actions"].extend(
                {"action": action, "result": None}
                for action in declared_actions)
            if row[5] and row[5] not in node["detail"]["sharedResults"]:
                node["detail"]["sharedResults"].append(row[5])
            gaps.append({
                "gapId": (
                    f"gap:{module_scope}:page-contract:{title}:"
                    f"{row_index}:action-result"),
                "scopeId": module_scope, "kind": "ambiguous-relation",
                "detail": (
                    f"页面「{title}」{len(declared_actions)} 个动作共用 "
                    "1 个结果，无法确定逐项动作→结果映射"),
                "backlogRef": None})
        # 页面导航：入口列匹配同模块已声明页面时，建立 navigates 边。
        for row in rows:
            if len(row) < 2 or not row[0]:
                continue
            title, entry = row[0], row[1]
            if entry in page_titles and page_titles[entry] != page_titles.get(title):
                _add_edge({
                    "edgeId": f"nav:{module_scope}:{entry}->{title}",
                    "kind": "navigates", "from": page_titles[entry],
                    "to": page_titles[title], "status": "original",
                    "sources": [source], "detail": None})

    status, header, rows = _find_section_table(text, _FLOW_MARKER)
    if status == "absent":
        gaps.append({"gapId": f"gap:{module_scope}:core-flow",
                     "scopeId": module_scope, "kind": "missing-section",
                     "detail": "模块缺少「核心流程（机器可解析）」章节，页面跳转与分支待深化",
                     "backlogRef": None})
    elif status == "ok" and header != _FLOW_HEADER:
        gaps.append({"gapId": f"gap:{module_scope}:core-flow",
                     "scopeId": module_scope, "kind": "unparsed",
                     "detail": f"核心流程表头列序不符，无法机械解析: {header}",
                     "backlogRef": None})
    elif status == "ok":
        flow_source = _module_source(module_scope, _FLOW_MARKER)
        flow_rows = {}
        for row in rows:
            if len(row) < len(_FLOW_HEADER) or not row[0] or not row[1]:
                continue
            flow_title, step_id = row[0], row[1]
            flow_rows.setdefault(flow_title, [])
            if any(existing[1] == step_id for existing in flow_rows[flow_title]):
                gaps.append({
                    "gapId": f"gap:{module_scope}:flow:{flow_title}:duplicate:{step_id}",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": f"流程「{flow_title}」步骤ID重复: {step_id}",
                    "backlogRef": None})
                continue
            flow_rows[flow_title].append(row)

        for flow_title, declared_steps in flow_rows.items():
            flow_id = f"flow:{module_scope}:{flow_title}"
            flow_ids_by_title[_flow_title_key(flow_title)] = flow_id
            flow_keys_by_exact_title[flow_title] = _flow_title_key(flow_title)
            nodes.append({
                "nodeId": flow_id, "kind": "flow", "scopeId": module_scope,
                "title": flow_title, "status": "original", "sources": [flow_source],
                "detail": {"category": "userFlow",
                           "stepCount": len(declared_steps)}})
            step_nodes = {}
            flow_steps_by_title[_flow_title_key(flow_title)] = step_nodes
            for row in declared_steps:
                step_id, page_title = row[1], row[2]
                referenced_pages = _flow_page_titles(page_title)
                page_resolutions = [
                    _resolve_page_reference(
                        module_scope, title, module_scopes, page_catalog)
                    for title in referenced_pages
                ]
                referenced_page_ids = [
                    page_id for page_id, _error in page_resolutions if page_id
                ]
                node_id = f"flowstep:{module_scope}:{flow_title}:{step_id}"
                source = _source_with_requirements(
                    module_scope, _FLOW_MARKER, row[9])
                step_nodes[step_id] = node_id
                nodes.append({
                    "nodeId": node_id, "kind": "flow", "scopeId": module_scope,
                    "title": f"{step_id} · {row[4]}", "status": "original",
                    "sources": [source],
                    "detail": {
                        "category": "flowStep", "flowId": flow_id,
                        "stepId": step_id, "pageTitle": page_title,
                        "pageId": (
                            referenced_page_ids[0]
                            if len(referenced_page_ids) == 1 else None),
                        "pageIds": referenced_page_ids,
                        "role": row[3], "action": row[4],
                        "condition": row[5], "result": row[6],
                        "nextStep": row[7], "failureHandling": row[8],
                    }})
                for page_index, (referenced_title, resolution) in enumerate(
                        zip(referenced_pages, page_resolutions)):
                    referenced_id, page_error = resolution
                    if referenced_id:
                        _add_edge({
                            "edgeId": f"trace:{node_id}:page:{page_index}",
                            "kind": "traces", "from": node_id,
                            "to": referenced_id, "status": "original",
                            "sources": [source],
                            "detail": {"relation": "flow-step-page"}})
                    else:
                        gaps.append({
                            "gapId": (
                                f"gap:{module_scope}:flow:{flow_title}:"
                                f"{step_id}:page:{page_index}"),
                            "scopeId": module_scope, "kind": "missing-source",
                            "detail": (
                                f"流程「{flow_title}」步骤 {step_id} "
                                f"{page_error}"),
                            "backlogRef": None})

            first_step_id = declared_steps[0][1]
            _add_edge({
                "edgeId": f"nav:{flow_id}:entry",
                "kind": "navigates", "from": flow_id,
                "to": step_nodes[first_step_id], "status": "original",
                "sources": [flow_source], "detail": {"branch": "entry"}})
            terminal_id = f"flowterminal:{module_scope}:{flow_title}"
            has_terminal = any(
                row[7].strip().lower() in {"结束", "终止", "完成", "end"}
                for row in declared_steps)
            if has_terminal:
                nodes.append({
                    "nodeId": terminal_id, "kind": "flow", "scopeId": module_scope,
                    "title": "结束", "status": "original",
                    "sources": [flow_source],
                    "detail": {"category": "terminal", "flowId": flow_id}})

            for row in declared_steps:
                step_id, next_step, failure = row[1], row[7].strip(), row[8].strip()
                source = _source_with_requirements(
                    module_scope, _FLOW_MARKER, row[9])
                if next_step in step_nodes:
                    target = step_nodes[next_step]
                elif next_step.lower() in {"结束", "终止", "完成", "end"}:
                    target = terminal_id
                else:
                    target = None
                    gaps.append({
                        "gapId": f"gap:{module_scope}:flow:{flow_title}:{step_id}:next",
                        "scopeId": module_scope, "kind": "missing-source",
                        "detail": f"流程「{flow_title}」步骤 {step_id} 的下一步不存在: {next_step}",
                        "backlogRef": None})
                if target:
                    _add_edge({
                        "edgeId": f"nav:{step_nodes[step_id]}:success",
                        "kind": "navigates", "from": step_nodes[step_id],
                        "to": target, "status": "original", "sources": [source],
                        "detail": {"branch": "success", "condition": row[5]}})
                if failure and failure not in {"无", "—", "-"}:
                    failure_id = f"flowfailure:{module_scope}:{flow_title}:{step_id}"
                    nodes.append({
                        "nodeId": failure_id, "kind": "flow",
                        "scopeId": module_scope, "title": failure,
                        "status": "original", "sources": [source],
                        "detail": {"category": "failureBranch",
                                   "flowId": flow_id, "stepId": step_id,
                                   "handling": failure}})
                    _add_edge({
                        "edgeId": f"nav:{step_nodes[step_id]}:failure",
                        "kind": "navigates", "from": step_nodes[step_id],
                        "to": failure_id, "status": "original",
                        "sources": [source],
                        "detail": {"branch": "failure"}})
    interaction_status, interaction_header, interaction_rows = (
        _find_section_table(text, _INTERACTION_MARKER))
    if (interaction_status == "ok"
            and interaction_header != _INTERACTION_HEADER):
        gaps.append({
            "gapId": f"gap:{module_scope}:page-interactions",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": (
                "页面交互表头列序不符，无法机械解析: "
                f"{interaction_header}"),
            "backlogRef": None})
    elif interaction_status == "ok":
        interaction_groups = {}
        for row_index, row in enumerate(interaction_rows, 1):
            if (len(row) < len(_INTERACTION_HEADER)
                    or not row[0] or not row[1] or not row[2]):
                continue
            flow_title, step_id, interaction_id = row[:3]
            flow_key = flow_keys_by_exact_title.get(flow_title)
            flow_id = flow_ids_by_title.get(flow_key)
            step_node_id = flow_steps_by_title.get(flow_key, {}).get(step_id)
            gap_prefix = (
                f"gap:{module_scope}:interaction:{flow_title}:"
                f"{step_id}:{row_index}")
            if not flow_id:
                gaps.append({
                    "gapId": f"{gap_prefix}:flow",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": f"页面交互引用不存在流程: {flow_title}",
                    "backlogRef": None})
                continue
            if not step_node_id:
                gaps.append({
                    "gapId": f"{gap_prefix}:step",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": f"页面交互引用不存在步骤: {step_id}"
                              f"（流程: {flow_title}）",
                    "backlogRef": None})
                continue
            group_key = (flow_key, step_id)
            group = interaction_groups.setdefault(group_key, {})
            if interaction_id in group:
                gaps.append({
                    "gapId": f"{gap_prefix}:duplicate:{interaction_id}",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": (
                        f"流程「{flow_title}」步骤 {step_id} "
                        f"交互ID重复: {interaction_id}"),
                    "backlogRef": None})
                continue
            event = row[6]
            if event not in _INTERACTION_EVENTS:
                gaps.append({
                    "gapId": f"{gap_prefix}:event",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": f"页面交互事件不受支持: {event}",
                    "backlogRef": None})
            page_id, page_error = _resolve_page_reference(
                module_scope, row[3], module_scopes, page_catalog)
            if page_error:
                gaps.append({
                    "gapId": f"{gap_prefix}:page",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程「{flow_title}」步骤 {step_id} "
                        f"页面交互{page_error}"),
                    "backlogRef": None})
            source = _source_with_requirements(
                module_scope, _INTERACTION_MARKER, row[13])
            node_id = (
                f"interaction:{module_scope}:{flow_title}:"
                f"{step_id}:{interaction_id}")
            node = {
                "nodeId": node_id, "kind": "flow",
                "scopeId": module_scope,
                "title": f"{interaction_id} · {event} {row[5]}",
                "status": "original", "sources": [source],
                "detail": {
                    "category": "interactionStep",
                    "flowTitle": flow_title, "flowId": flow_id,
                    "stepId": step_id, "stepNodeId": step_node_id,
                    "interactionId": interaction_id,
                    "pageTitle": row[3], "pageId": page_id,
                    "containerState": row[4], "control": row[5],
                    "event": event, "availability": row[7],
                    "immediateFeedback": row[8], "systemAction": row[9],
                    "successResult": row[10],
                    "failureRecovery": row[11],
                    "nextInteraction": row[12],
                    "requirements": row[13], "entry": False,
                }}
            nodes.append(node)
            group[interaction_id] = {
                "node": node, "source": source, "next": row[12].strip(),
                "flowTitle": flow_title, "stepId": step_id,
            }
            interaction_nodes_by_title.setdefault(
                flow_key, {}).setdefault(step_id, {})[interaction_id] = node_id
            _add_edge({
                "edgeId": f"trace:{node_id}:step",
                "kind": "traces", "from": node_id, "to": step_node_id,
                "status": "original", "sources": [source],
                "detail": {"relation": "interaction-step"}})
            if page_id:
                _add_edge({
                    "edgeId": f"trace:{node_id}:page",
                    "kind": "traces", "from": node_id, "to": page_id,
                    "status": "original", "sources": [source],
                    "detail": {"relation": "interaction-page"}})

        for (_flow_key, _step_id), group in interaction_groups.items():
            records = list(group.values())
            flow_title = records[0]["flowTitle"]
            step_id = records[0]["stepId"]
            graph_gap_prefix = (
                f"gap:{module_scope}:interaction-graph:"
                f"{flow_title}:{step_id}")
            incoming = set()
            for interaction_id, record in group.items():
                next_interaction = record["next"]
                if next_interaction == "结束":
                    continue
                if next_interaction not in group:
                    gaps.append({
                        "gapId": (
                            f"{graph_gap_prefix}:{interaction_id}:next"),
                        "scopeId": module_scope, "kind": "missing-source",
                        "detail": (
                            f"流程「{flow_title}」步骤 {step_id} "
                            f"交互 {interaction_id} 的下一交互不存在: "
                            f"{next_interaction}"),
                        "backlogRef": None})
                    continue
                incoming.add(next_interaction)
                target = group[next_interaction]["node"]["nodeId"]
                _add_edge({
                    "edgeId": (
                        f"nav:{record['node']['nodeId']}:"
                        "interaction-success"),
                    "kind": "navigates",
                    "from": record["node"]["nodeId"], "to": target,
                    "status": "original", "sources": [record["source"]],
                    "detail": {"relation": "interaction-success"}})
            entries = [
                interaction_id for interaction_id in group
                if interaction_id not in incoming
            ]
            if len(entries) == 1:
                group[entries[0]]["node"]["detail"]["entry"] = True
            else:
                gaps.append({
                    "gapId": f"{graph_gap_prefix}:entry",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": (
                        f"流程「{flow_title}」步骤 {step_id} "
                        f"页面交互必须恰有一个入口，实际为 {len(entries)}"),
                    "backlogRef": None})

            reaches_end = {}
            cyclic = set()
            for start in group:
                path = []
                positions = {}
                current = start
                result = False
                while current in group:
                    if current in reaches_end:
                        result = reaches_end[current]
                        break
                    if current in positions:
                        cyclic.update(path[positions[current]:])
                        break
                    positions[current] = len(path)
                    path.append(current)
                    next_interaction = group[current]["next"]
                    if next_interaction == "结束":
                        result = True
                        break
                    if next_interaction not in group:
                        break
                    current = next_interaction
                for interaction_id in path:
                    reaches_end[interaction_id] = result
            if cyclic:
                gaps.append({
                    "gapId": f"{graph_gap_prefix}:cycle",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": (
                        f"流程「{flow_title}」步骤 {step_id} "
                        "页面交互成功链存在循环: "
                        f"{', '.join(sorted(cyclic))}"),
                    "backlogRef": None})
            nonterminal = sorted(
                interaction_id for interaction_id in group
                if not reaches_end.get(interaction_id, False))
            if nonterminal:
                gaps.append({
                    "gapId": f"{graph_gap_prefix}:termination",
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": (
                        f"流程「{flow_title}」步骤 {step_id} "
                        "页面交互无法到达结束: "
                        f"{', '.join(nonterminal)}"),
                    "backlogRef": None})
    page_state_tables = _page_state_tables(text)
    if not page_state_tables:
        gaps.append({
            "gapId": f"gap:{module_scope}:page-states",
            "scopeId": module_scope, "kind": "missing-section",
            "detail": "模块缺少核心路径「边缘状态」表，加载/空态/异常恢复待深化",
            "backlogRef": None})
    for flow_title, state_header, state_rows in page_state_tables:
        if state_header not in (
                _INTERACTION_PAGE_STATE_HEADER, _STEP_PAGE_STATE_HEADER,
                _PAGE_STATE_HEADER, _LEGACY_PAGE_STATE_HEADER):
            gaps.append({
                "gapId": f"gap:{module_scope}:page-states:{flow_title}",
                "scopeId": module_scope, "kind": "unparsed",
                "detail": f"流程「{flow_title}」边缘状态表头列序不符: {state_header}",
                "backlogRef": None})
            continue
        has_interaction = state_header == _INTERACTION_PAGE_STATE_HEADER
        has_step = state_header in (
            _INTERACTION_PAGE_STATE_HEADER, _STEP_PAGE_STATE_HEADER)
        explicit_page = state_header in (
            _INTERACTION_PAGE_STATE_HEADER, _STEP_PAGE_STATE_HEADER,
            _PAGE_STATE_HEADER)
        flow_key = _flow_title_key(flow_title)
        flow_id = flow_ids_by_title.get(flow_key)
        for row_index, row in enumerate(state_rows, 1):
            if len(row) < len(state_header):
                continue
            step_id = row[0] if has_step else None
            interaction_id = row[1] if has_interaction else None
            if has_interaction:
                page_column, offset = 2, 3
            elif has_step:
                page_column, offset = 1, 2
            elif explicit_page:
                page_column, offset = 0, 1
            else:
                page_column, offset = None, 0
            page_title = row[page_column] if page_column is not None else None
            referenced_pages = _flow_page_titles(page_title) if page_title else []
            page_resolutions = [
                _resolve_page_reference(
                    module_scope, title, module_scopes, page_catalog)
                for title in referenced_pages
            ]
            referenced_page_ids = [
                page_id for page_id, _error in page_resolutions if page_id
            ]
            step_node_id = (
                flow_steps_by_title.get(flow_key, {}).get(step_id)
                if step_id else None)
            interaction_node_id = (
                interaction_nodes_by_title
                .get(flow_key, {}).get(step_id, {}).get(interaction_id)
                if interaction_id else None)
            state_title = row[offset]
            if not state_title:
                continue
            trigger = row[offset + 1]
            source = _source_with_requirements(
                module_scope, f"{flow_title} / 边缘状态", " ".join(row))
            page_state_id = (
                f"pagestate:{module_scope}:{flow_title}:"
                f"{step_id or 'flow'}:{page_title or 'flow'}:"
                f"{state_title}:{row_index}")
            nodes.append({
                "nodeId": page_state_id, "kind": "state",
                "scopeId": module_scope, "title": state_title,
                "status": "original", "sources": [source],
                "detail": {
                    "category": "pageState", "flowTitle": flow_title,
                    "flowId": flow_id, "stepId": step_id,
                    "stepNodeId": step_node_id,
                    "interactionId": interaction_id,
                    "interactionNodeId": interaction_node_id,
                    "pageTitle": page_title,
                    "pageId": (
                        referenced_page_ids[0]
                        if len(referenced_page_ids) == 1 else None),
                    "pageIds": referenced_page_ids,
                    "trigger": trigger, "systemBehavior": row[offset + 2],
                    "userAction": row[offset + 3],
                    "acceptance": row[offset + 4],
                }})
            if flow_id:
                _add_edge({
                    "edgeId": f"trace:{page_state_id}:flow",
                    "kind": "traces", "from": page_state_id, "to": flow_id,
                    "status": "original", "sources": [source],
                    "detail": {"relation": "page-state-flow"}})
            if step_id and step_node_id:
                _add_edge({
                    "edgeId": f"trace:{page_state_id}:step",
                    "kind": "traces", "from": page_state_id,
                    "to": step_node_id, "status": "original",
                    "sources": [source],
                    "detail": {"relation": "page-state-step"}})
            elif step_id:
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:page-state:{flow_title}:"
                        f"{row_index}:step"),
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程「{flow_title}」边缘状态引用不存在步骤: "
                        f"{step_id}"),
                    "backlogRef": None})
            if interaction_id and interaction_node_id:
                _add_edge({
                    "edgeId": f"trace:{page_state_id}:interaction",
                    "kind": "traces", "from": page_state_id,
                    "to": interaction_node_id, "status": "original",
                    "sources": [source],
                    "detail": {"relation": "page-state-interaction"}})
            elif interaction_id:
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:page-state:{flow_title}:"
                        f"{row_index}:interaction"),
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程「{flow_title}」边缘状态引用不存在交互: "
                        f"{interaction_id}（步骤: {step_id}）"),
                    "backlogRef": None})
            for page_index, (referenced_title, resolution) in enumerate(
                    zip(referenced_pages, page_resolutions)):
                referenced_id, page_error = resolution
                if referenced_id:
                    _add_edge({
                        "edgeId": f"trace:{page_state_id}:page:{page_index}",
                        "kind": "traces", "from": page_state_id,
                        "to": referenced_id, "status": "original",
                        "sources": [source],
                        "detail": {"relation": "page-state"}})
                else:
                    gaps.append({
                        "gapId": (
                            f"gap:{module_scope}:page-state:{flow_title}:"
                            f"{row_index}:page:{page_index}"),
                        "scopeId": module_scope, "kind": "missing-source",
                        "detail": (
                            f"流程「{flow_title}」边缘状态{page_error}"),
                        "backlogRef": None})
    boundary_status, boundary_header, boundary_rows = _find_section_table(
        text, _BOUNDARY_MARKER)
    if boundary_status == "absent":
        gaps.append({
            "gapId": f"gap:{module_scope}:boundaries",
            "scopeId": module_scope, "kind": "missing-section",
            "detail": "模块缺少「模块边界」章节，职责与依赖边界待深化",
            "backlogRef": None})
    elif boundary_status == "ok" and boundary_header != _BOUNDARY_HEADER:
        gaps.append({
            "gapId": f"gap:{module_scope}:boundaries",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": f"模块边界表头列序不符，无法机械解析: {boundary_header}",
            "backlogRef": None})
    elif boundary_status == "ok":
        for row in boundary_rows:
            if len(row) < len(_BOUNDARY_HEADER) or not row[0]:
                continue
            source = _source_with_requirements(
                module_scope, _BOUNDARY_MARKER, " ".join(row))
            nodes.append({
                "nodeId": f"boundary:{module_scope}:{row[0]}",
                "kind": "flow", "scopeId": module_scope, "title": row[0],
                "status": "original", "sources": [source],
                "detail": {
                    "category": "boundary", "responsibility": row[1],
                    "excluded": row[2], "dependency": row[3],
                }})

    state_status, state_header, state_rows = _find_section_table(
        text, _STATE_MARKER)
    if state_status == "absent":
        gaps.append({
            "gapId": f"gap:{module_scope}:business-states",
            "scopeId": module_scope, "kind": "missing-section",
            "detail": "模块缺少「状态机与状态流转」章节，业务生命周期待深化",
            "backlogRef": None})
    elif state_status == "ok" and state_header == _LOCAL_STATE_HEADER:
        for row in state_rows:
            if len(row) < len(_LOCAL_STATE_HEADER) or not row[0] or not row[1]:
                continue
            source = _source_with_requirements(
                module_scope, _STATE_MARKER, " ".join(row))
            _add_state_row({
                "object": row[0], "current": row[1], "meaning": row[2],
                "entryCondition": row[3], "actions": row[4],
                "nextState": row[5], "reversible": row[6],
                "actor": row[7], "notifications": row[8],
            }, [source])
    elif (state_status == "ok"
          and state_header in (
              _STATE_REFERENCE_HEADER, _STATE_REFERENCE_HEADER_GENERIC)):
        assert state_header is not None
        for reference_index, row in enumerate(state_rows, 1):
            if len(row) < len(state_header) or not row[0] or not row[1]:
                continue
            spec_path = _resolve_domain_spec(root, module_scope, row[1])
            if spec_path is None:
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:business-state-reference:"
                        f"{reference_index}"),
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": f"状态机主本无法解析或不在工作树内: {row[1]}",
                    "backlogRef": None})
                continue
            relpath = spec_path.relative_to(Path(root).resolve()).as_posix()
            module_source = _source_with_requirements(
                module_scope, _STATE_MARKER, row[2])
            spec_text = spec_path.read_text(encoding="utf-8")
            state_tables = [
                (domain_header, domain_rows)
                for domain_header, domain_rows
                in _tables_for_state_reference(spec_text, row[1])
                if _is_domain_state_header(domain_header)
            ]
            matched_rows = [
                domain_row
                for _domain_header, domain_rows in state_tables
                for domain_row in domain_rows
                if len(domain_row) >= 8
                and _object_matches(row[0], domain_row[0])
            ]
            alias_fallback = not matched_rows and len(state_tables) == 1
            if alias_fallback:
                matched_rows = [
                    domain_row for domain_row in state_tables[0][1]
                    if len(domain_row) >= 8
                ]
            for domain_row in matched_rows:
                domain_source = {
                    "path": relpath, "anchor": row[1],
                    "requirementIds": _requirement_ids(" ".join(domain_row)),
                    "oqIds": [],
                }
                _add_state_row({
                    "object": row[0] if alias_fallback else domain_row[0],
                    "current": domain_row[1],
                    "entryCondition": domain_row[2],
                    "actions": domain_row[3], "nextState": domain_row[4],
                    "triggerMode": domain_row[5],
                    "reversible": domain_row[6],
                    "notifications": domain_row[7],
                    "moduleDifference": row[2],
                }, [domain_source, module_source])
            matched = bool(matched_rows)
            if not matched:
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:business-state-object:"
                        f"{reference_index}"),
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"状态机主本 {relpath} 未找到对象「{row[0]}」的状态表"),
                    "backlogRef": None})
    elif state_status == "ok":
        gaps.append({
            "gapId": f"gap:{module_scope}:business-states",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": f"状态机表头列序不符，无法机械解析: {state_header}",
            "backlogRef": None})
    for state_node in business_state_nodes.values():
        if not state_node["detail"].get("declaredAsTargetOnly"):
            continue
        state_detail = state_node["detail"]
        gaps.append({
            "gapId": f"gap:{state_node['nodeId']}:outgoing-transition",
            "scopeId": module_scope, "kind": "missing-transition",
            "detail": (
                f"{state_detail['object']}状态「{state_node['title']}」"
                "仅作为下一状态出现，未声明后续流转或明确终态；"
                "不能据此判定生命周期已结束"),
            "backlogRef": None})

    impact_status, impact_header, impact_rows = _find_section_table(
        text, _IMPACT_MARKER)
    if impact_status == "absent" and flow_ids_by_title:
        gaps.append({
            "gapId": f"gap:{module_scope}:state-impacts",
            "scopeId": module_scope, "kind": "missing-section",
            "detail": "模块缺少「流程状态影响（机器可解析）」表，流程步骤与业务状态变化尚未关联",
            "backlogRef": None})
    elif (impact_status == "ok"
          and impact_header not in (_IMPACT_HEADER, _LEGACY_IMPACT_HEADER)):
        gaps.append({
            "gapId": f"gap:{module_scope}:state-impacts",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": f"流程状态影响表头列序不符，无法机械解析: {impact_header}",
            "backlogRef": None})
    elif impact_status == "ok":
        assert impact_header is not None
        for row_index, row in enumerate(impact_rows, 1):
            if len(row) < len(impact_header) or not row[0] or not row[1]:
                continue
            if impact_header == _IMPACT_HEADER:
                (flow_title, step_id, interaction_id, object_name,
                 current_state, next_state, dependency, failure,
                 requirements) = row[:9]
            else:
                (flow_title, step_id, object_name, current_state,
                 next_state, dependency, failure, requirements) = row[:8]
                interaction_id = None
            flow_key = _flow_title_key(flow_title)
            flow_id = flow_ids_by_title.get(flow_key)
            step_node_id = flow_steps_by_title.get(flow_key, {}).get(step_id)
            interaction_node_id = (
                interaction_nodes_by_title
                .get(flow_key, {}).get(step_id, {}).get(interaction_id)
                if interaction_id else None)
            gap_prefix = (
                f"gap:{module_scope}:state-impact:{flow_title}:{row_index}")
            if not flow_id or not step_node_id:
                gaps.append({
                    "gapId": f"{gap_prefix}:step",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程状态影响引用不存在步骤: {step_id}"
                        f"（流程: {flow_title}）"),
                    "backlogRef": None})
                continue
            if interaction_id and not interaction_node_id:
                gaps.append({
                    "gapId": f"{gap_prefix}:interaction",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程状态影响引用不存在交互: {interaction_id}"
                        f"（流程: {flow_title}，步骤: {step_id}）"),
                    "backlogRef": None})
            from_state_id = (
                f"state:{module_scope}:{object_name}:{current_state}")
            to_state_id = f"state:{module_scope}:{object_name}:{next_state}"
            transition = next((
                edge for edge in edges
                if edge["kind"] == "transition"
                and edge["from"] == from_state_id
                and edge["to"] == to_state_id
            ), None)
            if transition is None:
                gaps.append({
                    "gapId": f"{gap_prefix}:transition",
                    "scopeId": module_scope, "kind": "missing-source",
                    "detail": (
                        f"流程状态影响未找到状态流转: {object_name} "
                        f"{current_state} → {next_state}"),
                    "backlogRef": None})
                continue
            source = _source_with_requirements(
                module_scope, _IMPACT_MARKER, " ".join(row))
            impact_id = (
                f"stateimpact:{module_scope}:{flow_title}:{step_id}:"
                f"{object_name}:{current_state}->{next_state}:{row_index}")
            dependency_id = None
            dependency_scope_id = None
            if dependency not in {"", "无", "—", "-"}:
                external_match = re.match(
                    r"^(?:external|外部)\s*[:：]\s*(.+)$",
                    dependency, re.IGNORECASE)
                if external_match:
                    external_name = external_match.group(1).strip()
                    dependency_id = (
                        f"external:{module_scope}:{external_name}")
                    dependency_scope_id = dependency_id
                    if dependency_id not in external_dependency_nodes:
                        external_dependency_nodes[dependency_id] = True
                        nodes.append({
                            "nodeId": dependency_id, "kind": "flow",
                            "scopeId": module_scope, "title": external_name,
                            "status": "original", "sources": [source],
                            "detail": {"category": "externalDependency"},
                        })
                else:
                    dependency_scope_id = _resolve_module_scope(
                        dependency, module_scopes)
                    dependency_id = dependency_scope_id
                    if dependency_scope_id is None:
                        gaps.append({
                            "gapId": f"{gap_prefix}:dependency",
                            "scopeId": module_scope,
                            "kind": "missing-source",
                            "detail": (
                                f"流程状态影响依赖模块不存在: {dependency}"),
                            "backlogRef": None})
            nodes.append({
                "nodeId": impact_id, "kind": "flow",
                "scopeId": module_scope,
                "title": f"{object_name}: {current_state} → {next_state}",
                "status": "original", "sources": [source],
                "detail": {
                    "category": "stateImpact", "flowTitle": flow_title,
                    "flowId": flow_id, "stepId": step_id,
                    "stepNodeId": step_node_id, "object": object_name,
                    "interactionId": interaction_id,
                    "interactionNodeId": interaction_node_id,
                    "currentState": current_state, "nextState": next_state,
                    "fromStateId": from_state_id, "toStateId": to_state_id,
                    "transitionEdgeId": transition["edgeId"],
                    "dependency": dependency,
                    "dependencyScopeId": dependency_scope_id,
                    "failurePropagation": failure,
                }})
            for suffix, target, relation in (
                    ("step", step_node_id, "state-impact-step"),
                    ("from", from_state_id, "state-impact-from"),
                    ("to", to_state_id, "state-impact-to")):
                _add_edge({
                    "edgeId": f"trace:{impact_id}:{suffix}",
                    "kind": "traces", "from": impact_id, "to": target,
                    "status": "original", "sources": [source],
                    "detail": {"relation": relation}})
            if interaction_node_id:
                _add_edge({
                    "edgeId": f"trace:{impact_id}:interaction",
                    "kind": "traces", "from": impact_id,
                    "to": interaction_node_id, "status": "original",
                    "sources": [source],
                    "detail": {"relation": "state-impact-interaction"}})
            if dependency_id:
                _add_edge({
                    "edgeId": f"interaction:{impact_id}:{dependency_id}",
                    "kind": "interacts", "from": impact_id,
                    "to": dependency_id, "status": "original",
                    "sources": [source],
                    "detail": {
                        "relation": "state-impact-dependency",
                        "direction": "依赖", "trigger": flow_title,
                        "failurePropagation": failure,
                    }})

    seen_objects = {}
    data_contracts = {}
    status, header, rows = _find_section_table(text, _DATA_MARKER)
    if status == "absent":
        gaps.append({
            "gapId": f"gap:{module_scope}:data-rw",
            "scopeId": module_scope, "kind": "missing-section",
            "detail": "模块缺少「数据读写（机器可解析）」章节，数据流待深化",
            "backlogRef": None})
    elif status == "ok" and header != _DATA_HEADER:
        gaps.append({
            "gapId": f"gap:{module_scope}:data-rw",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": f"数据读写表头列序不符，无法机械解析: {header}",
            "backlogRef": None})
    elif status == "ok":
        source = _module_source(module_scope, _DATA_MARKER)
        for row in rows:
            if len(row) < len(_DATA_HEADER) or not row[0]:
                continue
            obj, op, authority, sync_mode = row[0], row[1], row[2], row[3]
            obj_id = f"obj:{module_scope}:{obj}"
            if obj_id not in seen_objects:
                seen_objects[obj_id] = True
                nodes.append({
                    "nodeId": obj_id, "kind": "dataObject",
                    "scopeId": module_scope, "title": obj,
                    "status": "original", "sources": [source],
                    "detail": {"authoritativeSource": authority}})
            kinds = [
                kind for marker, kind in (("读", "reads"), ("写", "writes"))
                if marker in op]
            for kind in kinds:
                detail = {
                    "authoritativeSource": authority,
                    "syncMethod": sync_mode}
                data_contracts[(obj_id, kind)] = detail
                _add_edge({
                    "edgeId": f"{kind}:{module_scope}:{obj}",
                    "kind": kind, "from": module_scope, "to": obj_id,
                    "status": "original", "sources": [source],
                    "detail": detail})

    mapping_status, mapping_header, mapping_rows = _find_section_table(
        text, _PAGE_DATA_MARKER)
    if page_titles and seen_objects and mapping_status == "absent":
        gaps.append({
            "gapId": f"gap:{module_scope}:page-data-rw",
            "scopeId": module_scope, "kind": "missing-relation",
            "detail": (
                "页面与数据对象的读写关系未声明；现有数据表只能证明"
                "模块级读写，不可下推到具体页面"),
            "backlogRef": None})
    elif (page_titles and seen_objects and mapping_status == "ok"
          and mapping_header != _PAGE_DATA_HEADER):
        gaps.append({
            "gapId": f"gap:{module_scope}:page-data-rw",
            "scopeId": module_scope, "kind": "unparsed",
            "detail": (
                "页面数据读写表头列序不符，无法机械解析: "
                f"{mapping_header}"),
            "backlogRef": None})
    elif page_titles and seen_objects and mapping_status == "ok":
        parsed_mapping_count = 0
        mapped_page_ids = set()
        assert mapping_header is not None
        for row_index, row in enumerate(mapping_rows, 1):
            if len(row) < len(_PAGE_DATA_HEADER) or not row[0]:
                continue
            flow_title, step_id, page_title, obj, op = row[:5]
            flow_key = _flow_title_key(flow_title)
            flow_id = flow_ids_by_title.get(flow_key)
            step_node_id = (
                flow_steps_by_title.get(flow_key, {}).get(step_id))
            page_id = page_titles.get(page_title)
            obj_id = f"obj:{module_scope}:{obj}"
            reasons = []
            if flow_id is None:
                reasons.append(f"流程不存在: {flow_title}")
            elif step_node_id is None:
                reasons.append(f"步骤不存在: {step_id}")
            if page_id is None:
                reasons.append(f"页面不存在: {page_title}")
            if obj_id not in seen_objects:
                reasons.append(f"数据对象不存在: {obj}")
            kinds = [
                kind for marker, kind in (("读", "reads"), ("写", "writes"))
                if marker in op]
            if not kinds:
                reasons.append(f"操作必须包含读或写: {op}")
            for kind in kinds:
                if (obj_id, kind) not in data_contracts:
                    reasons.append(
                        f"模块级数据契约未声明{kind == 'reads' and '读' or '写'}: "
                        f"{obj}")
            if reasons:
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:page-data-rw:{row_index}"),
                    "scopeId": module_scope, "kind": "unparsed",
                    "detail": "页面数据读写引用无效；" + "；".join(reasons),
                    "backlogRef": None})
                continue
            source = _source_with_requirements(
                module_scope, _PAGE_DATA_MARKER, " ".join(row))
            for kind in kinds:
                contract = data_contracts[(obj_id, kind)]
                _add_edge({
                    "edgeId": (
                        f"{kind}:{page_id}:{obj}:{flow_key}:{step_id}"),
                    "kind": kind, "from": page_id, "to": obj_id,
                    "status": "original", "sources": [source],
                    "detail": {
                        **contract, "relation": "page-data",
                        "flowTitle": flow_title, "flowId": flow_id,
                        "stepId": step_id, "stepNodeId": step_node_id}})
            mapped_page_ids.add(page_id)
            parsed_mapping_count += 1
        if not parsed_mapping_count:
            gaps.append({
                "gapId": f"gap:{module_scope}:page-data-rw",
                "scopeId": module_scope, "kind": "missing-relation",
                "detail": "页面数据读写表没有可验证的数据行",
                "backlogRef": None})
        else:
            for page_title, page_id in sorted(page_titles.items()):
                if page_id in mapped_page_ids:
                    continue
                gaps.append({
                    "gapId": (
                        f"gap:{module_scope}:page-data-rw:{page_title}"),
                    "scopeId": module_scope,
                    "kind": "missing-relation",
                    "detail": (
                        f"页面「{page_title}」尚未声明任何数据读写关系；"
                        "模块级数据契约不可直接下推"),
                    "backlogRef": None,
                    "context": {
                        "pageTitle": page_title,
                        "flowTitle": None}})

    status, header, rows = _find_section_table(text, _INTERACT_MARKER)
    if status == "absent":
        gaps.append({"gapId": f"gap:{module_scope}:module-interaction",
                     "scopeId": module_scope, "kind": "missing-section",
                     "detail": "模块缺少「模块交互（机器可解析）」章节，跨模块关系待深化",
                     "backlogRef": None})
    elif status == "ok" and header != _INTERACT_HEADER:
        gaps.append({"gapId": f"gap:{module_scope}:module-interaction",
                     "scopeId": module_scope, "kind": "unparsed",
                     "detail": f"模块交互表头列序不符，无法机械解析: {header}",
                     "backlogRef": None})
    elif status == "ok":
        source = _module_source(module_scope, _INTERACT_MARKER)
        for row in rows:
            if len(row) < len(_INTERACT_HEADER) or not row[0]:
                continue
            target, direction = row[0], row[1]
            _add_edge({
                "edgeId": f"interacts:{module_scope}:{target}",
                "kind": "interacts", "from": module_scope,
                "to": target, "status": "original", "sources": [source],
                "detail": {"direction": direction, "trigger": row[2],
                           "failurePropagation": row[3]}})


def _resolve_interact_targets(edges, module_scopes):
    """把 interacts 边的目标模块目录名解析为完整模块 scopeId（末段匹配）。"""
    by_last = {}
    for scope in module_scopes:
        by_last.setdefault(scope.split("/")[-1], scope)
    for edge in edges:
        if edge["kind"] == "interacts" and edge["to"] in by_last:
            edge["to"] = by_last[edge["to"]]


def _compile_model(root):
    root = Path(root)
    module_prds = _module_prds(root)
    scopes = _build_scopes(module_prds)
    module_scopes = [module_scope for module_scope, _, _ in module_prds]
    page_catalog = _build_page_catalog(module_prds)

    nodes = _requirement_nodes(root)
    edges = []
    gaps = []
    for module_scope, _system_scope, path in module_prds:
        _compile_module(root, module_scope, path.read_text(encoding="utf-8"),
                        module_scopes, page_catalog, nodes, edges, gaps)
    _resolve_interact_targets(edges, module_scopes)

    nodes.sort(key=lambda n: (n["kind"], n["nodeId"]))
    edges.sort(key=lambda e: (e["kind"], e["edgeId"]))
    gaps.sort(key=lambda g: g["gapId"])

    coverage = {
        "moduleCount": len(module_scopes),
        "pageCount": len([n for n in nodes if n["kind"] == "page"]),
        "flowCount": len([
            n for n in nodes
            if n["kind"] == "flow"
            and (n.get("detail") or {}).get("category") == "userFlow"
        ]),
        "pageStateCount": len([
            n for n in nodes
            if n["kind"] == "state"
            and (n.get("detail") or {}).get("category") == "pageState"
        ]),
        "businessStateCount": len([
            n for n in nodes
            if n["kind"] == "state"
            and (n.get("detail") or {}).get("category") == "businessState"
        ]),
        "boundaryCount": len([
            n for n in nodes
            if n["kind"] == "flow"
            and (n.get("detail") or {}).get("category") == "boundary"
        ]),
        "stateImpactCount": len([
            n for n in nodes
            if n["kind"] == "flow"
            and (n.get("detail") or {}).get("category") == "stateImpact"
        ]),
        "interactionCount": len([
            n for n in nodes
            if n["kind"] == "flow"
            and (n.get("detail") or {}).get("category") == "interactionStep"
        ]),
        "edgeCount": len(edges),
        "requirementCount": len([n for n in nodes if n["kind"] == "requirement"]),
        "gapCount": len(gaps),
    }
    return {
        "logicModelSchemaVersion": LOGIC_MODEL_SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "scopes": scopes,
        "nodes": nodes,
        "edges": edges,
        "gaps": gaps,
        "coverage": coverage,
    }


def compile(root):
    """确定性编译逻辑模型；能力未开启抛 AtlasNotEnabled，读取栅栏先行。"""
    root = Path(root)
    _require_enabled(root)
    effective_view.assert_read_fence(root)
    return _compile_model(root)


# ---------------------------------------------------------------- 模型校验

def _validate_references(model):
    """跨模块关系两端必须存在（ADR-0005 §7）：返回错误列表。"""
    known = {node["nodeId"] for node in model["nodes"]}
    known |= {scope["scopeId"] for scope in model["scopes"]}
    errors = []
    seen_ids = set()
    for node in model["nodes"]:
        if node["nodeId"] in seen_ids:
            errors.append(f"duplicate nodeId: {node['nodeId']}")
        seen_ids.add(node["nodeId"])
    for edge in model["edges"]:
        if edge["from"] not in known:
            errors.append(f"edge {edge['edgeId']} 起点不存在: {edge['from']}")
        if edge["to"] not in known:
            errors.append(f"edge {edge['edgeId']} 终点不存在: {edge['to']}")
    return errors


# ---------------------------------------------------------------- 渲染

def _short_digest(atlas_manifest):
    return atlas_manifest["authoritativeSourceDigest"].removeprefix("sha256:")[:12]


def _snapshot_lines(atlas_manifest):
    return [
        f"- 生成器版本: {atlas_manifest['generatorVersion']}",
        f"- 逻辑模型 schema 版本: {atlas_manifest['logicModelSchemaVersion']}",
        f"- 权威主本快照: {_short_digest(atlas_manifest)}",
        f"- 阶段: {atlas_manifest['stage']}",
    ]


def _render_markdown(model, atlas_manifest):
    cov = model["coverage"]
    out = ["# Logic Atlas",
           "",
           "> 本视图由 logic-model.json 确定性生成，自述以下生成快照，不代表「当前最新」。",
           ""]
    out.extend(_snapshot_lines(atlas_manifest))
    out += ["", "## 覆盖",
            f"- 模块数: {cov['moduleCount']}",
            f"- 页面数: {cov['pageCount']}",
            f"- 关系数: {cov['edgeCount']}",
            f"- 需求数: {cov['requirementCount']}",
            f"- 缺口数: {cov['gapCount']}", ""]

    out.append("## 页面")
    for node in model["nodes"]:
        if node["kind"] == "page":
            detail = node["detail"] or {}
            out.append(f"- [{node['scopeId']}] {node['title']}"
                       f"（入口 {detail.get('entry', '')}，角色 {detail.get('role', '')}）")
    out.append("")

    out.append("## 数据对象")
    for node in model["nodes"]:
        if node["kind"] == "dataObject":
            detail = node["detail"] or {}
            out.append(f"- [{node['scopeId']}] {node['title']}"
                       f"（权威来源 {detail.get('authoritativeSource', '')}）")
    out.append("")

    out.append("## 关系")
    for edge in model["edges"]:
        out.append(f"- {edge['kind']}: {edge['from']} → {edge['to']}")
    out.append("")

    out.append("## 缺口")
    for gap in model["gaps"]:
        out.append(f"- [{gap['scopeId']}] {gap['kind']}: {gap['detail']}")
    out.append("")
    return "\n".join(out) + "\n"


def _render_report(model, atlas_manifest):
    cov = model["coverage"]
    out = ["# Logic Atlas 校验报告", ""]
    out.extend(_snapshot_lines(atlas_manifest))
    out += ["",
            "## 机械信号",
            f"- 结构可解析模块: {cov['moduleCount']}",
            f"- 缺口（结构未解析或待深化）: {cov['gapCount']}",
            "",
            "> 机械覆盖不代表内容成熟度；一张表可解析不等于逻辑正确。",
            ""]
    return "\n".join(out) + "\n"


_VIEWER_TEMPLATE_RELPATH = "assets/logic-atlas-viewer.html"
_MODEL_TOKEN = "__ATLAS_MODEL_JSON__"
_META_TOKEN = "__ATLAS_META_JSON__"


@functools.lru_cache(maxsize=1)
def _viewer_template_bytes():
    """viewer 模板字节（资产本体）。模块级缓存：只读一次，确定性不受影响，
    避免性能门下多次渲染反复触盘。"""
    path = Path(__file__).resolve().parents[2] / _VIEWER_TEMPLATE_RELPATH
    return path.read_bytes()


def _inject_json(template, token, value):
    """把 value 的 canonical JSON 注入 token 处（恰好一次）。

    `<` 转义为 `\\u003c` 以杜绝 JSON 内容提前闭合 <script> 标签（XSS/破页）；
    注入前断言 token 恰好出现一次，模板被改坏时立即 fail 而非静默产出坏页。
    """
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).replace("<", "\\u003c")
    count = template.count(token)
    assert count == 1, f"模板注入锚点 {token} 必须恰好出现一次，实际 {count} 次"
    return template.replace(token, payload, 1)


def _render_html(model, atlas_manifest):
    """把 logic model 注入自包含交互式 viewer 模板（viewer 2.0）。

    模板是资产本体（改模板即改渲染语义，assetDigest 覆盖其字节）；此函数只
    做两处确定性 JSON 注入，同输入两次渲染逐字节一致。"""
    meta = {
        "generatorVersion": atlas_manifest["generatorVersion"],
        "stage": atlas_manifest["stage"],
        "shortDigest": _short_digest(atlas_manifest),
        "authoritativeSourceDigest": atlas_manifest["authoritativeSourceDigest"],
        "ledgerSourceDigest": atlas_manifest["ledgerSourceDigest"],
        "ledgerArtifactDigest": atlas_manifest["ledgerArtifactDigest"],
    }
    html = _viewer_template_bytes().decode("utf-8")
    html = _inject_json(html, _MODEL_TOKEN, model)
    html = _inject_json(html, _META_TOKEN, meta)
    return html


# ---------------------------------------------------------------- 发布计划

def _atlas_manifest(root, stage, ledger_digest, artifacts):
    return {
        "generatorVersion": GENERATOR_VERSION,
        "logicModelSchemaVersion": LOGIC_MODEL_SCHEMA_VERSION,
        "authoritativeSourceDigest": base_cas.authoritative_source_digest(root),
        "ledgerSourceDigest": base_cas.ledger_source_digest(root),
        "ledgerArtifactDigest": ledger_digest,
        "artifacts": artifacts,
        "stage": stage,
    }


def _plan_from_model(root, stage, model):
    """从**已校验**的模型产出发布计划。manifest 携带各生成物摘要且排在最后
    发布——发布中断时 manifest 缺失/陈旧，新鲜度检查如实报告而非误报 fresh。"""
    ledger_content = _ledger_content(root)
    ledger_digest = sha256_of_bytes(ledger_content)

    contents = {
        LEDGER_RELPATH: ledger_content,
        MODEL_RELPATH: canonical_json_bytes(model),
    }
    artifacts = {rel: sha256_of_bytes(data) for rel, data in contents.items()}
    # 视图渲染引用 manifest 中的权威摘要；视图自身的摘要在渲染后补录。
    manifest = _atlas_manifest(root, stage, ledger_digest, artifacts)
    views = {MD_RELPATH: _render_markdown(model, manifest).encode("utf-8"),
             REPORT_RELPATH: _render_report(model, manifest).encode("utf-8")}
    if stage in ("html", "polish"):
        views[HTML_RELPATH] = _render_html(model, manifest).encode("utf-8")
    contents.update(views)
    manifest["artifacts"] = {rel: sha256_of_bytes(data)
                             for rel, data in contents.items()}

    plan = [{"path": rel, "action": "write", "content": contents[rel]}
            for rel in (LEDGER_RELPATH, MODEL_RELPATH, MD_RELPATH, REPORT_RELPATH)]
    if HTML_RELPATH in contents:
        plan.append({"path": HTML_RELPATH, "action": "write",
                     "content": contents[HTML_RELPATH]})
    plan.append({"path": MANIFEST_RELPATH, "action": "write",
                 "content": canonical_json_bytes(manifest)})
    return plan


def build_plan(root):
    """按 stage 产出 engine plan（内部先过模型校验——公共入口不产出未经
    校验的计划）：markdown 四件套 + 重建 ledger，html/polish 加自包含 HTML。"""
    root = Path(root)
    stage = _require_enabled(root)
    model = compile(root)
    errors = _validate_references(model)
    if errors:
        raise AtlasValidationError(errors)
    return _plan_from_model(root, stage, model)


# ---------------------------------------------------------------- 发布

def publish(root):
    """经 operation_engine 以 maintain operation 提交发布计划；校验失败 fail closed。

    先取 writer lock 再编译——锁内单次编译、校验、出计划、建 proposal，
    消除「校验后、发布前」窗口内主本变化导致发布未经校验模型的 TOCTOU。
    operation/proposal ID 带 base digest 后缀：每次内容变化产生新 operation，
    已 committed 的 manifest 永不被复用覆盖。
    """
    root = Path(root)
    stage = _require_enabled(root)
    handle = writer_lock.acquire(root, "op-atlas")
    try:
        model = compile(root)
        errors = _validate_references(model)
        if errors:
            raise AtlasValidationError(errors)
        plan = _plan_from_model(root, stage, model)

        suffix = base_cas.operation_base_digest(root).removeprefix("sha256:")[:12]
        operation_id = f"op-atlas-{suffix}"
        handle.rebind(operation_id)
        proposal = engine.build_proposal(
            root, proposal_id=f"prop-atlas-{suffix}", proposal_kind="maintain",
            candidate_revision=None,
            affected_files=[entry["path"] for entry in plan],
            generator_version=GENERATOR_VERSION)

        engine.create_operation(
            root, proposal, operation_id=operation_id, operation_kind="maintain",
            plan=plan)
        engine.commit_segment(root, operation_id, [])
        engine.validate_operation(root, operation_id)
        engine.publish(root, operation_id)
    finally:
        handle.release()
    return engine.load_manifest(root, operation_id)


# ---------------------------------------------------------------- 新鲜度

def check_freshness(root):
    """严格只读三摘要比对（ADR-0005 §6）：pending 不参与；零写入。"""
    root = Path(root)
    reasons = []
    # 读取栅栏：存在未完成发布的 operation 时不得宣称 fresh（只报告，零写入）。
    if effective_view.blocking_operations(root):
        return {"contentFresh": False, "reasons": ["read-fence"]}

    manifest_path = root / MANIFEST_RELPATH
    if not manifest_path.exists():
        return {"contentFresh": False, "reasons": ["atlas-not-published"]}
    try:
        manifest = read_json(manifest_path)
    except (OSError, ValueError):
        return {"contentFresh": False, "reasons": ["manifest-unreadable"]}

    if manifest.get("authoritativeSourceDigest") != base_cas.authoritative_source_digest(root):
        reasons.append("authoritativeSourceDigest")
    if manifest.get("ledgerSourceDigest") != base_cas.ledger_source_digest(root):
        reasons.append("ledgerSourceDigest")
    if manifest.get("ledgerArtifactDigest") != file_digest_or_none(root / LEDGER_RELPATH):
        reasons.append("ledgerArtifactDigest")
    # 生成物摘要对账：带外篡改 Atlas 内容（_generated 不在权威主本摘要内）必须可检测。
    for rel, digest in (manifest.get("artifacts") or {}).items():
        if file_digest_or_none(root / rel) != digest:
            reasons.append(f"artifact:{rel}")

    return {"contentFresh": not reasons, "reasons": reasons}


# ---------------------------------------------------------------- 内容门

def _steps_for_stage(stage):
    pairs = [(step, True) for step in _MARKDOWN_STEPS]
    if stage in ("html", "polish"):
        pairs += [(step, True) for step in _HTML_STEPS]
    if stage == "polish":
        pairs.append((_POLISH_STEP, False))
    return [{"id": step, "blocking": blocking} for step, blocking in pairs]


def gate_requirements(root):
    """内容门按阶段裁剪步骤（legacy/markdown/html/polish）。"""
    stage = _atlas_stage(_worktree_manifest(root))
    if stage is None:
        return {"stage": "legacy", "steps": []}
    return {"stage": stage, "steps": _steps_for_stage(stage)}


# ---------------------------------------------------------------- 证明继承

def proof_inherits(previous_proof, current_env):
    """七个继承键全部**存在、非空且相等**才继承（纯函数、不读文件；ADR-0005 §8）。

    缺键不允许按 None == None 空洞通过——空证明对空环境不构成任何验证证据。
    """
    for key in _PROOF_INHERIT_KEYS:
        previous = previous_proof.get(key)
        current = current_env.get(key)
        if previous is None or current is None or previous != current:
            return False
    return True


# ---------------------------------------------------------------- 渲染器验证环境

# 渲染器验证证明的继承环境（ADR-0005 §8）：七个继承键任一变化都使已提交的
# 浏览器验证证明失效。版本常量只在对应事实变化时手工递增：
# - RENDERER_VERSION：HTML/Markdown 渲染语义变化（viewer 模板即资产本体，
#   assetDigest 已覆盖模板字节 + 渲染源码，这里表达「有意的行为版本」）。
# - BROWSER_MATRIX_VERSION：CI 浏览器矩阵口径（当前仅 Chrome headless）。
# - VALIDATION_HARNESS_VERSION：scripts/validate-renderer.mjs 的断言集版本。
import inspect

RENDERER_VERSION = "7.0.0"
BROWSER_MATRIX_VERSION = "2026-07"
VALIDATION_HARNESS_VERSION = "7.0.0"

_FIXTURE_MODULE = "01-portal/01-module"
_FIXTURE_MODULE_B = "01-portal/02-module"
# 转义探针：script 标签 + 双引号 + 单引号。渲染器任何转义回退都会让
# 浏览器验证（alert 探针、script 标签计数）与单测（原文不得出现）失败。
_FIXTURE_PROBE_TITLE = "详情页 <script>alert(1)</script> \"双引号\" '单引号'"
_FIXTURE_HOME_TITLE = "固定样例首页 Fixture-Home"
_FIXTURE_OBJECT_TITLE = "订单 & <b>数据</b>"


def _fixture_source(path, anchor):
    return {"path": path, "anchor": anchor, "requirementIds": [], "oqIds": []}


def _fixture_model():
    """浏览器验证专用的硬编码确定性小型 logic model。

    覆盖结构、行为、状态、边界节点及对应关系边；节点标题内置转义探针；
    结构与 _compile_model 输出同构（过 logic-model.schema.json 与
    _validate_references）。
    """
    page_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _PAGE_MARKER)
    data_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _DATA_MARKER)
    interact_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _INTERACT_MARKER)
    flow_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _FLOW_MARKER)
    flow_src["requirementIds"] = ["REQ-100"]
    interaction_src = _fixture_source(
        f"{_FIXTURE_MODULE}/prd.md", _INTERACTION_MARKER)
    interaction_src["requirementIds"] = ["REQ-100"]
    state_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _STATE_MARKER)
    boundary_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _BOUNDARY_MARKER)
    impact_src = _fixture_source(f"{_FIXTURE_MODULE}/prd.md", _IMPACT_MARKER)
    impact_src["requirementIds"] = ["REQ-100"]
    home_id = f"page:{_FIXTURE_MODULE}:{_FIXTURE_HOME_TITLE}"
    probe_id = f"page:{_FIXTURE_MODULE}:{_FIXTURE_PROBE_TITLE}"
    object_id = f"obj:{_FIXTURE_MODULE}:{_FIXTURE_OBJECT_TITLE}"
    flow_id = f"flow:{_FIXTURE_MODULE}:查看订单详情"
    step1_id = f"flowstep:{_FIXTURE_MODULE}:查看订单详情:S1"
    step2_id = f"flowstep:{_FIXTURE_MODULE}:查看订单详情:S2"
    interaction1_id = (
        f"interaction:{_FIXTURE_MODULE}:查看订单详情:S1:I1")
    interaction2_id = (
        f"interaction:{_FIXTURE_MODULE}:查看订单详情:S1:I2")
    interaction3_id = (
        f"interaction:{_FIXTURE_MODULE}:查看订单详情:S2:I1")
    interaction4_id = (
        f"interaction:{_FIXTURE_MODULE}:查看订单详情:S2:I2")
    terminal_id = f"flowterminal:{_FIXTURE_MODULE}:查看订单详情"
    failure_id = f"flowfailure:{_FIXTURE_MODULE}:查看订单详情:S1"
    page_state_id = f"pagestate:{_FIXTURE_MODULE}:查看订单详情:首页:加载中:1"
    active_state_id = f"state:{_FIXTURE_MODULE}:订单:处理中"
    done_state_id = f"state:{_FIXTURE_MODULE}:订单:已完成"
    impact_id = f"stateimpact:{_FIXTURE_MODULE}:查看订单详情:S2:订单"

    scopes = [
        {"scopeId": WORKTREE_SCOPE_ID, "kind": "worktree",
         "title": "渲染器验证 fixture 工作树", "path": None, "parentScopeId": None},
        {"scopeId": "01-portal", "kind": "system", "title": "门户系统",
         "path": "01-portal", "parentScopeId": WORKTREE_SCOPE_ID},
        {"scopeId": _FIXTURE_MODULE, "kind": "module", "title": "样例模块",
         "path": _FIXTURE_MODULE, "parentScopeId": "01-portal"},
        {"scopeId": _FIXTURE_MODULE_B, "kind": "module", "title": "协作模块",
         "path": _FIXTURE_MODULE_B, "parentScopeId": "01-portal"},
    ]
    nodes = [
        {"nodeId": object_id, "kind": "dataObject", "scopeId": _FIXTURE_MODULE,
         "title": _FIXTURE_OBJECT_TITLE, "status": "original",
         "sources": [data_src], "detail": {"authoritativeSource": "领域规格"}},
        {"nodeId": home_id, "kind": "page", "scopeId": _FIXTURE_MODULE,
         "title": _FIXTURE_HOME_TITLE, "status": "original",
         "sources": [page_src],
         "detail": {"entry": "-", "role": "会员", "precondition": "已登录",
                    "actions": [{"action": "打开详情", "result": "跳转详情页"}]}},
        {"nodeId": probe_id, "kind": "page", "scopeId": _FIXTURE_MODULE,
         "title": _FIXTURE_PROBE_TITLE, "status": "original",
         "sources": [page_src],
         "detail": {"entry": _FIXTURE_HOME_TITLE, "role": "会员",
                    "precondition": "已登录",
                    "actions": [{"action": "查看", "result": "展示订单"}]}},
        {"nodeId": flow_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "查看订单详情", "status": "original", "sources": [flow_src],
         "detail": {"category": "userFlow", "stepCount": 2}},
        {"nodeId": step1_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "S1 · 打开订单", "status": "original", "sources": [flow_src],
         "detail": {"category": "flowStep", "flowId": flow_id, "stepId": "S1",
                    "pageTitle": _FIXTURE_HOME_TITLE, "pageId": home_id,
                    "role": "会员", "action": "打开订单", "condition": "订单存在",
                    "result": "进入详情", "nextStep": "S2",
                    "failureHandling": "提示订单不存在并停留"}},
        {"nodeId": step2_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "S2 · 查看订单", "status": "original", "sources": [flow_src],
         "detail": {"category": "flowStep", "flowId": flow_id, "stepId": "S2",
                    "pageTitle": _FIXTURE_PROBE_TITLE, "pageId": probe_id,
                    "role": "运营人员", "action": "查看订单", "condition": "加载成功",
                    "result": "展示订单", "nextStep": "结束",
                    "failureHandling": "支持重试"}},
        {"nodeId": interaction1_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "I1 · 进入 无", "status": "original",
         "sources": [interaction_src],
         "detail": {
             "category": "interactionStep", "flowTitle": "查看订单详情",
             "flowId": flow_id, "stepId": "S1", "stepNodeId": step1_id,
             "interactionId": "I1", "pageTitle": _FIXTURE_HOME_TITLE,
             "pageId": home_id, "containerState": "列表",
             "control": "无", "event": "进入",
             "availability": "会员已登录", "immediateFeedback": "显示骨架屏",
             "systemAction": "读取订单列表", "successResult": "展示订单",
             "failureRecovery": "失败时可重试", "nextInteraction": "I2",
             "requirements": "REQ-100", "entry": True}},
        {"nodeId": interaction2_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "I2 · 点击 订单行", "status": "original",
         "sources": [interaction_src],
         "detail": {
             "category": "interactionStep", "flowTitle": "查看订单详情",
             "flowId": flow_id, "stepId": "S1", "stepNodeId": step1_id,
             "interactionId": "I2", "pageTitle": _FIXTURE_HOME_TITLE,
             "pageId": home_id, "containerState": "列表",
             "control": "订单行", "event": "点击",
             "availability": "订单存在", "immediateFeedback": "进入详情",
             "systemAction": "读取订单详情", "successResult": "展示详情",
             "failureRecovery": "订单不存在时返回列表",
             "nextInteraction": "结束", "requirements": "REQ-100",
             "entry": False}},
        {"nodeId": interaction3_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "I1 · 进入 无", "status": "original",
         "sources": [interaction_src],
         "detail": {
             "category": "interactionStep", "flowTitle": "查看订单详情",
             "flowId": flow_id, "stepId": "S2", "stepNodeId": step2_id,
             "interactionId": "I1", "pageTitle": _FIXTURE_PROBE_TITLE,
             "pageId": probe_id, "containerState": "详情",
             "control": "无", "event": "进入",
             "availability": "详情已加载", "immediateFeedback": "展示内容",
             "systemAction": "校验订单状态", "successResult": "启用完成操作",
             "failureRecovery": "失败时保留当前页", "nextInteraction": "I2",
             "requirements": "REQ-100", "entry": True}},
        {"nodeId": interaction4_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "I2 · 点击 完成", "status": "original",
         "sources": [interaction_src],
         "detail": {
             "category": "interactionStep", "flowTitle": "查看订单详情",
             "flowId": flow_id, "stepId": "S2", "stepNodeId": step2_id,
             "interactionId": "I2", "pageTitle": _FIXTURE_PROBE_TITLE,
             "pageId": probe_id, "containerState": "详情",
             "control": "完成", "event": "点击",
             "availability": "订单处理中", "immediateFeedback": "按钮 Loading",
             "systemAction": "完成订单", "successResult": "状态变为已完成",
             "failureRecovery": "失败时允许重试", "nextInteraction": "结束",
             "requirements": "REQ-100", "entry": False}},
        {"nodeId": terminal_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "结束", "status": "original", "sources": [flow_src],
         "detail": {"category": "terminal", "flowId": flow_id}},
        {"nodeId": failure_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "提示订单不存在并停留", "status": "original",
         "sources": [flow_src],
         "detail": {"category": "failureBranch", "flowId": flow_id,
                    "stepId": "S1", "handling": "提示订单不存在并停留"}},
        {"nodeId": impact_id, "kind": "flow", "scopeId": _FIXTURE_MODULE,
         "title": "订单: 处理中 → 已完成", "status": "original",
         "sources": [impact_src],
         "detail": {
             "category": "stateImpact", "flowTitle": "查看订单详情",
             "flowId": flow_id, "stepId": "S2", "stepNodeId": step2_id,
             "interactionId": "I2", "interactionNodeId": interaction4_id,
             "object": "订单", "currentState": "处理中",
             "nextState": "已完成", "fromStateId": active_state_id,
             "toStateId": done_state_id,
             "transitionEdgeId": (
                 f"transition:{_FIXTURE_MODULE}:订单:处理中->已完成"),
             "dependency": _FIXTURE_MODULE_B,
             "dependencyScopeId": _FIXTURE_MODULE_B,
             "failurePropagation": "协作模块不可用时保留处理中并支持重试",
         }},
        {"nodeId": page_state_id, "kind": "state", "scopeId": _FIXTURE_MODULE,
         "title": "加载中", "status": "original", "sources": [flow_src],
         "detail": {"category": "pageState", "flowTitle": "查看订单详情",
                    "flowId": flow_id, "stepId": "S1",
                    "stepNodeId": step1_id, "interactionId": "I1",
                    "interactionNodeId": interaction1_id,
                    "pageTitle": _FIXTURE_HOME_TITLE,
                    "pageId": home_id, "pageIds": [home_id],
                    "trigger": "首次进入", "systemBehavior": "显示骨架屏",
                    "userAction": "等待", "acceptance": "数据返回后展示详情"}},
        {"nodeId": active_state_id, "kind": "state", "scopeId": _FIXTURE_MODULE,
         "title": "处理中", "status": "original", "sources": [state_src],
         "detail": {"category": "businessState", "object": "订单",
                    "entryCondition": "提交成功", "actions": "完成订单",
                    "reversible": "否", "notifications": "记录日志"}},
        {"nodeId": done_state_id, "kind": "state", "scopeId": _FIXTURE_MODULE,
         "title": "已完成", "status": "original", "sources": [state_src],
         "detail": {"category": "businessState", "object": "订单",
                    "declaredAsTargetOnly": True}},
        {"nodeId": f"boundary:{_FIXTURE_MODULE}:订单归属", "kind": "flow",
         "scopeId": _FIXTURE_MODULE, "title": "订单归属", "status": "original",
         "sources": [boundary_src],
         "detail": {"category": "boundary", "responsibility": "展示订单",
                    "excluded": "支付结算", "dependency": "支付模块"}},
        {"nodeId": "req:REQ-100", "kind": "requirement",
         "scopeId": WORKTREE_SCOPE_ID, "title": "REQ-100", "status": "original",
         "sources": [{"path": MATRIX_RELPATH, "anchor": "REQ-100",
                      "requirementIds": ["REQ-100"], "oqIds": []}],
         "detail": {"state": "active", "summary": "会员可查看订单详情并完成订单",
                    "assertionRole": "normative", "sourceCount": 1}},
    ]
    edges = [
        {"edgeId": f"nav:{_FIXTURE_MODULE}:{_FIXTURE_HOME_TITLE}->{_FIXTURE_PROBE_TITLE}",
         "kind": "navigates", "from": home_id, "to": probe_id,
         "status": "original", "sources": [page_src], "detail": None},
        {"edgeId": f"reads:{_FIXTURE_MODULE}:{_FIXTURE_OBJECT_TITLE}",
         "kind": "reads", "from": _FIXTURE_MODULE, "to": object_id,
         "status": "original", "sources": [data_src],
         "detail": {"authoritativeSource": "领域规格", "syncMethod": "实时"}},
        {"edgeId": f"writes:{_FIXTURE_MODULE}:{_FIXTURE_OBJECT_TITLE}",
         "kind": "writes", "from": _FIXTURE_MODULE, "to": object_id,
         "status": "original", "sources": [data_src],
         "detail": {"authoritativeSource": "领域规格", "syncMethod": "实时"}},
        {"edgeId": f"interacts:{_FIXTURE_MODULE}:02-module",
         "kind": "interacts", "from": _FIXTURE_MODULE, "to": _FIXTURE_MODULE_B,
         "status": "original", "sources": [interact_src],
         "detail": {"direction": "调用", "trigger": "下单",
                    "failurePropagation": "阻塞并提示"}},
        {"edgeId": f"nav:{flow_id}:entry", "kind": "navigates",
         "from": flow_id, "to": step1_id, "status": "original",
         "sources": [flow_src], "detail": {"branch": "entry"}},
        {"edgeId": f"nav:{step1_id}:success", "kind": "navigates",
         "from": step1_id, "to": step2_id, "status": "original",
         "sources": [flow_src],
         "detail": {"branch": "success", "condition": "订单存在"}},
        {"edgeId": f"nav:{step1_id}:failure", "kind": "navigates",
         "from": step1_id, "to": failure_id, "status": "original",
         "sources": [flow_src], "detail": {"branch": "failure"}},
        {"edgeId": f"nav:{step2_id}:success", "kind": "navigates",
         "from": step2_id, "to": terminal_id, "status": "original",
         "sources": [flow_src],
         "detail": {"branch": "success", "condition": "加载成功"}},
        {"edgeId": f"trace:{step1_id}:page", "kind": "traces",
         "from": step1_id, "to": home_id, "status": "original",
         "sources": [flow_src], "detail": {"relation": "flow-step-page"}},
        {"edgeId": f"nav:{interaction1_id}:interaction-success",
         "kind": "navigates", "from": interaction1_id, "to": interaction2_id,
         "status": "original", "sources": [interaction_src],
         "detail": {"relation": "interaction-success"}},
        {"edgeId": f"nav:{interaction3_id}:interaction-success",
         "kind": "navigates", "from": interaction3_id, "to": interaction4_id,
         "status": "original", "sources": [interaction_src],
         "detail": {"relation": "interaction-success"}},
        {"edgeId": f"trace:{interaction1_id}:step", "kind": "traces",
         "from": interaction1_id, "to": step1_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-step"}},
        {"edgeId": f"trace:{interaction1_id}:page", "kind": "traces",
         "from": interaction1_id, "to": home_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-page"}},
        {"edgeId": f"trace:{interaction2_id}:step", "kind": "traces",
         "from": interaction2_id, "to": step1_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-step"}},
        {"edgeId": f"trace:{interaction2_id}:page", "kind": "traces",
         "from": interaction2_id, "to": home_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-page"}},
        {"edgeId": f"trace:{interaction3_id}:step", "kind": "traces",
         "from": interaction3_id, "to": step2_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-step"}},
        {"edgeId": f"trace:{interaction3_id}:page", "kind": "traces",
         "from": interaction3_id, "to": probe_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-page"}},
        {"edgeId": f"trace:{interaction4_id}:step", "kind": "traces",
         "from": interaction4_id, "to": step2_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-step"}},
        {"edgeId": f"trace:{interaction4_id}:page", "kind": "traces",
         "from": interaction4_id, "to": probe_id, "status": "original",
         "sources": [interaction_src], "detail": {"relation": "interaction-page"}},
        {"edgeId": f"trace:{page_state_id}:page", "kind": "traces",
         "from": page_state_id, "to": home_id, "status": "original",
         "sources": [flow_src], "detail": {"relation": "page-state"}},
        {"edgeId": f"trace:{page_state_id}:step", "kind": "traces",
         "from": page_state_id, "to": step1_id, "status": "original",
         "sources": [flow_src], "detail": {"relation": "page-state-step"}},
        {"edgeId": f"trace:{page_state_id}:interaction", "kind": "traces",
         "from": page_state_id, "to": interaction1_id, "status": "original",
         "sources": [flow_src], "detail": {"relation": "page-state-interaction"}},
        {"edgeId": f"transition:{_FIXTURE_MODULE}:订单:处理中->已完成",
         "kind": "transition", "from": active_state_id, "to": done_state_id,
         "status": "original", "sources": [state_src],
         "detail": {"condition": "处理成功", "action": "完成订单",
                    "reversible": "否", "notifications": "记录日志"}},
        {"edgeId": f"trace:{impact_id}:step", "kind": "traces",
         "from": impact_id, "to": step2_id, "status": "original",
         "sources": [impact_src], "detail": {"relation": "state-impact-step"}},
        {"edgeId": f"trace:{impact_id}:interaction", "kind": "traces",
         "from": impact_id, "to": interaction4_id, "status": "original",
         "sources": [impact_src], "detail": {"relation": "state-impact-interaction"}},
        {"edgeId": f"trace:{impact_id}:from", "kind": "traces",
         "from": impact_id, "to": active_state_id, "status": "original",
         "sources": [impact_src], "detail": {"relation": "state-impact-from"}},
        {"edgeId": f"trace:{impact_id}:to", "kind": "traces",
         "from": impact_id, "to": done_state_id, "status": "original",
         "sources": [impact_src], "detail": {"relation": "state-impact-to"}},
        {"edgeId": f"interaction:{impact_id}:{_FIXTURE_MODULE_B}",
         "kind": "interacts", "from": impact_id, "to": _FIXTURE_MODULE_B,
         "status": "original", "sources": [impact_src],
         "detail": {"relation": "state-impact-dependency",
                    "direction": "依赖", "trigger": "查看订单详情",
                    "failurePropagation": "协作模块不可用时保留处理中并支持重试"}},
    ]
    gaps = [
        {"gapId": f"gap:{_FIXTURE_MODULE_B}:page-contract",
         "scopeId": _FIXTURE_MODULE_B, "kind": "missing-section",
         "detail": "模块缺少「页面契约（机器可解析）」章节，页面关系待深化",
         "backlogRef": None},
        {"gapId": f"gap:{_FIXTURE_MODULE}:page-data-rw",
         "scopeId": _FIXTURE_MODULE, "kind": "missing-relation",
         "detail": (
             "页面与数据对象的读写关系未声明；现有数据表只能证明"
             "模块级读写，不可下推到具体页面"),
         "backlogRef": None,
         "context": {
             "pageTitle": _FIXTURE_PROBE_TITLE,
             "flowTitle": "查看订单详情",
             "stepId": "S2"}},
    ]
    nodes.sort(key=lambda n: (n["kind"], n["nodeId"]))
    edges.sort(key=lambda e: (e["kind"], e["edgeId"]))
    return {
        "logicModelSchemaVersion": LOGIC_MODEL_SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "scopes": scopes,
        "nodes": nodes,
        "edges": edges,
        "gaps": gaps,
        "coverage": {
            "moduleCount": 2, "pageCount": 2, "flowCount": 1,
            "pageStateCount": 1, "businessStateCount": 2, "boundaryCount": 1,
            "stateImpactCount": 1,
            "interactionCount": 4,
            "edgeCount": len(edges), "requirementCount": 1,
            "gapCount": len(gaps),
        },
    }


def _fixture_manifest():
    """固定 atlas manifest：字段形状与 _atlas_manifest 一致，摘要为
    fixture 专用确定值（不依赖任何真实工作树）。"""
    digest = sha256_of_bytes(b"prdsync-renderer-fixture")
    return {
        "generatorVersion": GENERATOR_VERSION,
        "logicModelSchemaVersion": LOGIC_MODEL_SCHEMA_VERSION,
        "authoritativeSourceDigest": digest,
        "ledgerSourceDigest": digest,
        "ledgerArtifactDigest": digest,
        "artifacts": {},
        "stage": "html",
    }


def render_fixture_html():
    """产出浏览器验证用的确定性 fixture HTML；fixture 模型自身先过
    引用校验——验证 harness 不得建立在无效模型上。"""
    model = _fixture_model()
    errors = _validate_references(model)
    if errors:
        raise AtlasValidationError(errors)
    return _render_html(model, _fixture_manifest())


def renderer_env():
    """当前渲染器验证环境：七个继承键（ADR-0005 §8）。

    - assetDigest：viewer 模板文件字节 + _render_html 与 _snapshot_lines 源码
      文本的 sha256。模板是资产本体，改模板必换摘要，旧证明随之失效。
    - fixtureDigest：fixture model + manifest 的 canonical JSON sha256；
      fixture 更新同样使旧证明失效。
    """
    asset_source = inspect.getsource(_render_html) + inspect.getsource(_snapshot_lines)
    asset_bytes = _viewer_template_bytes() + asset_source.encode("utf-8")
    fixture = {"manifest": _fixture_manifest(), "model": _fixture_model()}
    return {
        "rendererVersion": RENDERER_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "schemaVersion": str(LOGIC_MODEL_SCHEMA_VERSION),
        "assetDigest": sha256_of_bytes(asset_bytes),
        "fixtureDigest": sha256_of_bytes(canonical_json_bytes(fixture)),
        "validationHarnessVersion": VALIDATION_HARNESS_VERSION,
        "browserMatrixVersion": BROWSER_MATRIX_VERSION,
    }
