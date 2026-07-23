"""Logic Atlas 确定性编译器与分层内容门（ADR-0005、技术设计 §10/§11 门 5）。

PRD 工作树是写模型，Logic Atlas 是从权威主本确定性编译的只读投影，不建立第二套
权威内容。本模块实现 ADR-0005「分阶段落地·第一/第二阶段」的编译、渲染、发布与
新鲜度判定：

- `compile(root)`：只消费模块 prd.md 的三张机器可解析表（页面契约 / 数据读写 /
  模块交互，表头列序见 templates/module-prd.md）与需求身份读模型（经
  requirements-ledger 单一解析路径）。无法解析的模块如实进 gaps，绝不按产品经验
  补齐。构建前先检查读取栅栏；Atlas 能力未开启抛 AtlasNotEnabled；两次编译逐字节一致。
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

import html as _html
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

GENERATOR_VERSION = "1.0.0"
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

# 三张机器可解析表的定位标记与固定表头（列序不得改动；对齐 templates/module-prd.md）。
_PAGE_MARKER = "页面契约（机器可解析）"
_DATA_MARKER = "数据读写（机器可解析）"
_INTERACT_MARKER = "模块交互（机器可解析）"
_PAGE_HEADER = ["页面", "入口", "角色", "前置条件", "用户动作", "系统结果"]
_DATA_HEADER = ["数据对象", "操作", "权威来源", "同步方式"]
_INTERACT_HEADER = ["目标模块", "方向", "触发", "失败传播"]

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


# ---------------------------------------------------------------- 作用域发现

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


def _requirement_states(root):
    ctx = merge._context(root)
    states = merge._lifecycle_states(ctx["projection"])
    return {req: states.get(req, merge._ACTIVE) for req in merge._existing_ids(ctx)}


# ---------------------------------------------------------------- 编译

def _requirement_nodes(states):
    nodes = []
    for req in sorted(states):
        status = "original" if states[req] == merge._ACTIVE else "adjudicated"
        nodes.append({
            "nodeId": f"req:{req}",
            "kind": "requirement",
            "scopeId": WORKTREE_SCOPE_ID,
            "title": req,
            "status": status,
            "sources": [{"path": MATRIX_RELPATH, "anchor": None,
                         "requirementIds": [req], "oqIds": []}],
            "detail": {"state": states[req]},
        })
    return nodes


def _module_source(module_scope, anchor):
    return {"path": f"{module_scope}/prd.md", "anchor": anchor,
            "requirementIds": [], "oqIds": []}


def _compile_module(module_scope, text, nodes, edges, gaps):
    """解析单模块三张表，向 nodes/edges/gaps 追加解析结果。"""
    page_titles = {}
    seen_edge_ids = set()

    def _add_edge(edge):
        # 同一逻辑边多行声明时合并来源，绝不产出重复 edgeId。
        if edge["edgeId"] in seen_edge_ids:
            return
        seen_edge_ids.add(edge["edgeId"])
        edges.append(edge)

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
        for row in rows:
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
                    "detail": {"entry": entry, "role": row[2],
                               "precondition": row[3], "actions": []},
                }
                page_nodes[title] = node
                nodes.append(node)
            node["detail"]["actions"].append({"action": row[4], "result": row[5]})
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

    status, header, rows = _find_section_table(text, _DATA_MARKER)
    if status == "absent":
        gaps.append({"gapId": f"gap:{module_scope}:data-rw",
                     "scopeId": module_scope, "kind": "missing-section",
                     "detail": "模块缺少「数据读写（机器可解析）」章节，数据流待深化",
                     "backlogRef": None})
    elif status == "ok" and header != _DATA_HEADER:
        gaps.append({"gapId": f"gap:{module_scope}:data-rw",
                     "scopeId": module_scope, "kind": "unparsed",
                     "detail": f"数据读写表头列序不符，无法机械解析: {header}",
                     "backlogRef": None})
    elif status == "ok":
        source = _module_source(module_scope, _DATA_MARKER)
        seen_objects = {}
        for row in rows:
            if len(row) < len(_DATA_HEADER) or not row[0]:
                continue
            obj, op, authority, sync_mode = row[0], row[1], row[2], row[3]
            obj_id = f"obj:{module_scope}:{obj}"
            if obj_id not in seen_objects:
                seen_objects[obj_id] = True
                nodes.append({
                    "nodeId": obj_id, "kind": "dataObject", "scopeId": module_scope,
                    "title": obj, "status": "original", "sources": [source],
                    "detail": {"authoritativeSource": authority}})
            # 「读写」一行产出两条边——写操作不得被静默丢弃。
            kinds = [k for marker, k in (("读", "reads"), ("写", "writes"))
                     if marker in op]
            for kind in kinds:
                _add_edge({
                    "edgeId": f"{kind}:{module_scope}:{obj}",
                    "kind": kind, "from": module_scope, "to": obj_id,
                    "status": "original", "sources": [source],
                    "detail": {"authoritativeSource": authority,
                               "syncMethod": sync_mode}})

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

    nodes = _requirement_nodes(_requirement_states(root))
    edges = []
    gaps = []
    for module_scope, _system_scope, path in module_prds:
        _compile_module(module_scope, path.read_text(encoding="utf-8"),
                        nodes, edges, gaps)
    _resolve_interact_targets(edges, module_scopes)

    nodes.sort(key=lambda n: (n["kind"], n["nodeId"]))
    edges.sort(key=lambda e: (e["kind"], e["edgeId"]))
    gaps.sort(key=lambda g: g["gapId"])

    coverage = {
        "moduleCount": len(module_scopes),
        "pageCount": len([n for n in nodes if n["kind"] == "page"]),
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


def _render_html(model, atlas_manifest):
    def esc(value):
        return _html.escape(str(value))

    short = esc(_short_digest(atlas_manifest))
    parts = [
        "<!DOCTYPE html>",
        '<html lang="zh">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Logic Atlas</title>",
        "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.6}"
        "h1,h2{border-bottom:1px solid #ddd}code{background:#f4f4f4;padding:0 .3em}</style>",
        "</head>",
        "<body>",
        "<h1>Logic Atlas</h1>",
        '<p>本视图由 logic-model.json 确定性生成，自述生成快照，不代表「当前最新」。</p>',
        "<ul>",
        f"<li>生成器版本: {esc(atlas_manifest['generatorVersion'])}</li>",
        f"<li>权威主本快照: <code>{short}</code></li>",
        f"<li>阶段: {esc(atlas_manifest['stage'])}</li>",
        "</ul>",
        "<h2>页面</h2>",
        "<ul>",
    ]
    for node in model["nodes"]:
        if node["kind"] == "page":
            parts.append(f"<li>[{esc(node['scopeId'])}] {esc(node['title'])}</li>")
    parts.append("</ul>")
    parts.append("<h2>数据对象</h2><ul>")
    for node in model["nodes"]:
        if node["kind"] == "dataObject":
            parts.append(f"<li>[{esc(node['scopeId'])}] {esc(node['title'])}</li>")
    parts.append("</ul>")
    parts.append("<h2>关系</h2><ul>")
    for edge in model["edges"]:
        parts.append(f"<li>{esc(edge['kind'])}: {esc(edge['from'])} → {esc(edge['to'])}</li>")
    parts.append("</ul>")
    parts.append("<h2>缺口</h2><ul>")
    for gap in model["gaps"]:
        parts.append(f"<li>[{esc(gap['scopeId'])}] {esc(gap['kind'])}: {esc(gap['detail'])}</li>")
    parts.append("</ul>")
    parts += ["</body>", "</html>"]
    return "\n".join(parts) + "\n"


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
