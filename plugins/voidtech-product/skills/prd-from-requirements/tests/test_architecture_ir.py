"""Logic Atlas 到 Archify Architecture IR 的纯函数契约（列/行布局、组件类型
映射、有向边聚合、通道路由、外部端点作为数据缺口）。冻结语义映射，不依赖 Node。
"""

import json
import unittest

from worktree_fixture import SKILL_ROOT  # noqa: F401

from prdsync.core_archify import architecture_ir


def _scope(scope_id, kind, title, parent):
    path = None if kind == "worktree" else scope_id
    return {"scopeId": scope_id, "kind": kind, "title": title,
            "path": path, "parentScopeId": parent}


def _page(scope_id, name):
    return {"nodeId": f"page:{scope_id}:{name}", "kind": "page",
            "scopeId": scope_id, "title": name, "status": "original",
            "sources": [{"path": "prd.md", "anchor": "页面",
                         "requirementIds": [], "oqIds": []}],
            "detail": {}}


def _interacts(edge_id, src, dst, **detail):
    return {"edgeId": edge_id, "kind": "interacts", "from": src, "to": dst,
            "status": "original",
            "sources": [{"path": "prd.md", "anchor": "模块交互",
                         "requirementIds": [], "oqIds": []}],
            "detail": detail}


def _data_edge(edge_id, kind, src, dst):
    return {"edgeId": edge_id, "kind": kind, "from": src, "to": dst,
            "status": "original",
            "sources": [{"path": "prd.md", "anchor": "数据读写",
                         "requirementIds": [], "oqIds": []}],
            "detail": {}}


def _model():
    scopes = [
        _scope("wt", "worktree", "工作树", None),
        _scope("01-a", "system", "甲系统", "wt"),
        _scope("02-b", "system", "乙系统", "wt"),
        _scope("01-a/00-x", "module", "总览甲 PRD", "01-a"),
        _scope("01-a/01-y", "module", "客户管理 PRD", "01-a"),
        _scope("01-a/02-z", "module", "订单", "01-a"),
        _scope("02-b/00-p", "module", "总览乙", "02-b"),
        _scope("02-b/01-q", "module", "会员", "02-b"),
    ]
    # 结构化：仅 01-a/01-y 与 02-b/01-q 有页面节点。
    nodes = [_page("01-a/01-y", "客户列表"), _page("02-b/01-q", "会员档案")]
    edges = [
        # 同列相邻单向 → 直连。
        _interacts("e1", "01-a/00-x", "01-a/01-y", direction="调用"),
        # 跨列 + 与 e3 聚合到同一有向对（direction 合并、计数 ×2）。
        _interacts("e2", "01-a/01-y", "02-b/01-q", direction="调用"),
        _interacts(
            "e3", "stateimpact:01-a/01-y:某流程:S1:对象:待->生效:1", "02-b/01-q",
            direction="依赖", relation="state-impact-dependency"),
        # 同列非相邻 → 侧通道。
        _interacts("e4", "01-a/00-x", "01-a/02-z", direction="调用"),
        # 外部端点 → 无法落到模块组件，记入数据缺口（不渲染，不发明关系）。
        _interacts("e5", "01-a/01-y", "external:pay:channel", direction="调用"),
        # 自环 → 亦记入缺口。
        _interacts("e6", "01-a/00-x", "01-a/00-x", direction="调用"),
        # 数据流：owns 起点是主本模块，终点是消费方模块声明的对象节点。
        _data_edge("e7", "owns", "02-b/01-q", "obj:01-a/02-z:会籍"),
        # 数据流：shares 两端都是对象节点，解析回各自模块。
        _data_edge("e8", "shares", "obj:01-a/02-z:账号", "obj:02-b/01-q:账号"),
        # 系统内部数据流 → 总览不画（模块视图已逐对象呈现），记入缺口。
        _data_edge("e9", "owns", "01-a/00-x", "obj:01-a/02-z:配置"),
        # 本模块拥有本模块的对象 → 自环，记入缺口而非画成自连接。
        _data_edge("e10", "owns", "01-a/01-y", "obj:01-a/01-y:客户"),
        # 跨系统且与 e12 同一有向对：调用与数据流合并成一条连接。
        _interacts("e11", "01-a/02-z", "02-b/00-p", direction="调用"),
        _data_edge("e12", "owns", "01-a/02-z", "obj:02-b/00-p:配置"),
    ]
    return {"scopes": scopes, "nodes": nodes, "edges": edges, "gaps": []}


