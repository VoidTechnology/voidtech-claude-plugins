"""把 Logic Model 业务状态机确定性编译为 Archify Lifecycle IR。"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict

SUCCESS_KEYWORDS = ("通过", "生效", "成功")
FAILURE_KEYWORDS = ("未通过", "失败", "拒绝")
WAITING_KEYWORDS = ("待", "暂停", "到期")

_LANE_ORDER = ("main", "branch", "terminal")
_LANE_LABELS = {
    "main": "主生命周期",
    "branch": "中断与恢复",
    "terminal": "结果",
}
_LANE_MAX_COL = {"main": 4, "branch": 2, "terminal": 2}
# Archify lifecycle 渲染器固定的列心与状态半宽（vendor renderers/lifecycle
# 布局预算）。用于把 meta.viewBox 收紧到内容外接框——列心不随 viewBox 缩放，
# 收紧只是去除右侧/底部空白，状态坐标不变。
_PHASE_XS = (94, 248, 402, 556, 710)
_BAND_XS = (402, 556, 710)
_STATE_HALF_W = {"main": 59, "event": 63, "terminal": 59}
# 渲染器内置英文 Legend 固定在 x220–620；viewer 会移除它，但为保持 Archify
# 交付产物自洽，宽度下限仍留足图例位。
_VIEWBOX_LEGEND_FLOOR = 652
# 右向回环通道贴着最右状态右缘落在 state_right+36，其贴边标签再向右延伸约
# 半个标签宽；为「最右状态右缘 → 通道 → 标签右缘」预留固定余量，保证收紧后
# 的 viewBox 始终容得下（渲染器不校验通道/标签越界，必须由 IR 侧留足）。
_RIGHT_CHANNEL_RESERVE = 160


def _stable_id(prefix, value):
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def state_ir_id(node_id):
    return _stable_id("state", node_id)


def transition_ir_id(edge_id):
    return _stable_id("transition", edge_id)


def canonical_ir_bytes(ir):
    return (json.dumps(
        ir, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n").encode("utf-8")


def extract_machines(model):
    """按 scope + 业务对象分组，状态端点并集为机器节点集合。"""
    states = {}
    groups = defaultdict(dict)
    for node in model.get("nodes", []):
        detail = node.get("detail") or {}
        if node.get("kind") != "state" or detail.get("category") != "businessState":
            continue
        node_id = node.get("nodeId")
        scope_id = node.get("scopeId")
        object_name = detail.get("object") or "未命名对象"
        if not node_id or not scope_id:
            continue
        states[node_id] = node
        groups[(scope_id, object_name)][node_id] = node

    grouped_edges = defaultdict(list)
    for edge in model.get("edges", []):
        if edge.get("kind") != "transition":
            continue
        source = states.get(edge.get("from"))
        target = states.get(edge.get("to"))
        if source is None or target is None:
            continue
        source_detail = source.get("detail") or {}
        target_detail = target.get("detail") or {}
        key = (source.get("scopeId"), source_detail.get("object") or "未命名对象")
        if key != (target.get("scopeId"), target_detail.get("object") or "未命名对象"):
            continue
        grouped_edges[key].append(edge)

    machines = []
    for (scope_id, object_name), node_map in sorted(groups.items()):
        machine_key = f"{scope_id}\0{object_name}"
        machines.append({
            "machineId": _stable_id("machine", machine_key),
            "scopeId": scope_id,
            "object": object_name,
            "states": sorted(node_map.values(), key=lambda item: item["nodeId"]),
            "transitions": sorted(
                grouped_edges[(scope_id, object_name)],
                key=lambda item: item["edgeId"]),
        })
    return machines


def _tarjan(node_ids, adjacency):
    index = 0
    stack = []
    on_stack = set()
    indices = {}
    lowlinks = {}
    components = []

    def visit(node_id):
        nonlocal index
        indices[node_id] = index
        lowlinks[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)
        for target in adjacency[node_id]:
            if target not in indices:
                visit(target)
                lowlinks[node_id] = min(lowlinks[node_id], lowlinks[target])
            elif target in on_stack:
                lowlinks[node_id] = min(lowlinks[node_id], indices[target])
        if lowlinks[node_id] != indices[node_id]:
            return
        component = []
        while True:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == node_id:
                break
        components.append(tuple(sorted(component)))

    for node_id in sorted(node_ids):
        if node_id not in indices:
            visit(node_id)
    return sorted(components, key=lambda component: component[0])


def _component_graph(node_ids, edges):
    adjacency = {node_id: [] for node_id in node_ids}
    for edge in edges:
        source, target = edge["from"], edge["to"]
        if source in adjacency and target in adjacency and target not in adjacency[source]:
            adjacency[source].append(target)
    for targets in adjacency.values():
        targets.sort()

    components = _tarjan(node_ids, adjacency)
    component_of = {
        node_id: component_index
        for component_index, component in enumerate(components)
        for node_id in component
    }
    successors = {index: set() for index in range(len(components))}
    predecessors = {index: set() for index in range(len(components))}
    for source, targets in adjacency.items():
        source_component = component_of[source]
        for target in targets:
            target_component = component_of[target]
            if source_component == target_component:
                continue
            successors[source_component].add(target_component)
            predecessors[target_component].add(source_component)
    return adjacency, components, component_of, successors, predecessors


def _component_depths(components, successors, predecessors):
    keys = {index: components[index][0] for index in range(len(components))}
    indegree = {index: len(predecessors[index]) for index in range(len(components))}
    ready = sorted(
        (index for index, degree in indegree.items() if degree == 0),
        key=lambda item: keys[item])
    order = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for target in sorted(successors[current], key=lambda item: keys[item]):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort(key=lambda item: keys[item])
    depths = {index: 0 for index in range(len(components))}
    paths: dict[int, tuple[int, ...]] = {
        index: (index,) for index in range(len(components))}
    for current in order:
        for target in sorted(successors[current], key=lambda item: keys[item]):
            candidate_depth = depths[current] + 1
            candidate_path = paths[current] + (target,)
            if (candidate_depth > depths[target]
                    or (candidate_depth == depths[target]
                        and tuple(keys[item] for item in candidate_path)
                        < tuple(keys[item] for item in paths[target]))):
                depths[target] = candidate_depth
                paths[target] = candidate_path
    return depths, paths


def _main_components(components, paths, terminal_components):
    candidates = terminal_components or set(range(len(components)))
    if not candidates:
        return set()
    keys = {index: components[index][0] for index in range(len(components))}
    chosen = min(
        candidates,
        key=lambda index: (
            -len(paths[index]),
            tuple(keys[item] for item in paths[index]),
        ))
    return set(paths[chosen])


def _compressed_columns(state_rows):
    columns = {}
    by_lane = defaultdict(list)
    for row in state_rows:
        by_lane[row["lane"]].append(row)
    for lane, rows in by_lane.items():
        if lane == "terminal" and len(rows) <= _LANE_MAX_COL[lane] + 1:
            for column, row in enumerate(sorted(
                    rows, key=lambda item: (item["depth"], item["nodeId"]))):
                columns[row["nodeId"]] = column
            continue
        depths = sorted({row["depth"] for row in rows})
        max_col = _LANE_MAX_COL[lane]
        rank = {depth: index for index, depth in enumerate(depths)}
        for row in rows:
            if len(depths) <= 1:
                column = 0
            elif len(depths) <= max_col + 1:
                column = rank[row["depth"]]
            else:
                column = round(rank[row["depth"]] * max_col / (len(depths) - 1))
            columns[row["nodeId"]] = column
    return columns


def _state_type(node, indegree, outdegree):
    if indegree == 0:
        return "start"
    text = " ".join((
        str(node.get("title") or ""),
        str((node.get("detail") or {}).get("entryCondition") or ""),
    ))
    if outdegree == 0:
        if any(keyword in text for keyword in SUCCESS_KEYWORDS):
            return "success"
        if any(keyword in text for keyword in FAILURE_KEYWORDS):
            return "failure"
        return "neutral"
    if any(keyword in text for keyword in WAITING_KEYWORDS):
        return "waiting"
    return "active"


def _transition_label(edge):
    detail = edge.get("detail") or {}
    action = str(detail.get("action") or detail.get("triggerMode") or "流转")
    result = str(detail.get("result") or "")
    return f"{action} → {result}" if result else action


def _label_width(text):
    """与渲染器同口径估算标签宽度：全宽字形计 2 单位，宽度 = units*4.9+12，
    下限 32（见 vendor renderers/lifecycle renderTransitionLabel / textUnits）。"""
    units = sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)
    return max(32.0, units * 4.9 + 12)


def _left_channel_label_dx(label):
    """左通道标签以通道 x=48 为心，宽标签会向左越过 viewBox 左缘（x 恒从 0
    起）被裁切。给一个正的 labelDx 把标签右移到左缘内，仍落在两个堆叠回环状态
    之间的空隙、贴着通道，不遮状态。窄标签无需右移返回 0。"""
    shift = _label_width(label) / 2 - 48 + 8
    return round(shift, 1) if shift > 0 else 0


def _band_of(lane):
    if lane == "main":
        return "main"
    if lane == "terminal":
        return "terminal"
    return "event"


def _tight_viewbox(ir_states):
    """把 viewBox 收紧到内容外接框，消除小状态机「内容挤一角 + 全屏空白」。

    列心/带位由 Archify 渲染器固定，收紧只影响右侧与底部留白：宽度覆盖最右
    状态右缘，并为右向回环通道（渲染器取 state_right+36）及其贴边标签预留
    _RIGHT_CHANNEL_RESERVE，避免收紧后通道/标签落到 viewBox 之外被裁切；高度
    只有在存在 terminal 带节点时才延伸到底部结果带，否则收到 schema 下限 566。"""
    max_right = 0
    used_terminal = False
    for item in ir_states:
        band = _band_of(item["lane"])
        center = _PHASE_XS[item["col"]] if band == "main" else _BAND_XS[item["col"]]
        if band == "terminal":
            used_terminal = True
        max_right = max(max_right, center + _STATE_HALF_W[band])
    width = max(int(max_right) + _RIGHT_CHANNEL_RESERVE, _VIEWBOX_LEGEND_FLOOR)
    height = 660 if used_terminal else 566
    return [width, height]


def build_lifecycle_ir(machine):
    """生成键序、数组序、布局均稳定的 schema-v1 Lifecycle IR。"""
    nodes = {node["nodeId"]: node for node in machine["states"]}
    edges = [edge for edge in machine["transitions"]
             if edge.get("from") in nodes and edge.get("to") in nodes]
    node_ids = sorted(nodes)
    adjacency, components, component_of, successors, predecessors = (
        _component_graph(node_ids, edges))
    depths, paths = _component_depths(components, successors, predecessors)
    indegrees = {node_id: 0 for node_id in node_ids}
    outdegrees = {node_id: len(adjacency[node_id]) for node_id in node_ids}
    for targets in adjacency.values():
        for target in targets:
            indegrees[target] += 1
    terminal_components = {
        component_of[node_id] for node_id in node_ids if outdegrees[node_id] == 0
    }
    main_components = _main_components(components, paths, terminal_components)

    rows = []
    for node_id in node_ids:
        if outdegrees[node_id] == 0:
            lane = "terminal"
        elif component_of[node_id] in main_components:
            lane = "main"
        else:
            lane = "branch"
        rows.append({
            "nodeId": node_id,
            "lane": lane,
            "depth": depths[component_of[node_id]],
        })
    columns = _compressed_columns(rows)

    offsets = {}
    collisions = defaultdict(list)
    for row in rows:
        collisions[(row["lane"], columns[row["nodeId"]])].append(row["nodeId"])
    for members in collisions.values():
        members.sort()
        center = (len(members) - 1) / 2
        for index, node_id in enumerate(members):
            offset = (index - center) * 72
            if offset:
                offsets[node_id] = offset

    state_ids = {node_id: state_ir_id(node_id) for node_id in node_ids}
    ir_states = []
    for row in rows:
        node_id = row["nodeId"]
        node = nodes[node_id]
        detail = node.get("detail") or {}
        item = {
            "id": state_ids[node_id],
            "type": _state_type(node, indegrees[node_id], outdegrees[node_id]),
            "label": str(node.get("title") or node_id),
            "lane": row["lane"],
            "col": columns[node_id],
        }
        sublabel = detail.get("meaning") or detail.get("entryCondition")
        if sublabel:
            item["sublabel"] = str(sublabel)
        if node_id in offsets:
            item["yOffset"] = offsets[node_id]
        ir_states.append(item)

    state_layout = {item["id"]: item for item in ir_states}
    ir_transitions = []
    max_column = max(columns.values(), default=0)
    for edge in edges:
        item = {
            "id": transition_ir_id(edge["edgeId"]),
            "from": state_ids[edge["from"]],
            "to": state_ids[edge["to"]],
            "label": _transition_label(edge),
            "variant": "default",
            "route": "drop",
        }
        source_layout = state_layout[item["from"]]
        target_layout = state_layout[item["to"]]
        if (source_layout["lane"] == target_layout["lane"]
                and source_layout["col"] == target_layout["col"]):
            side = (
                "left"
                if source_layout["col"] <= max_column / 2
                else "right")
            item.update({
                "route": f"{side}-channel",
                "fromSide": side,
                "toSide": side,
            })
            # 左通道用固定近左槽（x=48，任何收紧后的 viewBox 都容得下）；右通道
            # 省略 channelX，由渲染器贴着状态右缘取 state_right+36，避免固定 850
            # 落到收紧 viewBox 之外被裁切（viewBox 已为右通道预留标签位）。
            if side == "left":
                item["channelX"] = 48
                label_dx = _left_channel_label_dx(item["label"])
                if label_dx:
                    item["labelDx"] = label_dx
        ir_transitions.append(item)

    # 已声明终点：mermaid `X --> [*]` 出口。只有当声明出口的状态仍有后继业务
    # 流转时（终点被丢弃、结果带自相矛盾地为空）才补一个显式终点标记，出口边
    # 指向它；结构性终态（无离开边）已在结果带自证，不重复标注。终点标记只依据
    # 已声明的 declaredTerminal 生成，绝不凭空造终点。
    hidden_exits = [
        node_id for node_id in node_ids
        if (nodes[node_id].get("detail") or {}).get("declaredTerminal")
        and outdegrees[node_id] > 0]
    if hidden_exits:
        used_terminal_cols = {
            item["col"] for item in ir_states if item["lane"] == "terminal"}
        marker_col = next(
            (col for col in range(len(_BAND_XS))
             if col not in used_terminal_cols),
            len(_BAND_XS) - 1)
        marker_id = _stable_id("terminal", machine["machineId"])
        ir_states.append({
            "id": marker_id,
            "type": "neutral",
            "label": "已声明终点",
            "lane": "terminal",
            "col": marker_col,
        })
        for node_id in hidden_exits:
            exit_item = {
                "id": _stable_id("transition", f"declared-terminal\0{node_id}"),
                "from": state_ids[node_id],
                "to": marker_id,
                "variant": "default",
                "route": "drop",
            }
            result = (nodes[node_id].get("detail") or {}).get("terminalResult")
            if result:
                exit_item["label"] = str(result)
            ir_transitions.append(exit_item)

    used_lanes = {item["lane"] for item in ir_states}
    # vendor 渲染器对未声明的中间事件带回落英文默认名（render-lifecycle.mjs
    # eventLanes 为空时 'Interruptions + recovery'），三条带无论声明与否都会
    # 绘制——始终声明 branch 带以保证带标题中文，不改 vendor。
    used_lanes.add("branch")
    return {
        "schema_version": 1,
        "diagram_type": "lifecycle",
        "meta": {
            "title": machine["object"],
            "subtitle": machine["scopeId"],
            "animation": "none",
            "visual_preset": "blueprint",
            "viewBox": _tight_viewbox(ir_states),
        },
        "lanes": [
            {"id": lane, "label": _LANE_LABELS[lane]}
            for lane in _LANE_ORDER if lane in used_lanes or lane == "main"
        ],
        "states": sorted(ir_states, key=lambda item: item["id"]),
        "transitions": sorted(ir_transitions, key=lambda item: item["id"]),
    }
