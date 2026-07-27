"""把 Logic Model 的系统/模块/交互/数据流边确定性编译为 Archify Architecture IR。

「系统关系」总览的唯一权威布局来源：列 = 系统边界，列内行序 = 侧栏顺序
（byPath），连接 = interacts（模块调用）与 owns/shares（数据流）按有向模块对
聚合。绝不为布局发明或删减关系；无法落到模块组件上的端点（external:* 等）
记入数据缺口，与既有 viewer 行为一致（那些边本就不在总览渲染）。

密度靠几何自适应，不靠按系统边界预筛：列间隙宽度由该间隙实际承载的车道数与
最宽标签算出，需求大就撑开画布，绝不因为「放不下」而丢关系——丢关系会让读者
把「图上没有」误读成「关系不存在」。模块少、关系稀疏的项目维持基准间隙，
画布不会无谓变宽。

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
_LABEL_CLEARANCE = 10  # 相邻车道标签之间的最小水平净空（低于此值即判为压叠）
_LABEL_ROW = 11      # 外通道标签逐车道纵向错开的行距（字号 8 + 行间距）


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


# 数据流边（owns/shares）没有 direction/relation 字段，按边类型给固定词条。
_DATA_FLOW_TERMS = {"owns": "数据主本", "shares": "共用对象"}


def _connection_label(edges):
    """逐边真实方向文字聚合为短标签；聚合多条时缀 ×N（呈现聚合非数据删减）。"""
    def _field(name):
        values = []
        for edge in edges:
            if edge.get("kind") != "interacts":
                continue
            value = (edge.get("detail") or {}).get(name)
            if value and value not in values:
                values.append(value)
        return sorted(values)

    parts = _field("direction") or _field("relation")
    data_terms = sorted({
        _DATA_FLOW_TERMS[edge["kind"]] for edge in edges
        if edge.get("kind") in _DATA_FLOW_TERMS})
    parts = list(parts) + data_terms
    label = "/".join(parts) if parts else "interacts"
    if len(edges) > 1:
        label += " ×" + str(len(edges))
    return label


def _connection_variant(edges):
    """调用与数据流的视觉分层：只有数据流走虚线，两者兼有的耦合最强，加重。"""
    kinds = {edge.get("kind") for edge in edges}
    has_call = "interacts" in kinds
    has_data = bool(kinds & set(_DATA_FLOW_TERMS))
    if has_call and has_data:
        return "emphasis"
    if has_data:
        return "dashed"
    return "default"


def _grid_positions(systems, modules_by_system):
    """模块 scopeId → (列, 行)。列 = 系统序，行 = 列内侧栏序。"""
    col_row = {}
    for col, system in enumerate(systems):
        for row, module in enumerate(modules_by_system[system["scopeId"]]):
            col_row[module["scopeId"]] = (col, row)
    return col_row


def _channel_of(conn, col_row, pair_set):
    """连接归属：直连不占通道；其余落到某条外侧/列间通道。"""
    src, dst = conn["from"], conn["to"]
    cf, ct = col_row[src][0], col_row[dst][0]
    if cf == ct:
        bidir = (dst, src) in pair_set
        if abs(col_row[src][1] - col_row[dst][1]) == 1 and not bidir:
            return None
        return ("intra", cf)
    return ("inter", min(cf, ct))


def _group_connections(connections, col_row):
    """按通道分组；返回 (直连列表, {通道: 连接列表})。布局与预算共用同一套判定。"""
    pair_set = {(conn["from"], conn["to"]) for conn in connections}
    straight = []
    channels = defaultdict(list)
    for conn in connections:
        channel = _channel_of(conn, col_row, pair_set)
        if channel is None:
            straight.append(conn)
        else:
            channels[channel].append(conn)
    return straight, channels


def _channel_lane_count(conns, col_row):
    """该通道占用的车道数：y 区间重叠的连接必须分层，这才是争抢水平净空的量。"""
    items = []
    for conn in conns:
        ys = sorted((_row_y(col_row[conn["from"]][1]) + _CH / 2,
                     _row_y(col_row[conn["to"]][1]) + _CH / 2))
        items.append(((conn["from"], conn["to"]), ys[0], ys[1]))
    lanes = _lane_assign(items)
    return (max(lanes.values()) + 1) if lanes else 0


def _channel_demand(conns, col_row):
    """该通道需要的净宽：车道数 ×（最宽标签 + 净空）。"""
    if not conns:
        return 0.0
    lanes = _channel_lane_count(conns, col_row)
    widest = max(_est_label_width(conn["label"]) for conn in conns)
    return lanes * (widest + _LABEL_CLEARANCE)


def _gutter_index(kind, col, col_count):
    """通道落在哪条列间隙上；首/末列的 intra 走画布外，返回 None。"""
    if kind == "inter":
        return col
    if 0 < col < col_count - 1:
        return col - 1        # 中列 intra 外挂在左侧相邻间隙
    return None


def _gap_widths(channels, col_row, col_count):
    """逐条列间隙按实际需求定宽，不足处撑开，绝不因放不下而裁掉关系。

    宽度随需求增长而不是把连接裁掉：撑宽画布只让读者多滚动一点，裁连接却会让
    「图上没有」被误读成「关系不存在」。同一条间隙可能同时承载跨列 inter 与
    中列外挂 intra，二者物理共用净空，按需求求和后再各分一段，避免互相压线。
    """
    gaps = [float(_GAPX)] * max(0, col_count - 1)
    for (kind, col), conns in channels.items():
        index = _gutter_index(kind, col, col_count)
        if index is None or not 0 <= index < len(gaps):
            continue
        gaps[index] = max(gaps[index], 0.0)
    demand = [0.0] * len(gaps)
    for (kind, col), conns in channels.items():
        index = _gutter_index(kind, col, col_count)
        if index is None or not 0 <= index < len(gaps):
            continue
        demand[index] += _channel_demand(conns, col_row)
    for index, need in enumerate(demand):
        required = need + 2 * (_PAD + _GUTTER_MARGIN)
        gaps[index] = max(_GAPX, required)
    return [round(width, 1) for width in gaps]


def _outer_step(conns):
    """列外侧通道的车道间距，保持基准步距。

    不按标签宽度横向撑开：外通道车道多时横向撑开会把画布拉宽数百像素、整图
    缩到看不清。相邻车道的标签改为逐层纵向错开（labelDy），同样不压叠，
    但不吃画布宽度。有界的列间隙才靠撑宽解决（见 _gap_widths）。
    """
    del conns
    return float(_LANE_STEP)


def _left_margin(channels, col_row):
    """首列外侧通道向左伸出的距离，决定画布原点。

    viewBox 原点固定在 (0,0)，负坐标会被直接裁掉；外通道按标签撑开后伸得更远，
    原点必须跟着右移，否则最外侧那条车道的标签会被切掉（文本越界回归）。
    """
    conns = channels.get(("intra", 0))
    if not conns:
        return float(_X0)
    lanes = _channel_lane_count(conns, col_row)
    widest = max(_est_label_width(conn["label"]) for conn in conns)
    reach = (_PAD + _LANE_BASE + max(0, lanes - 1) * _outer_step(conns)
             + widest / 2 + _LABEL_CLEARANCE)
    return max(float(_X0), reach)


def _column_positions(gaps, origin=None):
    """由逐条间隙宽度累加出每列左缘 x。"""
    xs = [float(_X0) if origin is None else float(origin)]
    for width in gaps:
        xs.append(xs[-1] + _CW + width)
    return xs


def _gutter_span(col_x, index):
    """第 index 条间隙的可用净空区间（避开两侧 region 描边）。"""
    lo = col_x[index] + _CW + _PAD + _GUTTER_MARGIN
    hi = col_x[index + 1] - _PAD - _GUTTER_MARGIN
    return lo, hi


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
        # 总览呈现两类跨模块耦合：interacts（模块调用）与 owns/shares（数据流）。
        # 数据流边此前只存在于模块内视图，总览看不到「谁的数据流向谁」。
        if edge.get("kind") not in ("interacts", "owns", "shares"):
            continue
        src = _resolve_module(edge.get("from", ""), module_set)
        dst = _resolve_module(edge.get("to", ""), module_set)
        if src is None or dst is None:
            unresolved.append(edge)
            continue
        if src == dst:
            # 同模块内的 owns/shares 不是跨模块耦合，正常跳过；与 interacts
            # 自环一并如实记入 unresolved，不静默丢弃。
            unresolved.append(edge)
            continue
        pairs[(src, dst)].append(edge)

    connections = []
    for (src, dst) in sorted(pairs):
        edges = sorted(pairs[(src, dst)], key=lambda item: item["edgeId"])
        connections.append({
            "id": connection_id(src, dst),
            "from": src,
            "to": dst,
            "label": _connection_label(edges),
            "variant": _connection_variant(edges),
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
    last_col = len(systems) - 1

    # 行序与列序不依赖 x，可先定；再按各间隙的实际车道需求把 x 撑开。
    col_row = _grid_positions(systems, modules_by_system)
    _, channels = _group_connections(data["connections"], col_row)
    gaps = _gap_widths(channels, col_row, len(systems))
    origin_x = _left_margin(channels, col_row)
    col_x = _column_positions(gaps, origin_x)

    components = []
    for system in systems:
        for module in modules_by_system[system["scopeId"]]:
            scope_id = module["scopeId"]
            col, row = col_row[scope_id]
            components.append({
                "id": component_id(scope_id),
                "type": "backend" if scope_id in structured else "external",
                "label": str(module.get("title") or scope_id),
                "pos": [round(col_x[col], 1), _row_y(row)],
                "size": [_CW, _CH],
            })

    def cx(scope):
        return col_x[col_row[scope][0]] + _CW / 2

    def cy(scope):
        return _row_y(col_row[scope][1]) + _CH / 2

    straight, channels = _group_connections(data["connections"], col_row)

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
            "variant": conn["variant"],
            "fromSide": "bottom" if below else "top",
            "toSide": "top" if below else "bottom",
            "labelAt": [round(cx(src), 1), round(mid_y, 1)],
        })

    # 同一条间隙可能同时挂 inter 与中列 intra，二者物理共用净空。按各自需求把
    # 净空切成互不重叠的两段，避免两次独立分车道后压线（既有隐患）。
    gutter_slots = {}
    for index in range(len(gaps)):
        span_lo, span_hi = _gutter_span(col_x, index)
        sharers = sorted(
            key for key in channels
            if _gutter_index(key[0], key[1], len(systems)) == index)
        total = sum(
            _channel_demand(channels[key], col_row) for key in sharers)
        cursor = span_lo
        for key in sharers:
            share = ((span_hi - span_lo)
                     * (_channel_demand(channels[key], col_row) / total)
                     if total else (span_hi - span_lo) / max(1, len(sharers)))
            gutter_slots[key] = (cursor, cursor + share)
            cursor += share

    for group, conns in sorted(channels.items()):
        kind, col = group
        items = []
        for conn in conns:
            lo, hi = sorted((cy(conn["from"]), cy(conn["to"])))
            items.append(((conn["from"], conn["to"]), lo, hi))
        lanes = _lane_assign(items)
        lane_count = max(lanes.values()) + 1 if lanes else 1
        # 列外侧通道向画布外延伸：标签放不下就撑开车道间距，同样不裁连接。
        outer_step = _outer_step(conns)
        for conn in conns:
            src, dst = conn["from"], conn["to"]
            lane = lanes[(src, dst)]
            sy, ty = cy(src), cy(dst)
            outer = kind == "intra" and col in (0, last_col)
            if kind == "intra" and col == 0:
                chx = col_x[0] - _PAD - _LANE_BASE - lane * outer_step
                from_side = to_side = "left"
            elif kind == "intra" and col == last_col:
                chx = col_x[col] + _CW + _PAD + _LANE_BASE + lane * outer_step
                from_side = to_side = "right"
            else:
                lo, hi = gutter_slots[group]
                chx = lo + (hi - lo) * (lane + 1) / (lane_count + 1)
                if kind == "intra":
                    from_side = to_side = "left"
                elif col_row[src][0] == col:
                    from_side, to_side = "right", "left"
                else:
                    from_side, to_side = "left", "right"
            chx = round(chx, 1)
            entry = {
                "id": conn["id"],
                "from": component_id(src),
                "to": component_id(dst),
                "label": conn["label"],
                "variant": conn["variant"],
                "fromSide": from_side,
                "toSide": to_side,
                "via": [[chx, round(sy, 1)], [chx, round(ty, 1)]],
                "labelAt": [chx, round((sy + ty) / 2, 1)],
            }
            if outer:
                # 外通道车道横向只隔 _LANE_STEP，标签必须逐车道纵向错开，
                # 否则相邻车道的长标签会横向压成一团。
                entry["labelDy"] = round(
                    (lane - (lane_count - 1) / 2) * _LABEL_ROW, 1)
            ir_connections.append(entry)

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
            "subtitle": "模块调用（interacts）与数据流（owns/shares）",
            "quality_profile": "standard",
            # 渲染器默认 preset "classic" 在 vendored 模板无主题变量块，会导致
            # CSS 抽取失败裸嵌黑块；显式选模板支持的 blueprint（与 Lifecycle 同）。
            "visual_preset": "blueprint",
            "viewBox": view_box,
        },
        "layout": {
            "mode": "grid",
            "cols": max(len(systems), 1),
            "origin": [round(origin_x, 1), _Y0],
            # 间隙按需撑开后逐条不同；此处报最大值供渲染器估画布，
            # 组件与连接均带显式坐标，不依赖该值定位。
            "gapX": round(max(gaps), 1) if gaps else _GAPX,
            "gapY": _GAPY,
            "cellW": _CW,
            "cellH": _CH,
        },
        "components": components,
        "boundaries": boundaries,
        "connections": sorted(ir_connections, key=lambda item: item["id"]),
    }


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