class ArchitectureExtractTest(unittest.TestCase):
    def setUp(self):
        self.model = _model()
        self.data = architecture_ir.extract_architecture(self.model)

    def test_systems_and_modules_follow_sidebar_path_order(self):
        systems = [s["scopeId"] for s in self.data["systems"]]
        self.assertEqual(systems, ["01-a", "02-b"])
        a_mods = [m["scopeId"]
                  for m in self.data["modulesBySystem"]["01-a"]]
        self.assertEqual(a_mods, ["01-a/00-x", "01-a/01-y", "01-a/02-z"])

    def test_structured_set_matches_page_bearing_modules(self):
        self.assertEqual(self.data["structured"], {"01-a/01-y", "02-b/01-q"})

    def test_directed_pairs_aggregate_and_label_from_real_fields(self):
        conns = {c["id"]: c for c in self.data["connections"]}
        # 聚合对：两条边（direction 调用 + 依赖）合并计数。
        agg = conns[architecture_ir.connection_id("01-a/01-y", "02-b/01-q")]
        self.assertEqual(agg["label"], "依赖/调用 ×2")
        self.assertEqual(sorted(agg["edgeIds"]), ["e2", "e3"])
        # 单边对：真实 direction 文字。
        single = conns[architecture_ir.connection_id("01-a/00-x", "01-a/01-y")]
        self.assertEqual(single["label"], "调用")
        self.assertEqual(single["edgeIds"], ["e1"])

    def test_external_and_self_loop_recorded_as_data_gap(self):
        unresolved = {e["edgeId"] for e in self.data["unresolved"]}
        self.assertEqual(unresolved, {"e5", "e6", "e10"})

    def test_no_connection_is_unlabeled(self):
        self.assertTrue(all(c["label"] for c in self.data["connections"]))

    def test_data_flow_edges_become_their_own_module_connection(self):
        """owns 指向的对象节点解析回消费方模块，形成主本→消费方的数据流连接。"""
        conns = {c["id"]: c for c in self.data["connections"]}
        owns = conns[architecture_ir.connection_id("02-b/01-q", "01-a/02-z")]
        self.assertEqual(owns["label"], "数据主本")
        self.assertEqual(owns["variant"], "dashed")
        self.assertEqual(owns["edgeIds"], ["e7"])

    def test_shares_pair_is_labeled_as_shared_object(self):
        conns = {c["id"]: c for c in self.data["connections"]}
        shared = conns[architecture_ir.connection_id("01-a/02-z", "02-b/01-q")]
        self.assertEqual(shared["label"], "共用对象")
        self.assertEqual(shared["variant"], "dashed")

    def test_call_and_data_flow_on_same_pair_merge_and_emphasize(self):
        """同一模块对既有调用又有数据流：合并成一条，标签并列，加重呈现。"""
        conns = {c["id"]: c for c in self.data["connections"]}
        merged = conns[architecture_ir.connection_id("01-a/02-z", "02-b/00-p")]
        self.assertEqual(merged["label"], "调用/数据主本 ×2")
        self.assertEqual(merged["variant"], "emphasis")
        self.assertEqual(sorted(merged["edgeIds"]), ["e11", "e12"])

    def test_interacts_only_pair_keeps_default_variant(self):
        conns = {c["id"]: c for c in self.data["connections"]}
        plain = conns[architecture_ir.connection_id("01-a/00-x", "01-a/01-y")]
        self.assertEqual(plain["variant"], "default")

    def test_same_module_data_flow_is_gap_not_self_connection(self):
        """本模块自己拥有的对象不是跨模块耦合，不得画成自环。"""
        unresolved = {e["edgeId"] for e in self.data["unresolved"]}
        self.assertIn("e10", unresolved)
        self.assertFalse([
            c for c in self.data["connections"] if c["from"] == c["to"]])

    def test_intra_system_data_flow_is_drawn_like_any_other(self):
        """系统内部数据流照画不误——是否上图由几何容量决定，不按系统边界预筛。

        早期版本按「只画跨系统」硬筛，那是拿单个 24 模块项目的实测阈值当通用
        规则；换成按需撑开间隙后，任何规模的项目都不会因为这条规则丢关系。
        """
        conns = {c["id"]: c for c in self.data["connections"]}
        pair = conns[architecture_ir.connection_id("01-a/00-x", "01-a/02-z")]
        self.assertEqual(pair["variant"], "emphasis")
        self.assertEqual(sorted(pair["edgeIds"]), ["e4", "e9"])
        self.assertNotIn(
            "e9", {e["edgeId"] for e in self.data["unresolved"]})


