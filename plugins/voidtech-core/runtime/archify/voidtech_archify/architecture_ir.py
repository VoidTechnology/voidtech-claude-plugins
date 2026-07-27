"""把 Logic Model 的系统/模块/interacts 边确定性编译为 Archify Architecture IR。

「系统关系」总览的唯一权威布局来源：列 = 系统边界，列内行序 = 侧栏顺序
（byPath），连接 = 既有 interacts 边按有向模块对聚合。绝不为布局发明或删减
关系；无法落到模块组件上的端点（external:* 等）记入数据缺口，与既有 viewer
行为一致（那些边本就不在总览渲染）。

几何与路由经可行性 spike 校准：24 组件 + 21 连接在 quality standard 下 deliver
零诊断、零文本溢出、字节可复现。同色无标签边不可辨、锚点合并穿卡、方向读不出
三处病灶由「正交通道路由 + 逐边真实方向标签 + 箭头」根治：
- 同列相邻单向边走列间隙直连，标签落在盒间空档；
- 同列非相邻/双向边走列外侧（首/末列）或相邻列间隙（中列）的确定性通道，
  多条边按 y 区间着色分层，互不重叠且不穿任何组件盒；
- 跨列边走两列之间的间隙通道，垂直段落在边界描边之间的净空带。
"""

from __future__ import annotations

from collections import defaultdict

from . import lifecycle_ir

canonical_ir_bytes = lifecycle_ir.canonical_ir_bytes

# ---- 几何常量（spike 校准；同输入字节一致）---------------------------------
_X0 = 300          # 首列左缘 x（左侧留足首列外通道 + 标签，避免负坐标裁切）
_Y0 = 150          # 首行上缘 y
_CW = 200          # 组件盒宽（容得下最长模块标题，见 layout/constraint 校验）
_CH = 58           # 组件盒高
_GAPX = 300        # 列间隙（容跨列 + 中列外挂通道，避开两侧边界描边）
_GAPY = 54         # 行间隙（相邻直连标签落在此空档，净空充足）
_PAD = 30          # region 边界内边距（与渲染器 region padding 一致）
_LANE_STEP = 38    # 外通道相邻层水平步距
_LANE_BASE = 20    # 外通道首层距盒缘偏移
_GUTTER_MARGIN = 16  # 间隙通道距边界描边的安全余量
_LABEL_FONT = 8.0    # 连接标签字号（与渲染器 architecture 标签同口径估宽）


def component_id(scope_id):
    """模块 scopeId → 稳定组件 id（满足 archify id 语法且可逆映射回 moduleId）。"""
    return "m-" + scope_id.replace("/", "__")


def connection_id(from_scope, to_scope):
    return "c-" + from_scope.replace("/", "__") + "--" + to_scope.replace("/", "__")


def _est_label_width(text, font_size=_LABEL_FONT):
    """CJK 感知估宽：全宽字形 ≈ font_size，半宽 ≈ 0.55×font_size。"""
    return sum(font_size if ord(ch) > 0x2E80 else font_size * 0.55 for ch in text)


def _by_path(scope):
    return scope.get("path") or scope.get("scopeId") or ""


def _structured_scopes(model):
    """与 viewer modMeta.structured 同口径：含页面/数据/用户流程/业务状态节点。"""
    counts = defaultdict(int)
    for node in model.get("nodes") or []:
        kind = node.get("kind")
        detail = node.get("detail") or {}
        if kind in ("page", "dataObject"):
            counts[node.get("scopeId")] += 1
        elif kind == "flow" and detail.get("category") == "userFlow":
            counts[node.get("scopeId")] += 1
        elif kind == "state" and detail.get("category") == "businessState":
            counts[node.get("scopeId")] += 1
    return {scope_id for scope_id, count in counts.items() if count > 0}


def _resolve_module(endpoint, module_set):
    """把 interacts 边端点解析回模块 scopeId；解析不到（external:* 等）返回 None。"""
    if endpoint in module_set:
        return endpoint
    if ":" in endpoint:
        rest = endpoint.split(":", 1)[1]
        candidates = [
            mm for mm in module_set
            if rest == mm or rest.startswith(mm + ":") or rest.startswith(mm + "/")
        ]
        if candidates:
            return max(candidates, key=len)
    return None


def _connection_label(edges):
    """逐边真实方向文字聚合为短标签；聚合多条时缀 ×N（呈现聚合非数据删减）。"""
    def _field(name):
        values = []
        for edge in edges:
            value = (edge.get("detail") or {}).get(name)
            if value and value not in values:
                values.append(value)
        return sorted(values)

    parts = _field("direction") or _field("relation")
    label = "/".join(parts) if parts else "interacts"
    if len(edges) > 1:
        label += " ×" + str(len(edges))
    return label


