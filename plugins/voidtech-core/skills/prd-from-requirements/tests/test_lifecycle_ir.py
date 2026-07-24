"""Logic Atlas 到 Archify Lifecycle IR 的纯函数契约。"""

import json
import unittest

from worktree_fixture import SKILL_ROOT  # noqa: F401

from prdsync import lifecycle_ir


SCOPE = "02-backend/01-membership"
OBJECT = "入会订单"


def state(name, *, entry=""):
    return {
        "nodeId": f"state:{SCOPE}:{OBJECT}:{name}",
        "kind": "state",
        "scopeId": SCOPE,
        "title": name,
        "status": "original",
        "sources": [{"path": "prd.md", "anchor": "状态机", "requirementIds": [], "oqIds": []}],
        "detail": {"category": "businessState", "object": OBJECT, "entryCondition": entry},
    }


def transition(source, target, action):
    return {
        "edgeId": f"transition:{source}:{target}:{action}",
        "kind": "transition",
        "from": f"state:{SCOPE}:{OBJECT}:{source}",
        "to": f"state:{SCOPE}:{OBJECT}:{target}",
        "status": "original",
        "sources": [{"path": "prd.md", "anchor": "状态机", "requirementIds": [], "oqIds": []}],
        "detail": {"action": action, "result": target},
    }


def model(nodes, edges):
    return {"nodes": nodes, "edges": edges}


class LifecycleIrTest(unittest.TestCase):
    def test_keyword_contract_is_frozen(self):
        self.assertEqual(lifecycle_ir.SUCCESS_KEYWORDS, ("通过", "生效", "成功"))
        self.assertEqual(lifecycle_ir.FAILURE_KEYWORDS, ("未通过", "失败", "拒绝"))
        self.assertEqual(lifecycle_ir.WAITING_KEYWORDS, ("待", "暂停", "到期"))

    def test_builds_deterministic_lanes_columns_and_types(self):
        nodes = [
            state("草稿"), state("审核中"), state("待复核", entry="等待人工复核"),
            state("资料补充"), state("复核完成"), state("审核通过"), state("审核拒绝"),
        ]
        edges = [
            transition("草稿", "审核中", "提交"),
            transition("审核中", "待复核", "进入复核"),
            transition("待复核", "复核完成", "完成复核"),
            transition("复核完成", "审核通过", "确认通过"),
            transition("审核中", "资料补充", "退回补充"),
            transition("资料补充", "审核拒绝", "拒绝"),
        ]

        machine = lifecycle_ir.extract_machines(model(nodes, edges))[0]
        ir = lifecycle_ir.build_lifecycle_ir(machine)
        by_label = {item["label"]: item for item in ir["states"]}

        self.assertEqual(by_label["草稿"]["type"], "start")
        self.assertEqual(by_label["待复核"]["type"], "waiting")
        self.assertEqual(by_label["审核通过"]["type"], "success")
        self.assertEqual(by_label["审核拒绝"]["type"], "failure")
        self.assertEqual(by_label["资料补充"]["lane"], "branch")
        self.assertEqual(by_label["审核通过"]["lane"], "terminal")
        self.assertLessEqual(max(item["col"] for item in ir["states"] if item["lane"] == "main"), 4)
        self.assertLessEqual(max(item["col"] for item in ir["states"] if item["lane"] == "terminal"), 2)
        self.assertEqual(len({item["id"] for item in ir["states"]}), len(nodes))
        self.assertEqual([item["id"] for item in ir["states"]], sorted(item["id"] for item in ir["states"]))
        self.assertEqual([item["id"] for item in ir["transitions"]], sorted(item["id"] for item in ir["transitions"]))

        reversed_machine = lifecycle_ir.extract_machines(model(list(reversed(nodes)), list(reversed(edges))))[0]
        self.assertEqual(
            lifecycle_ir.canonical_ir_bytes(ir),
            lifecycle_ir.canonical_ir_bytes(lifecycle_ir.build_lifecycle_ir(reversed_machine)),
        )
        json.loads(lifecycle_ir.canonical_ir_bytes(ir))

    def test_cycle_without_terminal_does_not_invent_terminal_types(self):
        nodes = [state("待命"), state("运行")]
        edges = [transition("待命", "运行", "启动"), transition("运行", "待命", "复位")]

        ir = lifecycle_ir.build_lifecycle_ir(
            lifecycle_ir.extract_machines(model(nodes, edges))[0])

        self.assertEqual({item["lane"] for item in ir["states"]}, {"main"})
        self.assertEqual({item["type"] for item in ir["states"]}, {"waiting", "active"})
        self.assertEqual({item["col"] for item in ir["states"]}, {0})
        self.assertNotIn("terminal", {lane["id"] for lane in ir["lanes"]})

    def test_same_column_cycles_route_outward_from_their_column(self):
        nodes = [
            state("审核中"), state("已拒绝"),
            state("已通过"), state("已过期"),
        ]
        edges = [
            transition("审核中", "已拒绝", "拒绝"),
            transition("已拒绝", "审核中", "重新提交"),
            transition("审核中", "已通过", "通过"),
            transition("已通过", "已过期", "到期"),
            transition("已过期", "已通过", "续期"),
        ]

        ir = lifecycle_ir.build_lifecycle_ir(
            lifecycle_ir.extract_machines(model(nodes, edges))[0])
        layout = {item["id"]: item for item in ir["states"]}
        same_column = [
            item for item in ir["transitions"]
            if layout[item["from"]]["col"] == layout[item["to"]]["col"]
        ]

        self.assertEqual(
            {
                (layout[item["from"]]["col"], item["route"],
                 item["fromSide"], item["toSide"])
                for item in same_column
            },
            {
                (0, "left-channel", "left", "left"),
                (1, "right-channel", "right", "right"),
            })

    def test_groups_transitions_by_scope_and_business_object(self):
        other = state("审核通过")
        other["scopeId"] = "03-portal/01-account"
        other["nodeId"] = "state:03-portal/01-account:账号:审核通过"
        other["detail"]["object"] = "账号"

        machines = lifecycle_ir.extract_machines(model([state("草稿"), state("审核中"), other], [
            transition("草稿", "审核中", "提交")
        ]))

        self.assertEqual([(m["scopeId"], m["object"]) for m in machines], [
            (SCOPE, OBJECT), ("03-portal/01-account", "账号")
        ])
        self.assertEqual(len(machines[1]["states"]), 1)


if __name__ == "__main__":
    unittest.main()