class ArchitectureIrTest(unittest.TestCase):
    def setUp(self):
        self.model = _model()
        self.ir = architecture_ir.build_architecture_ir(self.model)
        self.components = {c["id"]: c for c in self.ir["components"]}
        self.connections = {c["id"]: c for c in self.ir["connections"]}

    def test_schema_shape_and_grid_layout(self):
        self.assertEqual(self.ir["schema_version"], 1)
        self.assertEqual(self.ir["diagram_type"], "architecture")
        self.assertEqual(self.ir["layout"]["mode"], "grid")
        self.assertEqual(self.ir["layout"]["cols"], 2)
        self.assertEqual(self.ir["meta"]["quality_profile"], "standard")
        # 显式 preset 必须是模板支持的（否则 CSS 抽取失败裸嵌黑块）。
        self.assertEqual(self.ir["meta"]["visual_preset"], "blueprint")
        self.assertEqual(len(self.ir["meta"]["viewBox"]), 2)

    def test_component_ids_types_and_columns(self):
        self.assertEqual(len(self.components), 5)
        y = self.components[architecture_ir.component_id("01-a/01-y")]
        x = self.components[architecture_ir.component_id("01-a/00-x")]
        q = self.components[architecture_ir.component_id("02-b/01-q")]
        # 结构化 → backend；待深化 → external（冻结映射）。
        self.assertEqual(y["type"], "backend")
        self.assertEqual(x["type"], "external")
        self.assertEqual(q["type"], "backend")
        # 列 = 系统：甲列 x < 乙列 q。
        self.assertLess(x["pos"][0], q["pos"][0])
        # 列内行序 = 侧栏顺序：00-x 行在 01-y 之上。
        self.assertLess(x["pos"][1],
                        self.components[architecture_ir.component_id(
                            "01-a/01-y")]["pos"][1])

    def test_boundaries_wrap_each_system(self):
        boundaries = {b["label"]: b for b in self.ir["boundaries"]}
        self.assertEqual(set(boundaries), {"甲系统", "乙系统"})
        self.assertEqual(
            set(boundaries["甲系统"]["wraps"]),
            {architecture_ir.component_id(s) for s in
             ("01-a/00-x", "01-a/01-y", "01-a/02-z")})

    def test_adjacent_same_column_edge_is_straight_labeled_in_gap(self):
        conn = self.connections[
            architecture_ir.connection_id("01-a/00-x", "01-a/01-y")]
        self.assertNotIn("via", conn)
        self.assertEqual(conn["fromSide"], "bottom")
        self.assertEqual(conn["toSide"], "top")
        self.assertIn("labelAt", conn)

    def test_nonadjacent_same_column_edge_routes_side_channel(self):
        conn = self.connections[
            architecture_ir.connection_id("01-a/00-x", "01-a/02-z")]
        self.assertIn("via", conn)
        # 首列非相邻边挂到列左外侧（via x 落在首列左缘之外）。
        x_left = self.components[
            architecture_ir.component_id("01-a/00-x")]["pos"][0]
        self.assertLess(conn["via"][0][0], x_left)

    def test_cross_column_edge_routes_between_columns(self):
        conn = self.connections[
            architecture_ir.connection_id("01-a/01-y", "02-b/01-q")]
        self.assertIn("via", conn)
        self.assertEqual(conn["fromSide"], "right")
        self.assertEqual(conn["toSide"], "left")

    def test_maps_round_trip_component_and_connection_edges(self):
        cmids = architecture_ir.component_module_ids(self.model)
        self.assertEqual(cmids[architecture_ir.component_id("01-a/01-y")],
                         "01-a/01-y")
        self.assertEqual(len(cmids), 5)
        ceids = architecture_ir.connection_edge_ids(self.model)
        self.assertEqual(
            sorted(ceids[architecture_ir.connection_id(
                "01-a/01-y", "02-b/01-q")]), ["e2", "e3"])

    def test_gutter_widens_to_fit_lanes_instead_of_dropping(self):
        """间隙按车道需求撑开：连接只增不减，宽度随需求增长。

        通用性守门——不允许因为「放不下」而丢关系。丢关系会让读者把
        「图上没有」误读成「关系不存在」；撑宽只是多滚动一点。
        """
        base = architecture_ir.build_architecture_ir(self.model)
        crowded = _model()
        # 在同一条列间隙上再压 3 条跨列连接，逼出更多车道。
        for index, (src, dst) in enumerate((
                ("01-a/00-x", "02-b/01-q"),
                ("01-a/01-y", "02-b/00-p"),
                ("01-a/02-z", "02-b/01-q"))):
            crowded["edges"].append(
                _interacts(f"x{index}", src, dst, direction="调用"))
        dense = architecture_ir.build_architecture_ir(crowded)
        self.assertGreater(len(dense["connections"]), len(base["connections"]))
        base_cols = sorted({c["pos"][0] for c in base["components"]})
        dense_cols = sorted({c["pos"][0] for c in dense["components"]})
        self.assertGreater(dense_cols[1] - dense_cols[0],
                           base_cols[1] - base_cols[0])
        # 每条声明的连接都在 IR 里，一条不落。
        declared = {c["id"]
                    for c in architecture_ir.extract_architecture(
                        crowded)["connections"]}
        self.assertEqual({c["id"] for c in dense["connections"]}, declared)

    def test_small_tree_keeps_baseline_gap(self):
        """需求不超基准时不无谓撑宽——小项目画布保持紧凑。"""
        sparse = _model()
        sparse["edges"] = [
            _interacts("s1", "01-a/00-x", "01-a/01-y", direction="调用")]
        ir = architecture_ir.build_architecture_ir(sparse)
        self.assertEqual(ir["layout"]["gapX"], architecture_ir._GAPX)

    def test_shared_gutter_channels_do_not_overlap(self):
        """inter 与中列 intra 共用同一条间隙时，各占互不重叠的一段。"""
        ir = architecture_ir.build_architecture_ir(self.model)
        xs = [c["via"][0][0] for c in ir["connections"] if "via" in c]
        self.assertEqual(len(xs), len(set(xs)),
                         f"通道 x 坐标重复，说明两条通道压线: {sorted(xs)}")

    def test_deterministic_bytes(self):
        again = architecture_ir.build_architecture_ir(self.model)
        self.assertEqual(architecture_ir.canonical_ir_bytes(self.ir),
                         architecture_ir.canonical_ir_bytes(again))
        # 键序稳定的 canonical JSON。
        self.assertEqual(
            json.loads(architecture_ir.canonical_ir_bytes(self.ir)),
            self.ir)


if __name__ == "__main__":
    unittest.main()