def extract_architecture(model):
    """纯数据层：系统序、列内模块序、结构化集合、有向模块对聚合、数据缺口。

    不含几何，供单测冻结映射/聚合规则。
    """
    scopes = model.get("scopes") or []
    systems = sorted(
        (s for s in scopes if s.get("kind") == "system"), key=_by_path)
    modules = sorted(
        (s for s in scopes if s.get("kind") == "module"), key=_by_path)
    module_set = {s["scopeId"] for s in modules}
    modules_by_system = defaultdict(list)
    for module in modules:
        modules_by_system[module.get("parentScopeId")].append(module)
    structured = _structured_scopes(model)

    pairs = defaultdict(list)
    unresolved = []
    for edge in model.get("edges") or []:
        if edge.get("kind") != "interacts":
            continue
        src = _resolve_module(edge.get("from", ""), module_set)
        dst = _resolve_module(edge.get("to", ""), module_set)
        if src is None or dst is None:
            unresolved.append(edge)
            continue
        if src == dst:
            unresolved.append(edge)
            continue
        pairs[(src, dst)].append(edge)

    connections = []
    for (src, dst) in sorted(pairs):
        edges = pairs[(src, dst)]
        connections.append({
            "id": connection_id(src, dst),
            "from": src,
            "to": dst,
            "label": _connection_label(edges),
            "edgeIds": [edge["edgeId"] for edge in edges],
        })
    return {
        "systems": systems,
        "modulesBySystem": modules_by_system,
        "structured": structured,
        "connections": connections,
        # 端点落在模块组件之外（external:* 或自环）而无法作为跨模块连接呈现的边；
        # 与既有总览一致地不渲染，如实记为数据缺口。
        "unresolved": unresolved,
    }


def component_module_ids(model):
    """componentId → moduleScopeId（viewer 点击下钻映射的权威来源）。"""
    data = extract_architecture(model)
    result = {}
    for system in data["systems"]:
        for module in data["modulesBySystem"][system["scopeId"]]:
            result[component_id(module["scopeId"])] = module["scopeId"]
    return result


def connection_edge_ids(model):
    """connectionId → 聚合的原始 interacts edgeId 列表（点击展开全部边）。"""
    data = extract_architecture(model)
    return {conn["id"]: list(conn["edgeIds"]) for conn in data["connections"]}


def _lane_assign(items):
    """区间图贪心着色：y 区间重叠的通道边分层，返回 {key: lane}。确定性。"""
    lanes = {}
    active = []  # (y_high, lane)
    for key, y_low, y_high in sorted(items, key=lambda z: (z[1], z[2], z[0])):
        used = {lane for high, lane in active if high >= y_low - 1}
        lane = 0
        while lane in used:
            lane += 1
        lanes[key] = lane
        active.append((y_high, lane))
    return lanes


def build_architecture_ir(model):
    """生成键序、数组序、几何均稳定的 schema-v1 Architecture IR。"""
    data = extract_architecture(model)
    systems = data["systems"]
    modules_by_system = data["modulesBySystem"]
    structured = data["structured"]
    sys_index = {s["scopeId"]: i for i, s in enumerate(systems)}
    last_col = len(systems) - 1

    col_row = {}
    components = []
    for system in systems:
        col = sys_index[system["scopeId"]]
        for row, module in enumerate(modules_by_system[system["scopeId"]]):
            scope_id = module["scopeId"]
            col_row[scope_id] = (col, row)
            components.append({
                "id": component_id(scope_id),
                "type": "backend" if scope_id in structured else "external",
                "label": str(module.get("title") or scope_id),
                "pos": [_col_x(col), _row_y(row)],
                "size": [_CW, _CH],
            })

    def cx(scope):
        return _col_x(col_row[scope][0]) + _CW / 2

    def cy(scope):
        return _row_y(col_row[scope][1]) + _CH / 2

    # 连接分组：直连（同列相邻单向）/ 通道（同列非相邻或双向、跨列）
    pair_set = {(conn["from"], conn["to"]) for conn in data["connections"]}
    straight = []
    channels = defaultdict(list)
    for conn in data["connections"]:
        src, dst = conn["from"], conn["to"]
        cf, ct = col_row[src][0], col_row[dst][0]
        if cf == ct:
            bidir = (dst, src) in pair_set
            if abs(col_row[src][1] - col_row[dst][1]) == 1 and not bidir:
                straight.append(conn)
            else:
                channels[("intra", cf)].append(conn)
        else:
            channels[("inter", min(cf, ct))].append(conn)

    ir_connections = []
    for conn in straight:
        src, dst = conn["from"], conn["to"]
        below = col_row[dst][1] > col_row[src][1]
        lower_row = min(col_row[src][1], col_row[dst][1])
        mid_y = _row_y(lower_row) + _CH + _GAPY / 2
        ir_connections.append({
            "id": conn["id"],
            "from": component_id(src),
            "to": component_id(dst),
            "label": conn["label"],
            "fromSide": "bottom" if below else "top",
            "toSide": "top" if below else "bottom",
            "labelAt": [round(cx(src), 1), round(mid_y, 1)],
        })

    for group, conns in channels.items():
        kind, col = group
        items = []
        for conn in conns:
            lo, hi = sorted((cy(conn["from"]), cy(conn["to"])))
            items.append(((conn["from"], conn["to"]), lo, hi))
        lanes = _lane_assign(items)
        lane_count = max(lanes.values()) + 1 if lanes else 1
        for conn in conns:
            src, dst = conn["from"], conn["to"]
            lane = lanes[(src, dst)]
            sy, ty = cy(src), cy(dst)
            if kind == "intra" and col == 0:
                chx = _col_x(0) - _PAD - _LANE_BASE - lane * _LANE_STEP
                from_side = to_side = "left"
            elif kind == "intra" and col == last_col:
                chx = _col_x(col) + _CW + _PAD + _LANE_BASE + lane * _LANE_STEP
                from_side = to_side = "right"
            elif kind == "intra":
                # 中列：挂到左侧相邻间隙内（边界描边之间的净空带），左出左回
                lo = _col_x(col - 1) + _CW + _PAD + _GUTTER_MARGIN
                hi = _col_x(col) - _PAD - _GUTTER_MARGIN
                chx = lo + (hi - lo) * (lane + 1) / (lane_count + 1)
                from_side = to_side = "left"
            else:  # inter：两列之间的间隙通道
                lo = _col_x(col) + _CW + _PAD + _GUTTER_MARGIN
                hi = _col_x(col + 1) - _PAD - _GUTTER_MARGIN
                chx = lo + (hi - lo) * (lane + 1) / (lane_count + 1)
                if col_row[src][0] == col:
                    from_side, to_side = "right", "left"
                else:
                    from_side, to_side = "left", "right"
            chx = round(chx, 1)
            ir_connections.append({
                "id": conn["id"],
                "from": component_id(src),
                "to": component_id(dst),
                "label": conn["label"],
                "fromSide": from_side,
                "toSide": to_side,
                "via": [[chx, round(sy, 1)], [chx, round(ty, 1)]],
                "labelAt": [chx, round((sy + ty) / 2, 1)],
            })

    boundaries = [{
        "kind": "region",
        "label": str(system.get("title") or system["scopeId"]),
        "wraps": [
            component_id(module["scopeId"])
            for module in modules_by_system[system["scopeId"]]
        ],
    } for system in systems if modules_by_system[system["scopeId"]]]

    view_box = _tight_view_box(components, ir_connections)
    return {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {
            "title": "系统关系总览",
            "subtitle": "模块交互（interacts）",
            "quality_profile": "standard",
            # 渲染器默认 preset "classic" 在 vendored 模板无主题变量块，会导致
            # CSS 抽取失败裸嵌黑块；显式选模板支持的 blueprint（与 Lifecycle 同）。
            "visual_preset": "blueprint",
            "viewBox": view_box,
        },
        "layout": {
            "mode": "grid",
            "cols": max(len(systems), 1),
            "origin": [_X0, _Y0],
            "gapX": _GAPX,
            "gapY": _GAPY,
            "cellW": _CW,
            "cellH": _CH,
        },
        "components": components,
        "boundaries": boundaries,
        "connections": sorted(ir_connections, key=lambda item: item["id"]),
    }


def _col_x(col):
    return _X0 + col * (_CW + _GAPX)


def _row_y(row):
    return _Y0 + row * (_CH + _GAPY)


def _tight_view_box(components, connections):
    """viewBox 收紧到组件 + 边界 + 通道 + 标签外接框（含右/下留白）。

    渲染器 auto-fit 只覆盖组件与图例，不含挂到列外/间隙的通道与其标签——
    必须由 IR 侧显式给出 viewBox，否则外通道标签会被裁切（文本越界回归）。
    """
    max_x = max_y = 0.0
    for comp in components:
        px, py = comp["pos"]
        w, h = comp["size"]
        max_x = max(max_x, px + w + _PAD)
        max_y = max(max_y, py + h + 50)
    for conn in connections:
        for point in conn.get("via", []):
            max_x = max(max_x, point[0])
            max_y = max(max_y, point[1])
        label_at = conn.get("labelAt")
        if label_at:
            max_x = max(
                max_x, label_at[0] + _est_label_width(conn["label"]) / 2 + 4)
            max_y = max(max_y, label_at[1])
    return [round(max_x + 40), round(max_y + 40)]
