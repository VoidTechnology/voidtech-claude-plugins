"""门 5「Logic Atlas」核心 fixture（技术设计 §10/§11 门 5；ADR-0005）。

被测契约——worker 在 `scripts/prdsync/atlas.py` 实现：

- `atlas.compile(root) -> dict`：确定性逻辑模型编译器。消费权威主本的页面契约、
  核心流程、边缘状态、状态机、模块边界、数据读写、模块交互与追溯矩阵经
  `_generated/requirements-ledger.jsonl` 形成的需求身份读模型。输出通过
  schemas/logic-model.schema.json；每个正式 node/edge 必须携带来源
  （schema 强制 minItems 1）；无法解析的内容如实进 `gaps`，绝不按产品经验
  补齐。构建前先检查读取栅栏（存在 publishing/publish-conflict operation
  时抛 effective_view.ReadFenceError）；Atlas 能力未开启抛
  `atlas.AtlasNotEnabled`。两次编译结果逐字节一致。
- `atlas.build_plan(root) -> list`：按 stage 产出发布计划（engine plan 条目）：
  markdown 阶段 = `_generated/logic/logic-model.json`、`_generated/logic/
  logic-atlas.md`、`_generated/logic/manifest.json`、`_generated/logic/
  validation-report.md`；html/polish 阶段另含 `logic-atlas.html`。
  manifest 至少含 `generatorVersion`、`logicModelSchemaVersion`、
  `authoritativeSourceDigest`、`ledgerSourceDigest`、`ledgerArtifactDigest`
  （三摘要，ADR-0005 §6）。logic-atlas.md 顶部自述生成快照（含
  authoritativeSourceDigest 短哈希），不得静态宣称「当前最新」。
- `atlas.publish(root) -> operation manifest`：经 operation_engine 以 maintain
  operation 提交 build_plan（暂存发布协议不绕过）。模型校验失败（如跨模块
  交互指向不存在的模块）抛 `atlas.AtlasValidationError` 且不写任何文件
  ——fail closed，不产出「最新可用」假状态。
- `atlas.check_freshness(root) -> {"contentFresh": bool, "reasons": [...]}`：
  严格只读零写入。重算三摘要与已发布 manifest 比对：任一不一致（含带外改
  主本、旧/坏 Ledger 配新主本）→ contentFresh False；pending revision 与
  pending change 不参与判定——未确认内容不得让 PRD 未变的 Atlas 无故过期。
- `atlas.gate_requirements(root) -> {"stage": str, "steps": [...]}`：内容门
  按阶段裁剪。stage ∈ legacy/markdown/html/polish（无 prd-worktree.json 或
  logicAtlas 未开启 → legacy，steps 为空）。步骤 id 与阻塞性固定为：
  markdown → rebuild-ledger / compile-logic-model / validate-model /
  render-markdown / write-manifest / static-check-markdown（全部 blocking）；
  html → markdown 全部 + render-html / static-check-html（blocking）；
  polish → html 全部 + naturalize-narratives（blocking=False，自然化不阻塞
  日常维护，不可用时回退原文）。
"""

import json
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    ATLAS_MODULE_PRD, ATLAS_MODULE_PRD_BROKEN, MANUAL_KEY,
    MODULE_A_PRD_RELPATH, ROWS_V2, build_xlsx, enable_logic_atlas,
    make_legacy_worktree, write_atlas_module,
)
from worktree_fixture import SKILL_ROOT, snapshot

from prdsync import atlas, base_cas, effective_view, migration, sync
from prdsync.canonical_store import read_json
from prdsync.schema_validator import check, load_schema

SOURCE_ID = "requirements-xlsx"
MODEL_RELPATH = "_generated/logic/logic-model.json"
MD_RELPATH = "_generated/logic/logic-atlas.md"
MANIFEST_RELPATH = "_generated/logic/manifest.json"
REPORT_RELPATH = "_generated/logic/validation-report.md"
PRESENTATION_RELPATH = "_generated/logic/lifecycle-presentation.json"


def atlas_worktree(testcase, stage="markdown"):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
    write_atlas_module(root)
    enable_logic_atlas(root, stage)
    return root, Path(tmp.name)


class CompileTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = atlas_worktree(self)

    def test_model_is_schema_valid_and_extracts_declared_structure(self):
        model = atlas.compile(self.root)
        errors = check(model, load_schema(SKILL_ROOT / "schemas", "logic-model"))
        self.assertEqual(errors, [])
        self.assertEqual(model["generatorVersion"], "1.9.0")

        pages = [n for n in model["nodes"] if n["kind"] == "page"]
        self.assertEqual({p["title"] for p in pages}, {"客户列表页", "客户详情页"})
        data_objects = [n for n in model["nodes"] if n["kind"] == "dataObject"]
        self.assertTrue(any(n["title"] == "客户" for n in data_objects))
        requirements = [n for n in model["nodes"] if n["kind"] == "requirement"]
        self.assertEqual(len(requirements), 6)
        edge_kinds = {e["kind"] for e in model["edges"]}
        self.assertTrue({"reads", "writes", "interacts"} <= edge_kinds)

    def test_compiles_fields_and_access_rules_without_exposing_sensitive_examples(self):
        contracts = """

### 7.0.2 字段定义（机器可解析）

| 对象 | 字段 | 含义 | 类型 | 必填 | 示例 | 来源 | 校验规则 | 可编辑 | 可导出 | 敏感 |
|---|---|---|---|---|---|---|---|---|---|---|
| 客户 | 客户名称 | 对外展示名称 | 文本 | 是 | 示例客户 | TST-001 | 非空 | 是 | 是 | 否 |
| 客户 | 联系电话 | 联系号码 | 文本 | 是 | 13800000000 | TST-002 | 手机号格式 | 是 | 否 | 是 |

## 8. 权限矩阵

| 角色 | 查看 | 编辑 | 查看敏感信息 | 导出 | 需求编号 |
|---|---|---|---|---|---|
| 管理员 | ✓ | 按负责客户 | ✗ | 无 | TST-003 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        fields = [node for node in model["nodes"] if node["kind"] == "field"]
        self.assertEqual({node["title"] for node in fields},
                         {"客户名称", "联系电话"})
        phone = next(node for node in fields if node["title"] == "联系电话")
        self.assertIsNone(phone["detail"]["example"])
        self.assertTrue(phone["detail"]["exampleRedacted"])
        self.assertEqual(phone["sources"][0]["requirementIds"], ["TST-002"])
        self.assertTrue(any(
            edge["kind"] == "traces"
            and edge["from"] == phone["nodeId"]
            and edge["to"] == "obj:01-test-system/01-module-a:客户"
            for edge in model["edges"]))

        rules = [
            node for node in model["nodes"] if node["kind"] == "permission"]
        self.assertEqual(
            {(node["detail"]["action"], node["detail"]["decision"])
             for node in rules},
            {("查看", "allow"), ("编辑", "conditional"),
             ("查看敏感信息", "deny"), ("导出", "not-applicable")})
        self.assertTrue(all(
            node["sources"][0]["requirementIds"] == ["TST-003"]
            for node in rules))
        self.assertEqual(model["coverage"]["fieldCount"], 2)
        self.assertEqual(model["coverage"]["permissionCount"], 4)

    def test_permission_review_dimensions_are_metadata_not_actions(self):
        contracts = """

## 8. 权限矩阵

| 角色 | 查看 | 编辑 | 客户数据范围 | 联系方式可见性 | 初始密码可见性 | 无权限拒绝行为 | 需求编号 |
|---|---|---|---|---|---|---|---|
| 运营员 | ✓ | ✗ | 平台全量客户 | 有敏感权限时明文，否则脱敏 | 创建成功页仅一次 | 入口隐藏，直接请求拒绝并记日志 | TST-003 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        rules = [
            node for node in model["nodes"] if node["kind"] == "permission"]
        self.assertEqual(
            {node["detail"]["action"] for node in rules}, {"查看", "编辑"})
        self.assertTrue(all(
            node["detail"]["dataScope"] == "平台全量客户"
            and node["detail"]["fieldVisibility"]
            == "联系方式可见性: 有敏感权限时明文，否则脱敏；初始密码可见性: 创建成功页仅一次"
            and node["detail"]["denialBehavior"] == "入口隐藏，直接请求拒绝并记日志"
            for node in rules), rules)
        self.assertEqual(model["coverage"]["permissionCount"], 2)

    def test_step_permission_contract_resolves_exact_actions_and_recovery_handoff(self):
        contracts = """

### 5.0.4 步骤权限合同（机器可解析）

| 流程 | 步骤ID | 用途 | 执行角色 | 所需操作 | 未授权处理 | 转交角色 | 需求编号 |
|---|---|---|---|---|---|---|---|
| 查看客户详情 | S1 | 主操作 | 管理员 | 查看 | 阻断并提示无权限 | — | TST-001 |
| 查看客户详情 | S1 | 异常恢复 | 管理员 | 编辑 | 阻断并转交超级管理员 | 超级管理员 | TST-002 |

## 8. 权限矩阵

| 角色 | 查看 | 编辑 | 导出 | 需求编号 |
|---|---|---|---|---|
| 管理员 | ✓ | ✗ | ✓ | TST-003 |
| 超级管理员 | ✓ | ✓ | ✓ | TST-003 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        step = next(
            node for node in model["nodes"]
            if node["kind"] == "flow"
            and (node.get("detail") or {}).get("category") == "flowStep"
            and node["detail"].get("stepId") == "S1")
        actions = step["detail"]["requiredActions"]
        self.assertEqual(
            [(item["purpose"], item["subject"], item["action"])
             for item in actions],
            [("operation", "管理员", "查看"),
             ("recovery", "管理员", "编辑")])
        self.assertEqual(actions[0]["permissionRefs"], [
            "permission:01-test-system/01-module-a:管理员:查看"])
        self.assertEqual(actions[1]["permissionRefs"], [
            "permission:01-test-system/01-module-a:管理员:编辑",
            "permission:01-test-system/01-module-a:超级管理员:编辑"])
        self.assertEqual(step["detail"]["permissionRefs"], [
            "permission:01-test-system/01-module-a:管理员:查看",
            "permission:01-test-system/01-module-a:管理员:编辑",
            "permission:01-test-system/01-module-a:超级管理员:编辑"])

        failure = next(
            node for node in model["nodes"]
            if node["kind"] == "flow"
            and (node.get("detail") or {}).get("category") == "failureBranch"
            and node["detail"].get("stepId") == "S1")
        self.assertEqual(failure["detail"]["recoveryRequesterRole"], "管理员")
        self.assertEqual(failure["detail"]["recoveryRole"], "超级管理员")
        self.assertEqual(failure["detail"]["handoffRole"], "超级管理员")
        self.assertEqual(
            failure["detail"]["unauthorizedBehavior"],
            "阻断并转交超级管理员")
        self.assertEqual(failure["detail"]["permissionRefs"],
                         actions[1]["permissionRefs"])
        self.assertEqual(
            check(model, load_schema(SKILL_ROOT / "schemas", "logic-model")),
            [])
        malformed = json.loads(json.dumps(model, ensure_ascii=False))
        malformed_step = next(
            node for node in malformed["nodes"]
            if node["nodeId"] == step["nodeId"])
        malformed_step["detail"]["requiredActions"][0]["permissionRefs"] = [1]
        self.assertTrue(check(
            malformed,
            load_schema(SKILL_ROOT / "schemas", "logic-model")))

    def test_sensitive_field_unknown_value_is_redacted_and_reported(self):
        contracts = """

### 7.0.2 字段定义（机器可解析）

| 对象 | 字段 | 含义 | 类型 | 必填 | 示例 | 来源 | 校验规则 | 可编辑 | 可导出 | 敏感 |
|---|---|---|---|---|---|---|---|---|---|---|
| 客户 | 联系电话 | 联系号码 | 文本 | 是 | 13800000000 | TST-002 | 手机号格式 | 是 | 否 | 是（手机号） |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        phone = next(
            node for node in model["nodes"]
            if node["kind"] == "field" and node["title"] == "联系电话")
        self.assertIsNone(phone["detail"]["example"])
        self.assertTrue(phone["detail"]["exampleRedacted"])
        self.assertTrue(any(
            gap["kind"] == "unparsed"
            and "敏感性必须明确填写" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_field_table_outside_declared_section_is_not_compiled(self):
        appendix = """

## 99. 附录（非机器契约）

| 对象 | 字段 | 含义 | 类型 | 必填 | 示例 | 来源 | 校验规则 | 可编辑 | 可导出 | 敏感 |
|---|---|---|---|---|---|---|---|---|---|---|
| 客户 | 附录字段 | 不是正式声明 | 文本 | 否 | 示例 | TST-001 | 无 | 否 | 否 | 否 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + appendix)

        model = atlas.compile(self.root)
        self.assertFalse(any(
            node["kind"] == "field" and node["title"] == "附录字段"
            for node in model["nodes"]))
        self.assertTrue(any(
            gap["gapId"].endswith(":fields")
            for gap in model["gaps"]), model["gaps"])

    def test_malformed_field_row_is_an_explicit_gap(self):
        contracts = """

### 7.0.2 字段定义（机器可解析）

| 对象 | 字段 | 含义 | 类型 | 必填 | 示例 | 来源 | 校验规则 | 可编辑 | 可导出 | 敏感 |
|---|---|---|---|---|---|---|---|---|---|---|
|  | 联系电话 | 联系号码 | 文本 | 是 | 13800000000 | TST-002 | 手机号格式 | 是 | 否 | 是 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        self.assertFalse(any(
            node["kind"] == "field" for node in model["nodes"]))
        self.assertTrue(any(
            gap["kind"] == "unparsed"
            and "字段定义行缺少" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_permission_conditions_and_conflicts_fail_closed(self):
        contracts = """

## 8. 权限矩阵

| 角色 | 查看 | 编辑 | 需求编号 |
|---|---|---|---|
| 管理员 | 允许（仅本机构） | ✓ | TST-003 |
| 管理员 | 拒绝 |  | TST-004 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        rules = {
            node["detail"]["action"]: node
            for node in model["nodes"] if node["kind"] == "permission"
        }
        self.assertNotIn("查看", rules)
        self.assertEqual(rules["编辑"]["detail"]["decision"], "allow")
        self.assertTrue(any(
            gap["kind"] == "ambiguous-relation"
            and "管理员 × 查看" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_legacy_permission_matrix_reports_missing_requirement_trace(self):
        contracts = """

## 8. 权限矩阵

| 角色 | 查看 |
|---|---|
| 管理员 | ✓ |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        rule = next(
            node for node in model["nodes"]
            if node["kind"] == "permission")
        self.assertEqual(rule["sources"][0]["requirementIds"], [])
        self.assertTrue(any(
            gap["gapId"].endswith(":permission-trace")
            and gap["kind"] == "missing-source"
            for gap in model["gaps"]), model["gaps"])

    def test_permission_requirement_ids_only_come_from_fixed_last_column(self):
        contracts = """

## 8. 权限矩阵

| 角色 | 查看 | 需求编号 |
|---|---|---|
| 管理员 | 仅 TST-003 对象 |  |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + contracts)

        model = atlas.compile(self.root)
        rule = next(
            node for node in model["nodes"]
            if node["kind"] == "permission")
        self.assertEqual(rule["sources"][0]["requirementIds"], [])
        self.assertTrue(any(
            gap["gapId"].endswith(":permission-trace:1")
            for gap in model["gaps"]), model["gaps"])

    def test_schema_rejects_field_or_permission_without_detail(self):
        model = atlas.compile(self.root)
        source = model["nodes"][0]["sources"]
        model["nodes"].append({
            "nodeId": "permission:broken",
            "kind": "permission",
            "scopeId": "01-test-system/01-module-a",
            "title": "损坏规则",
            "status": "original",
            "sources": source,
            "detail": None,
        })

        errors = check(model, load_schema(SKILL_ROOT / "schemas", "logic-model"))
        self.assertTrue(any("oneOf matched 0" in error for error in errors), errors)

    def test_requirement_nodes_include_deterministic_human_summary(self):
        model = atlas.compile(self.root)
        requirement = next(
            node for node in model["nodes"]
            if node["nodeId"] == "req:TST-001")

        self.assertEqual(requirement["detail"]["summary"], "客户新增")
        self.assertEqual(requirement["detail"]["assertionRole"], "normative")

    def test_structured_pages_without_page_data_mapping_are_explicit_gap(self):
        model = atlas.compile(self.root)

        self.assertTrue(any(
            gap["kind"] == "missing-relation"
            and "页面与数据对象的读写关系未声明" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["dataDeclaration"], "missing")

    def test_page_data_explicit_none_is_distinct_from_missing(self):
        mapping = """

### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
| 不涉及 | 不涉及 | 客户列表页 | 不涉及 | 无 | TST-001 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + mapping)

        model = atlas.compile(self.root)
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["dataDeclaration"], "none")
        declaration_source = next(
            source for source in page["sources"]
            if source.get("anchor") == "页面数据读写（机器可解析）")
        self.assertEqual(declaration_source["requirementIds"], ["TST-001"])
        self.assertFalse(any(
            gap["gapId"].endswith(":page-data-rw:客户列表页")
            for gap in model["gaps"]), model["gaps"])

    def test_page_data_none_requires_page_level_scope_sentinel(self):
        mapping = """

### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 不涉及 | 无 | TST-001 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + mapping)

        model = atlas.compile(self.root)
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["dataDeclaration"], "unparsed")
        self.assertTrue(any(
            gap["kind"] == "unparsed"
            and "流程=不涉及" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_invalid_page_data_row_is_distinct_from_missing(self):
        mapping = """

### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 未声明对象 | 读 | TST-001 |
| 查看客户详情 | S1 | 客户列表页 | 客户 | 读 | TST-001 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + mapping)

        model = atlas.compile(self.root)
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["dataDeclaration"], "unparsed")
        self.assertTrue(any(
            edge["kind"] == "reads"
            and edge["from"] == page["nodeId"]
            for edge in model["edges"]))

    def test_incomplete_page_data_row_marks_known_page_unparsed(self):
        mapping = """

### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
|  | S1 | 客户列表页 | 客户 | 读 | TST-001 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + mapping)

        model = atlas.compile(self.root)
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["dataDeclaration"], "unparsed")
        self.assertTrue(any(
            gap["kind"] == "unparsed"
            and "缺少必填列" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_multi_action_page_row_preserves_shared_result_without_guessing(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 客户列表页 | 主导航 | 管理员 | 已登录 | 查看客户列表 | 展示分页客户 |",
                "| 客户列表页 | 主导航 | 管理员 | 已登录 | 浏览筛选/导出 | 展示分页客户 |"))

        model = atlas.compile(self.root)
        page = next(
            node for node in model["nodes"]
            if node["nodeId"] ==
            "page:01-test-system/01-module-a:客户列表页")
        self.assertEqual(page["detail"]["actions"], [
            {"action": "浏览筛选", "result": None},
            {"action": "导出", "result": None},
        ])
        self.assertEqual(page["detail"]["sharedResults"], ["展示分页客户"])
        self.assertTrue(any(
            gap["kind"] == "ambiguous-relation"
            and "2 个动作共用 1 个结果" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_each_business_transition_edge_has_one_action(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 客户 | 待激活 | 已创建但未启用 | 创建成功 | 激活 | 已激活 |",
                "| 客户 | 待激活 | 已创建但未启用 | 创建成功 | 激活、自动激活 | 已激活 |"))

        model = atlas.compile(self.root)
        transitions = [
            edge for edge in model["edges"]
            if edge["kind"] == "transition"
            and edge["from"].endswith(":客户:待激活")
            and edge["to"].endswith(":客户:已激活")
        ]
        self.assertEqual(
            [edge["detail"]["action"] for edge in transitions],
            ["激活"])
        self.assertFalse(any(
            edge["detail"]["action"] == "自动激活"
            for edge in transitions))

    def test_maps_page_data_edges_only_from_explicit_contract(self):
        mapping = """

### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 客户 | 读 | TST-001 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + mapping)

        model = atlas.compile(self.root)
        edge = next(
            edge for edge in model["edges"]
            if edge["kind"] == "reads"
            and edge["from"].endswith(":客户列表页")
            and edge["to"].endswith(":客户"))
        self.assertEqual(edge["detail"]["relation"], "page-data")
        self.assertEqual(edge["detail"]["flowTitle"], "查看客户详情")
        self.assertEqual(edge["detail"]["stepId"], "S1")
        self.assertFalse(any(
            gap["gapId"].endswith(":page-data-rw")
            for gap in model["gaps"]))
        unmapped = next(
            gap for gap in model["gaps"]
            if gap["gapId"].endswith(":page-data-rw:客户详情页"))
        self.assertEqual(
            unmapped["context"]["pageTitle"], "客户详情页")

    def _write_module_b_data(self, rows):
        (self.root / "01-test-system/02-module-b/prd.md").write_text(
            "# 模块乙\n\n## 7. 字段与数据规则\n\n"
            "### 7.0 数据读写（机器可解析）\n\n"
            "| 数据对象 | 操作 | 权威来源 | 同步方式 |\n|---|---|---|---|\n"
            + rows, encoding="utf-8")

    def test_self_owned_data_object_has_no_owns_edge(self):
        model = atlas.compile(self.root)
        node = next(
            node for node in model["nodes"]
            if node["nodeId"] == "obj:01-test-system/01-module-a:客户")
        self.assertEqual(node["detail"]["authorityKind"], "self")
        self.assertEqual(
            node["detail"]["authorityScopeId"], "01-test-system/01-module-a")
        self.assertEqual(node["detail"]["canonicalId"], "data:01-module-a:客户")
        self.assertFalse([
            edge for edge in model["edges"] if edge["kind"] == "owns"])

    def test_authority_pointing_at_another_module_becomes_owns_edge(self):
        self._write_module_b_data("| 订单 | 读 | 01-module-a | 实时 |\n")

        model = atlas.compile(self.root)
        node = next(
            node for node in model["nodes"]
            if node["nodeId"] == "obj:01-test-system/02-module-b:订单")
        self.assertEqual(node["detail"]["authorityKind"], "module")
        edge = next(
            edge for edge in model["edges"] if edge["kind"] == "owns")
        self.assertEqual(edge["from"], "01-test-system/01-module-a")
        self.assertEqual(edge["to"], "obj:01-test-system/02-module-b:订单")
        self.assertEqual(
            edge["detail"]["consumerScopeId"], "01-test-system/02-module-b")

    def test_authority_key_ignores_parenthetical_and_section_suffix(self):
        self._write_module_b_data(
            "| 客户 | 读 | 01-module-a(字段规则见 customer §2.1) | 实时 |\n")

        model = atlas.compile(self.root)
        node = next(
            node for node in model["nodes"]
            if node["nodeId"] == "obj:01-test-system/02-module-b:客户")
        self.assertEqual(node["detail"]["authorityKey"], "01-module-a")
        self.assertEqual(node["detail"]["canonicalId"], "data:01-module-a:客户")

    def test_same_title_and_authority_links_copies_across_modules(self):
        self._write_module_b_data("| 客户 | 读 | 01-module-a | 实时 |\n")

        model = atlas.compile(self.root)
        edge = next(
            edge for edge in model["edges"] if edge["kind"] == "shares")
        self.assertEqual(edge["from"], "obj:01-test-system/01-module-a:客户")
        self.assertEqual(edge["to"], "obj:01-test-system/02-module-b:客户")
        self.assertEqual(edge["detail"]["canonicalId"], "data:01-module-a:客户")
        self.assertEqual(edge["detail"]["anchorRole"], "authoritative")
        self.assertFalse(any(
            "data-authority-conflict" in gap["gapId"]
            for gap in model["gaps"]))

    def test_conflicting_authority_is_gap_and_not_merged(self):
        self._write_module_b_data("| 客户 | 读 | customer-domain | 实时 |\n")

        model = atlas.compile(self.root)
        self.assertFalse([
            edge for edge in model["edges"] if edge["kind"] == "shares"])
        conflicts = [
            gap for gap in model["gaps"]
            if "data-authority-conflict" in gap["gapId"]]
        self.assertEqual(
            {gap["scopeId"] for gap in conflicts},
            {"01-test-system/01-module-a", "01-test-system/02-module-b"})
        self.assertIn("权威来源声明不一致", conflicts[0]["detail"])
        self.assertIn("customer-domain", conflicts[0]["detail"])

    def test_domain_spec_authority_stays_spec_without_owns_edge(self):
        self._write_module_b_data("| 订单 | 读 | payment-order §3.2 | 实时 |\n")

        model = atlas.compile(self.root)
        node = next(
            node for node in model["nodes"]
            if node["nodeId"] == "obj:01-test-system/02-module-b:订单")
        self.assertEqual(node["detail"]["authorityKind"], "spec")
        self.assertIsNone(node["detail"]["authorityScopeId"])
        self.assertEqual(node["detail"]["authorityKey"], "payment-order")
        self.assertFalse([
            edge for edge in model["edges"] if edge["kind"] == "owns"])

    def test_extracts_behavior_flow_and_branch_graph(self):
        model = atlas.compile(self.root)

        flows = [n for n in model["nodes"] if n["kind"] == "flow"]
        categories = [n["detail"]["category"] for n in flows]
        self.assertEqual(categories.count("userFlow"), 1)
        self.assertEqual(categories.count("flowStep"), 2)
        self.assertEqual(categories.count("terminal"), 1)
        self.assertEqual(categories.count("failureBranch"), 2)

        edge_kinds = {e["kind"] for e in model["edges"]}
        self.assertTrue({"navigates", "traces"} <= edge_kinds)
        flow_step = next(n for n in flows
                         if n["detail"]["category"] == "flowStep"
                         and n["detail"]["stepId"] == "S1")
        self.assertEqual(flow_step["sources"][0]["requirementIds"],
                         ["TST-001", "TST-002", "TST-003"])
        self.assertEqual(model["coverage"]["flowCount"], 1)

    def test_non_ui_system_step_accepts_page_placeholder_without_page_gap(self):
        content = ATLAS_MODULE_PRD.replace(
            "| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 |",
            "| 查看客户详情 | S2 | — | 系统 | 消费详情事件 |")
        write_atlas_module(self.root, content)

        model = atlas.compile(self.root)
        step = next(
            node for node in model["nodes"]
            if node["kind"] == "flow"
            and node["detail"].get("category") == "flowStep"
            and node["detail"].get("stepId") == "S2")

        self.assertEqual(step["detail"]["pageTitle"], "—")
        self.assertEqual(step["detail"]["pageIds"], [])
        self.assertFalse([
            edge for edge in model["edges"]
            if edge["from"] == step["nodeId"]
            and edge["detail"].get("relation") == "flow-step-page"])
        self.assertFalse([
            gap for gap in model["gaps"]
            if gap["gapId"].endswith(
                ":flow:查看客户详情:S2:page:0")])

    def test_extracts_terminal_interaction_chains_with_step_and_page_traces(self):
        model = atlas.compile(self.root)
        interactions = [
            node for node in model["nodes"]
            if node["kind"] == "flow"
            and node["detail"].get("category") == "interactionStep"
        ]
        self.assertEqual(len(interactions), 3)
        self.assertEqual(model["coverage"]["interactionCount"], 3)
        self.assertEqual({
            (node["detail"]["stepId"], node["detail"]["interactionId"])
            for node in interactions if node["detail"]["entry"]
        }, {("S1", "I1"), ("S2", "I1")})

        s1_i1 = next(
            node for node in interactions
            if node["detail"]["stepId"] == "S1"
            and node["detail"]["interactionId"] == "I1")
        self.assertEqual(s1_i1["detail"]["flowId"],
                         "flow:01-test-system/01-module-a:查看客户详情")
        self.assertEqual(s1_i1["detail"]["stepNodeId"],
                         "flowstep:01-test-system/01-module-a:查看客户详情:S1")
        self.assertEqual(s1_i1["detail"]["pageId"],
                         "page:01-test-system/01-module-a:客户列表页")
        self.assertTrue(s1_i1["detail"]["entry"])
        self.assertEqual(s1_i1["detail"]["event"], "进入")
        self.assertEqual(s1_i1["detail"]["nextInteraction"], "I2")
        self.assertEqual(s1_i1["detail"]["failureRecovery"],
                         "加载失败时提示重试")
        expected_fields = {
            "flowTitle": "查看客户详情",
            "stepId": "S1",
            "interactionId": "I1",
            "pageTitle": "客户列表页",
            "containerState": "列表",
            "control": "无",
            "event": "进入",
            "availability": "已登录",
            "immediateFeedback": "显示骨架屏",
            "systemAction": "读取客户列表",
            "successResult": "展示客户列表",
            "failureRecovery": "加载失败时提示重试",
            "nextInteraction": "I2",
            "requirements": "TST-001",
        }
        self.assertEqual(
            {key: s1_i1["detail"][key] for key in expected_fields},
            expected_fields)

        traces = {
            (edge["detail"]["relation"], edge["to"])
            for edge in model["edges"]
            if edge["kind"] == "traces" and edge["from"] == s1_i1["nodeId"]
        }
        self.assertEqual(traces, {
            ("interaction-step", s1_i1["detail"]["stepNodeId"]),
            ("interaction-page", s1_i1["detail"]["pageId"]),
        })
        success = next(
            edge for edge in model["edges"]
            if edge["kind"] == "navigates"
            and edge["from"] == s1_i1["nodeId"]
            and edge["detail"].get("relation") == "interaction-success")
        self.assertEqual(success["to"],
                         "interaction:01-test-system/01-module-a:"
                         "查看客户详情:S1:I2")

    def test_state_impact_and_page_state_trace_to_declared_interactions(self):
        model = atlas.compile(self.root)
        impact = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "stateImpact")
        loading = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "pageState"
            and node["title"] == "加载中")
        self.assertEqual(impact["detail"]["interactionId"], "I2")
        self.assertEqual(loading["detail"]["interactionId"], "I1")
        self.assertEqual(impact["detail"]["interactionNodeId"],
                         "interaction:01-test-system/01-module-a:"
                         "查看客户详情:S1:I2")
        self.assertEqual(loading["detail"]["interactionNodeId"],
                         "interaction:01-test-system/01-module-a:"
                         "查看客户详情:S1:I1")
        relations = {
            (edge["from"], edge["detail"].get("relation"), edge["to"])
            for edge in model["edges"] if edge["kind"] == "traces"
        }
        self.assertIn((
            impact["nodeId"], "state-impact-interaction",
            impact["detail"]["interactionNodeId"]), relations)
        self.assertIn((
            loading["nodeId"], "page-state-interaction",
            loading["detail"]["interactionNodeId"]), relations)

    def test_bad_state_and_exception_interaction_references_are_gaps(self):
        cases = [
            (
                "| 查看客户详情 | S1 | I2 | 客户 | 待激活 |",
                "| 查看客户详情 | S1 | I404 | 客户 | 待激活 |",
                "流程状态影响引用不存在交互: I404",
            ),
            (
                "| S1 | I1 | 客户列表页 | 加载中 |",
                "| S1 | I404 | 客户列表页 | 加载中 |",
                "边缘状态引用不存在交互: I404",
            ),
        ]
        for old, new, expected in cases:
            with self.subTest(expected=expected):
                write_atlas_module(self.root, ATLAS_MODULE_PRD.replace(old, new))
                details = [gap["detail"]
                           for gap in atlas.compile(self.root)["gaps"]]
                self.assertTrue(any(expected in detail for detail in details),
                                details)

    def test_blank_interaction_keeps_step_level_state_association(self):
        content = ATLAS_MODULE_PRD.replace(
            "| 查看客户详情 | S1 | I2 | 客户 | 待激活 |",
            "| 查看客户详情 | S1 |  | 客户 | 待激活 |").replace(
            "| S1 | I1 | 客户列表页 | 加载中 |",
            "| S1 |  | 客户列表页 | 加载中 |")
        write_atlas_module(self.root, content)
        model = atlas.compile(self.root)
        impact = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "stateImpact")
        loading = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "pageState"
            and node["title"] == "加载中")
        self.assertEqual(impact["detail"]["interactionId"], "")
        self.assertIsNone(impact["detail"]["interactionNodeId"])
        self.assertEqual(loading["detail"]["interactionId"], "")
        self.assertIsNone(loading["detail"]["interactionNodeId"])
        self.assertTrue(any(
            edge["from"] == impact["nodeId"]
            and edge["detail"].get("relation") == "state-impact-step"
            for edge in model["edges"]))
        self.assertTrue(any(
            edge["from"] == loading["nodeId"]
            and edge["detail"].get("relation") == "page-state-step"
            for edge in model["edges"]))

    def test_absent_interaction_table_does_not_add_mandatory_gap(self):
        before, marker, after = ATLAS_MODULE_PRD.partition(
            "### 5.0.3 页面交互（机器可解析）")
        self.assertTrue(marker)
        _interaction_section, next_heading, remainder = after.partition(
            "### 5.1 查看客户详情")
        self.assertTrue(next_heading)
        write_atlas_module(self.root, before + next_heading + remainder)
        model = atlas.compile(self.root)
        self.assertFalse(any(
            "页面交互" in gap["detail"] for gap in model["gaps"]))
        self.assertEqual(model["coverage"]["interactionCount"], 0)

    def test_invalid_interaction_references_and_event_are_gaps(self):
        cases = [
            (
                "| 查看客户详情 | S1 | I1 | 客户列表页 |",
                "| 幽灵流程 | S1 | I1 | 客户列表页 |",
                "页面交互引用不存在流程: 幽灵流程",
            ),
            (
                "| 查看客户详情 | S1 | I1 | 客户列表页 |",
                "| 查看客户详情 | S404 | I1 | 客户列表页 |",
                "页面交互引用不存在步骤: S404",
            ),
            (
                "| 查看客户详情 | S1 | I1 | 客户列表页 |",
                "| 查看客户详情 | S1 | I1 | 幽灵页面 |",
                "页面交互引用未声明页面: 幽灵页面",
            ),
            (
                "| 加载失败时提示重试 | I2 | TST-001 |",
                "| 加载失败时提示重试 | I404 | TST-001 |",
                "下一交互不存在: I404",
            ),
            (
                "| 无 | 进入 | 已登录 |",
                "| 无 | hover | 已登录 |",
                "页面交互事件不受支持: hover",
            ),
        ]
        for old, new, expected in cases:
            with self.subTest(expected=expected):
                write_atlas_module(self.root, ATLAS_MODULE_PRD.replace(old, new))
                details = [gap["detail"]
                           for gap in atlas.compile(self.root)["gaps"]]
                self.assertTrue(any(expected in detail for detail in details),
                                details)

    def test_invalid_interaction_graphs_are_gaps(self):
        cases = [
            (
                ATLAS_MODULE_PRD.replace(
                    "| 查看客户详情 | S1 | I2 | 客户列表页 |",
                    "| 查看客户详情 | S1 | I1 | 客户列表页 |"),
                "交互ID重复: I1",
            ),
            (
                ATLAS_MODULE_PRD.replace(
                    "| 加载失败时提示重试 | I2 | TST-001 |",
                    "| 加载失败时提示重试 | 结束 | TST-001 |"),
                "必须恰有一个入口，实际为 2",
            ),
            (
                ATLAS_MODULE_PRD.replace(
                    "| 客户不存在时提示并保留列表 | 结束 | TST-001~003 |",
                    "| 客户不存在时提示并保留列表 | I1 | TST-001~003 |"),
                "成功链存在循环",
            ),
        ]
        for content, expected in cases:
            with self.subTest(expected=expected):
                write_atlas_module(self.root, content)
                details = [gap["detail"]
                           for gap in atlas.compile(self.root)["gaps"]]
                self.assertTrue(any(expected in detail for detail in details),
                                details)

    def test_qualified_page_reference_is_resolved_without_name_guessing(self):
        module_b = self.root / "01-test-system/02-module-b/prd.md"
        module_b.write_text("""# 模块乙
## 5. 核心用户路径
### 5.0 页面契约（机器可解析）
| 页面 | 入口 | 角色 | 前置条件 | 用户动作 | 系统结果 |
|---|---|---|---|---|---|
| 订单页 | 主导航 | 管理员 | 已登录 | 查看 | 展示 |
""", encoding="utf-8")
        qualified = "01-test-system/02-module-b::订单页"
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 查看客户详情 | S2 | 客户详情页 |",
                f"| 查看客户详情 | S2 | {qualified} |").replace(
                "| 查看客户详情 | S2 | I1 | 客户详情页 |",
                f"| 查看客户详情 | S2 | I1 | {qualified} |"))
        model = atlas.compile(self.root)
        target = "page:01-test-system/02-module-b:订单页"
        step = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "flowStep"
            and node["detail"]["stepId"] == "S2")
        interaction = next(
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "interactionStep"
            and node["detail"]["stepId"] == "S2")
        self.assertEqual(step["detail"]["pageId"], target)
        self.assertEqual(interaction["detail"]["pageId"], target)
        self.assertIn(target, {
            edge["to"] for edge in model["edges"]
            if edge["kind"] == "traces"
            and edge["from"] in {step["nodeId"], interaction["nodeId"]}
        })

    def test_qualified_page_in_existing_unstructured_module_is_explicit_gap(self):
        qualified = "01-test-system/02-module-b::订单页"
        content = ATLAS_MODULE_PRD.replace(
            "| 客户详情页 | 客户列表页 | 管理员 | 客户存在 | 查看详情 | 展示客户资料 |",
            "| 客户详情页 | 客户列表页 | 管理员 | 客户存在 | 查看详情 | 展示客户资料 |\n"
            "| 订单页 | 主导航 | 管理员 | 已登录 | 查看订单 | 展示订单 |")
        content = content.replace(
            "| 查看客户详情 | S2 | 客户详情页 |",
            f"| 查看客户详情 | S2 | {qualified} |").replace(
            "| 查看客户详情 | S2 | I1 | 客户详情页 |",
            f"| 查看客户详情 | S2 | I1 | {qualified} |")
        write_atlas_module(self.root, content)
        model = atlas.compile(self.root)
        details = [gap["detail"] for gap in model["gaps"]]
        self.assertTrue(any(
            "跨模块页面未结构化: "
            "01-test-system/02-module-b::订单页" in detail
            for detail in details), details)
        local_same_name = "page:01-test-system/01-module-a:订单页"
        self.assertTrue(any(
            node["nodeId"] == local_same_name for node in model["nodes"]))
        self.assertFalse(any(
            edge["kind"] == "traces" and edge["to"] == local_same_name
            and (edge["detail"] or {}).get("relation")
            in {"flow-step-page", "interaction-page"}
            for edge in model["edges"]))
        self.assertTrue(any(
            (node.get("detail") or {}).get("category") == "flowStep"
            and node["detail"]["stepId"] == "S2"
            for node in model["nodes"]))
        self.assertTrue(any(
            (node.get("detail") or {}).get("category") == "interactionStep"
            and node["detail"]["stepId"] == "S2"
            for node in model["nodes"]))

    def test_links_step_to_verified_state_transition_and_dependency(self):
        model = atlas.compile(self.root)
        impacts = [
            n for n in model["nodes"]
            if n["kind"] == "flow"
            and n["detail"].get("category") == "stateImpact"
        ]
        self.assertEqual(len(impacts), 1)
        impact = impacts[0]
        self.assertEqual(impact["detail"]["stepId"], "S1")
        self.assertEqual(impact["detail"]["object"], "客户")
        self.assertEqual(impact["detail"]["currentState"], "待激活")
        self.assertEqual(impact["detail"]["nextState"], "已激活")
        self.assertEqual(impact["detail"]["dependencyScopeId"],
                         "01-test-system/02-module-b")
        relations = {
            (e["kind"], e["detail"].get("relation"), e["to"])
            for e in model["edges"] if e["from"] == impact["nodeId"]
        }
        self.assertIn((
            "traces", "state-impact-step",
            "flowstep:01-test-system/01-module-a:查看客户详情:S1",
        ), relations)
        self.assertIn((
            "interacts", "state-impact-dependency",
            "01-test-system/02-module-b",
        ), relations)

    def test_dependency_only_step_does_not_invent_state_transition(self):
        content = ATLAS_MODULE_PRD.replace(
            "| 查看客户详情 | S1 | I2 | 客户 | 待激活 | 已激活 | "
            "02-module-b | 依赖不可用时阻断并提示 | TST-001 |",
            "| 查看客户详情 | S1 | I2 | 客户同步 | "
            "不涉及:只调用协作模块 | 不涉及:结果由协作模块管理 | "
            "02-module-b | 依赖不可用时保留当前页并重试 | TST-001 |")
        write_atlas_module(self.root, content)

        model = atlas.compile(self.root)
        impacts = [
            node for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "stateImpact"]
        self.assertEqual(len(impacts), 1)
        impact = impacts[0]
        self.assertFalse(impact["detail"]["stateChanged"])
        self.assertIsNone(impact["detail"]["fromStateId"])
        self.assertIsNone(impact["detail"]["toStateId"])
        self.assertIsNone(impact["detail"]["transitionEdgeId"])
        self.assertEqual(
            impact["detail"]["dependencyScopeId"],
            "01-test-system/02-module-b")
        relations = {
            (edge["kind"], edge["detail"].get("relation"), edge["to"])
            for edge in model["edges"] if edge["from"] == impact["nodeId"]}
        self.assertIn((
            "traces", "state-impact-step",
            "flowstep:01-test-system/01-module-a:查看客户详情:S1"), relations)
        self.assertIn((
            "traces", "state-impact-interaction",
            "interaction:01-test-system/01-module-a:查看客户详情:S1:I2"),
            relations)
        self.assertIn((
            "interacts", "state-impact-dependency",
            "01-test-system/02-module-b"), relations)
        self.assertFalse(any(
            relation in {"state-impact-from", "state-impact-to"}
            for _, relation, _ in relations))
        self.assertFalse(any(
            "流程状态影响未找到状态流转" in gap["detail"]
            for gap in model["gaps"]), model["gaps"])

    def test_extracts_page_states_with_page_traceability(self):
        model = atlas.compile(self.root)
        page_states = [
            n for n in model["nodes"]
            if n["kind"] == "state"
            and n["detail"]["category"] == "pageState"
        ]
        self.assertEqual({n["title"] for n in page_states},
                         {"加载中", "对象不存在"})
        page_trace_ids = {
            e["to"] for e in model["edges"]
            if e["kind"] == "traces"
            and e["detail"].get("relation") == "page-state"
        }
        self.assertEqual(page_trace_ids, {
            "page:01-test-system/01-module-a:客户列表页",
            "page:01-test-system/01-module-a:客户详情页",
        })
        self.assertEqual(model["coverage"]["pageStateCount"], 2)
        step_trace_ids = {
            e["to"] for e in model["edges"]
            if e["kind"] == "traces"
            and e["detail"].get("relation") == "page-state-step"
        }
        self.assertEqual(step_trace_ids, {
            "flowstep:01-test-system/01-module-a:查看客户详情:S1",
            "flowstep:01-test-system/01-module-a:查看客户详情:S2",
        })
        self.assertEqual({n["detail"]["stepId"] for n in page_states},
                         {"S1", "S2"})

    def test_page_state_can_trace_to_multiple_declared_pages(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 客户列表页 | 加载中 |",
                "| 客户列表页 / 客户详情页 | 加载中 |"))

        model = atlas.compile(self.root)
        loading = next(
            n for n in model["nodes"]
            if n["kind"] == "state" and n["title"] == "加载中")
        self.assertEqual(set(loading["detail"]["pageIds"]), {
            "page:01-test-system/01-module-a:客户列表页",
            "page:01-test-system/01-module-a:客户详情页",
        })
        traces = {
            e["to"] for e in model["edges"]
            if e["kind"] == "traces" and e["from"] == loading["nodeId"]
            and e["detail"].get("relation") == "page-state"
        }
        self.assertEqual(traces, set(loading["detail"]["pageIds"]))

    def test_legacy_page_state_table_shapes_remain_readable(self):
        current = """| 步骤ID | 交互ID | 页面 | 状态 | 触发条件 | 系统行为 | 用户可执行操作 | 验收要点 |
|---|---|---|---|---|---|---|---|
| S1 | I1 | 客户列表页 | 加载中 | 首次进入 | 显示骨架屏 | 等待 | 数据返回后展示列表 |
| S2 | I1 | 客户详情页 | 对象不存在 | 客户已删除 | 提示客户不存在 | 返回列表 | 不展示旧资料 |"""
        legacy_tables = [
            """| 步骤ID | 页面 | 状态 | 触发条件 | 系统行为 | 用户可执行操作 | 验收要点 |
|---|---|---|---|---|---|---|
| S1 | 客户列表页 | 加载中 | 首次进入 | 显示骨架屏 | 等待 | 数据返回后展示列表 |
| S2 | 客户详情页 | 对象不存在 | 客户已删除 | 提示客户不存在 | 返回列表 | 不展示旧资料 |""",
            """| 页面 | 状态 | 触发条件 | 系统行为 | 用户可执行操作 | 验收要点 |
|---|---|---|---|---|---|
| 客户列表页 | 加载中 | 首次进入 | 显示骨架屏 | 等待 | 数据返回后展示列表 |
| 客户详情页 | 对象不存在 | 客户已删除 | 提示客户不存在 | 返回列表 | 不展示旧资料 |""",
            """| 状态 | 触发条件 | 系统行为 | 用户可执行操作 | 验收要点 |
|---|---|---|---|---|
| 加载中 | 首次进入 | 显示骨架屏 | 等待 | 数据返回后展示列表 |
| 对象不存在 | 客户已删除 | 提示客户不存在 | 返回列表 | 不展示旧资料 |""",
        ]
        for legacy in legacy_tables:
            with self.subTest(header=legacy.splitlines()[0]):
                write_atlas_module(
                    self.root, ATLAS_MODULE_PRD.replace(current, legacy))
                model = atlas.compile(self.root)
                states = [
                    node for node in model["nodes"]
                    if (node.get("detail") or {}).get("category") == "pageState"
                ]
                self.assertEqual({node["title"] for node in states},
                                 {"加载中", "对象不存在"})
                self.assertFalse(any(
                    "边缘状态表头列序不符" in gap["detail"]
                    for gap in model["gaps"]))

    def test_extracts_business_transitions_and_boundaries(self):
        model = atlas.compile(self.root)
        business_states = [
            n for n in model["nodes"]
            if n["kind"] == "state"
            and n["detail"]["category"] == "businessState"
        ]
        self.assertEqual({n["title"] for n in business_states},
                         {"待激活", "已激活", "已停用"})
        transitions = [e for e in model["edges"] if e["kind"] == "transition"]
        self.assertEqual({(e["from"], e["to"]) for e in transitions}, {
            ("state:01-test-system/01-module-a:客户:待激活",
             "state:01-test-system/01-module-a:客户:已激活"),
            ("state:01-test-system/01-module-a:客户:已激活",
             "state:01-test-system/01-module-a:客户:已停用"),
        })
        boundaries = [
            n for n in model["nodes"]
            if n["kind"] == "flow"
            and n["detail"]["category"] == "boundary"
        ]
        self.assertEqual([n["title"] for n in boundaries], ["客户资料"])
        self.assertEqual(model["coverage"]["businessStateCount"], 3)
        self.assertEqual(model["coverage"]["boundaryCount"], 1)
        transition_gaps = [
            gap for gap in model["gaps"]
            if gap["kind"] == "missing-transition"
        ]
        self.assertTrue(any(
            "已停用" in gap["detail"] for gap in transition_gaps))

    def test_parses_transition_actions_and_results(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "待激活 --> 已激活: 激活",
                "待激活 --> 已激活: 手动激活\n"
                "    待激活 --> 已激活: 自动激活"))

        model = atlas.compile(self.root)
        transitions = [
            edge for edge in model["edges"]
            if edge["kind"] == "transition"
            and edge["from"].endswith(":客户:待激活")
        ]
        self.assertEqual(
            {edge["detail"]["action"] for edge in transitions},
            {"手动激活", "自动激活"})
        self.assertTrue(all(
            "result" not in edge["detail"] for edge in transitions))

    def test_explicit_terminal_marker_is_not_a_business_state(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 已停用 |",
                "| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 终态(停用完成) |"
            ).replace(
                "已激活 --> 已停用: 停用",
                "已激活 --> [*]: 停用完成"))

        model = atlas.compile(self.root)
        states = [
            node for node in model["nodes"]
            if node["kind"] == "state"
            and node["detail"].get("category") == "businessState"
        ]
        self.assertNotIn("终态(停用完成)", {node["title"] for node in states})
        active = next(node for node in states if node["title"] == "已激活")

        self.assertTrue(active["detail"]["declaredTerminal"])
        self.assertEqual(active["detail"]["terminalResult"], "停用完成")
        self.assertFalse(any(
            gap["kind"] == "missing-transition"
            and "已激活" in gap["detail"]
            for gap in model["gaps"]))

    def test_mermaid_outgoing_edge_clears_target_only_gap(self):
        write_atlas_module(
            self.root,
            ATLAS_MODULE_PRD.replace(
                "| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 已停用 | 是 | 管理员 | 通知客户 |",
                "| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 已停用 | 是 | 管理员 | 通知客户 |\n"
                "| 客户 | 已停用 | 暂停使用 | 停用成功 | 恢复 | 已激活 | 是 | 管理员 | 通知客户 |"
            ).replace(
                "已激活 --> 已停用: 停用",
                "已激活 --> 已停用: 停用\n"
                "    已停用 --> 已激活: 恢复"))

        model = atlas.compile(self.root)
        stopped = next(
            node for node in model["nodes"]
            if node["nodeId"].endswith(":客户:已停用"))

        self.assertNotIn("declaredAsTargetOnly", stopped["detail"])
        self.assertFalse(any(
            gap["kind"] == "missing-transition"
            and "已停用" in gap["detail"]
            for gap in model["gaps"]))

    def test_resolves_referenced_domain_state_machine(self):
        before, marker, after = ATLAS_MODULE_PRD.partition(
            "## 6. 状态机与状态流转")
        self.assertTrue(marker)
        _old_state_section, marker7, after7 = after.partition(
            "## 7. 字段与数据规则")
        referenced = """## 6. 状态机与状态流转

| 对象 | 状态机主本 | 本端(机构后台)可见状态与操作差异 |
|---|---|---|
| 账号认证段 | `../../00-global/domain-specs/account-identity.md` §2.1 | 后台可封禁/解封(TST-001) |

"""
        write_atlas_module(
            self.root, before + referenced + marker7 + after7)
        spec = self.root / "00-global/domain-specs/account-identity.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("""# 账号身份
## 2.1 账号状态



| 对象 | 当前状态 | 进入条件 | 可执行操作 | 下一状态 | 触发方式 | 是否可逆 | 通知/日志 |
|---|---|---|---|---|---|---|---|
| 账号 | 正常 | 注册成功 | 封禁 | 封禁 | 人工 | 是 | 记录操作人 |
| 账号 | 封禁 | 管理员封禁 | 解封 | 正常 | 人工 | 是 | 通知用户 |

```mermaid
stateDiagram-v2
    正常 --> 封禁: 封禁
    封禁 --> 正常: 解封
```
""", encoding="utf-8")

        model = atlas.compile(self.root)
        states = [
            n for n in model["nodes"]
            if n["kind"] == "state"
            and n["detail"].get("category") == "businessState"
        ]
        self.assertEqual({n["title"] for n in states}, {"正常", "封禁"})
        self.assertTrue(any(
            source["path"] == "00-global/domain-specs/account-identity.md"
            for node in states for source in node["sources"]))
        self.assertEqual(len([
            e for e in model["edges"] if e["kind"] == "transition"
        ]), 2)

    def test_projects_one_shared_mermaid_diagram_by_business_object(self):
        before, marker, after = ATLAS_MODULE_PRD.partition(
            "## 6. 状态机与状态流转")
        self.assertTrue(marker)
        _old_state_section, marker7, after7 = after.partition(
            "## 7. 字段与数据规则")
        referenced = """## 6. 状态机与状态流转

| 对象 | 状态机主本 | 本端(机构后台)可见状态与操作差异 |
|---|---|---|
| 身份认证 | `../../00-global/domain-specs/account-identity.md` §2.2 | 审核 |
| 身份等级 | `../../00-global/domain-specs/account-identity.md` §2.2 | 续期 |

"""
        write_atlas_module(
            self.root, before + referenced + marker7 + after7)
        spec = self.root / "00-global/domain-specs/account-identity.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("""# 账号身份
## 2.2 身份状态

| 对象 | 当前状态 | 进入条件 | 可执行操作 | 下一状态 | 触发方式 | 是否可逆 | 通知/日志 |
|---|---|---|---|---|---|---|---|
| 身份认证 | 审核中 | 提交资料 | 通过、拒绝 | 已通过、已拒绝 | 人工 | 否 | 通知结果 |
| 身份认证 | 已拒绝 | 审核拒绝 | 重新提交 | 审核中 | 人工 | 是 | 记录原因 |

| 对象 | 当前状态 | 进入条件 | 可执行操作 | 下一状态 | 触发方式 | 是否可逆 | 通知/日志 |
|---|---|---|---|---|---|---|---|
| 身份等级 | 已通过 | 审核通过 | 到期 | 已过期 | 自动 | 是 | 标红 |
| 身份等级 | 已过期 | 到达有效期 | 续期 | 已通过 | 人工 | 是 | 恢复 |

```mermaid
stateDiagram-v2
    [*] --> 审核中: 提交
    审核中 --> 已通过: 通过
    审核中 --> 已拒绝: 拒绝
    已拒绝 --> 审核中: 重新提交
    已通过 --> 已过期: 到期
    已过期 --> 已通过: 续期
```
""", encoding="utf-8")

        model = atlas.compile(self.root)
        transitions = [edge for edge in model["edges"]
                       if edge["kind"] == "transition"]
        by_object = {}
        for edge in transitions:
            obj = edge["from"].split(":")[-2]
            by_object.setdefault(obj, set()).add((
                edge["from"].split(":")[-1],
                edge["to"].split(":")[-1]))

        self.assertEqual(by_object["身份认证"], {
            ("审核中", "已通过"),
            ("审核中", "已拒绝"),
            ("已拒绝", "审核中"),
        })
        self.assertEqual(by_object["身份等级"], {
            ("已通过", "已过期"),
            ("已过期", "已通过"),
        })

    def test_invalid_step_state_and_dependency_links_are_gaps(self):
        cases = [
            (
                "| 查看客户详情 | S1 | I2 | 客户 | 待激活 | 已激活 | 02-module-b |",
                "| 查看客户详情 | S404 | I2 | 客户 | 待激活 | 已激活 | 02-module-b |",
                "引用不存在步骤: S404",
            ),
            (
                "| 查看客户详情 | S1 | I2 | 客户 | 待激活 | 已激活 | 02-module-b |",
                "| 查看客户详情 | S1 | I2 | 客户 | 未知状态 | 已激活 | 02-module-b |",
                "未找到状态流转: 客户 未知状态 → 已激活",
            ),
            (
                "| 查看客户详情 | S1 | I2 | 客户 | 待激活 | 已激活 | 02-module-b |",
                "| 查看客户详情 | S1 | I2 | 客户 | 待激活 | 已激活 | 99-ghost-module |",
                "依赖模块不存在: 99-ghost-module",
            ),
        ]
        for old, new, expected in cases:
            with self.subTest(expected=expected):
                write_atlas_module(self.root, ATLAS_MODULE_PRD.replace(old, new))
                details = [g["detail"] for g in atlas.compile(self.root)["gaps"]]
                self.assertTrue(any(expected in detail for detail in details),
                                details)

    def test_invalid_behavior_references_are_reported_as_gaps(self):
        broken = ATLAS_MODULE_PRD.replace(
            "| 查看客户详情 | S1 | 客户列表页 |",
            "| 查看客户详情 | S1 | 幽灵页面 |").replace(
            "| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | 结束 |",
            "| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | S404 |")
        write_atlas_module(self.root, broken)

        gap_details = [g["detail"] for g in atlas.compile(self.root)["gaps"]]
        self.assertTrue(any("引用未声明页面: 幽灵页面" in d
                            for d in gap_details))
        self.assertTrue(any("下一步不存在: S404" in d
                            for d in gap_details))

    def test_skeleton_module_yields_gaps_not_fabrication(self):
        model = atlas.compile(self.root)
        gap_scopes = {g["scopeId"] for g in model["gaps"]}
        self.assertTrue(any("02-module-b" in s for s in gap_scopes),
                        "骨架级模块必须呈现为缺口")
        # 骨架模块没有页面被凭空补齐。
        module_b_pages = [n for n in model["nodes"]
                         if n["kind"] == "page" and "02-module-b" in n["scopeId"]]
        self.assertEqual(module_b_pages, [])

    def test_compile_is_deterministic(self):
        first = json.dumps(atlas.compile(self.root), sort_keys=True, ensure_ascii=False)
        second = json.dumps(atlas.compile(self.root), sort_keys=True, ensure_ascii=False)
        self.assertEqual(first, second)

    def test_compile_respects_read_fence(self):
        ops_dir = self.root / "_source/reconciliation/operations"
        (ops_dir / "op-fake.json").write_text(
            json.dumps({"operationId": "op-fake", "phase": "publishing",
                        "commitPoint": "operationState",
                        "targetSource": None, "targetRevision": None}),
            encoding="utf-8")
        with self.assertRaises(effective_view.ReadFenceError):
            atlas.compile(self.root)

    def test_compile_requires_capability(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        with self.assertRaises(atlas.AtlasNotEnabled):
            atlas.compile(root)


class SectionTableTest(unittest.TestCase):
    """章节表定位：跨子标题、空行分组、空章节与未消费表（Bug 1/2/3 回归）。"""

    def setUp(self):
        self.root, self.tmp = atlas_worktree(self)

    @staticmethod
    def _replace_flow_section(body):
        before, marker, after = ATLAS_MODULE_PRD.partition(
            "### 5.0.1 核心流程（机器可解析）")
        _old, next_marker, rest = after.partition(
            "### 5.0.2 流程状态影响（机器可解析）")
        return before + marker + body + next_marker + rest

    MODULE_SCOPE = "01-test-system/01-module-a"

    def _module_gaps(self, model, suffix):
        return [
            gap for gap in model["gaps"]
            if gap["scopeId"] == self.MODULE_SCOPE
            and gap["gapId"].endswith(suffix)]

    def _flow_titles(self, model):
        return {
            node["title"] for node in model["nodes"]
            if node["kind"] == "flow"
            and (node.get("detail") or {}).get("category") == "userFlow"}

    def test_tables_under_subheadings_are_all_compiled(self):
        write_atlas_module(self.root, self._replace_flow_section("""

#### 分组A：查看客户详情

| 流程 | 步骤ID | 关联页面 | 角色 | 用户动作/触发 | 条件/分支 | 系统结果 | 下一步 | 失败处理 | 需求编号 |
|---|---|---|---|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 管理员 | 选择客户 | 客户存在 | 打开客户详情 | S2 | 提示客户不存在并停留当前页 | TST-001 |
| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | 结束 | 返回客户列表 | TST-003 |

#### 分组B：停用客户

| 流程 | 步骤ID | 关联页面 | 角色 | 用户动作/触发 | 条件/分支 | 系统结果 | 下一步 | 失败处理 | 需求编号 |
|---|---|---|---|---|---|---|---|---|---|
| 停用客户 | S1 | 客户详情页 | 管理员 | 点击停用 | 客户已激活 | 客户转已停用 | 结束 | 停用失败时提示重试 | TST-002 |

"""))

        model = atlas.compile(self.root)
        self.assertEqual(self._flow_titles(model), {"查看客户详情", "停用客户"})
        steps = {
            node["nodeId"] for node in model["nodes"]
            if (node.get("detail") or {}).get("category") == "flowStep"}
        self.assertTrue(any(nid.endswith(":查看客户详情:S2") for nid in steps))
        self.assertTrue(any(nid.endswith(":停用客户:S1") for nid in steps))
        self.assertEqual(self._module_gaps(model, ":core-flow"), [])

    def test_blank_line_grouped_rows_stay_in_one_table(self):
        write_atlas_module(self.root, self._replace_flow_section("""

| 流程 | 步骤ID | 关联页面 | 角色 | 用户动作/触发 | 条件/分支 | 系统结果 | 下一步 | 失败处理 | 需求编号 |
|---|---|---|---|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 管理员 | 选择客户 | 客户存在 | 打开客户详情 | S2 | 提示客户不存在并停留当前页 | TST-001 |
| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | 结束 | 返回客户列表 | TST-003 |

| 停用客户 | S1 | 客户详情页 | 管理员 | 点击停用 | 客户已激活 | 客户转已停用 | 结束 | 停用失败时提示重试 | TST-002 |

"""))

        model = atlas.compile(self.root)
        self.assertEqual(self._flow_titles(model), {"查看客户详情", "停用客户"})
        self.assertEqual(
            self._module_gaps(model, ":core-flow:extra-tables"), [])

    def test_section_without_any_table_is_a_gap(self):
        write_atlas_module(self.root, self._replace_flow_section("""

流程细节见 §5.1 各路径小节。

"""))

        model = atlas.compile(self.root)
        found = self._module_gaps(model, ":core-flow")
        self.assertEqual(len(found), 1, model["gaps"])
        gap = found[0]
        self.assertEqual(gap["kind"], "missing-section")
        self.assertIn("不涉及", gap["detail"])

    def test_declared_not_applicable_section_is_not_a_gap(self):
        write_atlas_module(self.root, self._replace_flow_section("""

不涉及：本模块只做资料展示，没有多步骤流程。

"""))

        model = atlas.compile(self.root)
        self.assertEqual(self._module_gaps(model, ":core-flow"), [])

    def test_unconsumed_table_in_machine_section_is_reported(self):
        write_atlas_module(self.root, self._replace_flow_section("""

| 流程 | 步骤ID | 关联页面 | 角色 | 用户动作/触发 | 条件/分支 | 系统结果 | 下一步 | 失败处理 | 需求编号 |
|---|---|---|---|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 管理员 | 选择客户 | 客户存在 | 打开客户详情 | S2 | 提示客户不存在并停留当前页 | TST-001 |
| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | 结束 | 返回客户列表 | TST-003 |

#### 分组B：停用客户

| 流程名 | 步骤 | 页面 |
|---|---|---|
| 停用客户 | S1 | 客户详情页 |

"""))

        model = atlas.compile(self.root)
        found = self._module_gaps(model, ":core-flow:extra-tables")
        self.assertEqual(len(found), 1, model["gaps"])
        gap = found[0]
        self.assertEqual(gap["kind"], "unparsed")
        self.assertIn("流程名", gap["detail"])

    def test_data_section_does_not_swallow_nested_page_data_subsection(self):
        nested = """
#### 7.0.1 页面数据读写（机器可解析）

| 流程 | 步骤ID | 页面 | 数据对象 | 操作 | 需求编号 |
|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 客户 | 读 | TST-001 |
| 查看客户详情 | S2 | 客户详情页 | 客户 | 读 | TST-003 |
"""
        write_atlas_module(self.root, ATLAS_MODULE_PRD + nested)

        model = atlas.compile(self.root)
        self.assertEqual(
            self._module_gaps(model, ":data-rw:extra-tables"), [])
        pages = {
            node["title"]: node["detail"]["dataDeclaration"]
            for node in model["nodes"] if node["kind"] == "page"}
        self.assertEqual(pages["客户列表页"], "mapped")

    def test_dotted_section_number_reference_is_sliced(self):
        spec = """# 领域规格

## 1. 对象

| 对象 | 说明 |
|---|---|
| 账号 | 登录主体 |

## 2. 状态机

| 对象 | 当前状态 | 进入条件 | 可执行操作 | 下一状态 | 触发方式 | 是否可逆 | 通知/日志 |
|---|---|---|---|---|---|---|---|
| 账号 | 正常 | 注册成功 | 封禁 | 封禁 | 人工 | 是 | 记录操作人 |

## 3. 字段规则

| 字段 | 说明 |
|---|---|
| 邮箱 | 唯一 |
"""
        sliced = atlas._section_text_for_reference(spec, "`spec.md` §2")

        self.assertIn("## 2. 状态机", sliced)
        self.assertIn("| 账号 | 正常 |", sliced.replace(
            "| 账号 | 正常 | 注册成功 | 封禁 | 封禁 | 人工 | 是 | 记录操作人 |",
            "| 账号 | 正常 |"))
        self.assertNotIn("## 3. 字段规则", sliced)
        self.assertNotIn("邮箱", sliced)
        self.assertEqual(
            sliced, atlas._section_text_for_reference(spec, "`spec.md` 第 2 节"))

    def test_local_and_referenced_state_tables_are_both_compiled(self):
        before, marker, after = ATLAS_MODULE_PRD.partition(
            "## 6. 状态机与状态流转")
        _old, next_marker, rest = after.partition("## 7. 字段与数据规则")
        both = """

| 对象 | 状态机主本 | 本端(机构后台)可见状态与操作差异 |
|---|---|---|
| 账号 | `../../00-global/domain-specs/account-identity.md` §2 | 后台可封禁/解封(TST-001) |

本模块独有对象的状态机如下：

| 对象 | 当前状态 | 状态含义 | 进入条件 | 可执行操作 | 下一状态 | 是否可逆 | 操作人 | 通知/日志 |
|---|---|---|---|---|---|---|---|---|
| 客户 | 待激活 | 已创建但未启用 | 创建成功 | 激活 | 已激活 | 否 | 管理员 | 记录操作人 |
| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 已停用 | 是 | 管理员 | 通知客户 |

```mermaid
stateDiagram-v2
    [*] --> 待激活: 创建成功
    待激活 --> 已激活: 激活
    已激活 --> 已停用: 停用
```

"""
        write_atlas_module(self.root, before + marker + both + next_marker + rest)
        spec = self.root / "00-global/domain-specs/account-identity.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("""# 账号身份

## 2. 账号状态

| 对象 | 当前状态 | 进入条件 | 可执行操作 | 下一状态 | 触发方式 | 是否可逆 | 通知/日志 |
|---|---|---|---|---|---|---|---|
| 账号 | 正常 | 注册成功 | 封禁 | 封禁 | 人工 | 是 | 记录操作人 |
| 账号 | 封禁 | 管理员封禁 | 解封 | 正常 | 人工 | 是 | 通知用户 |

```mermaid
stateDiagram-v2
    正常 --> 封禁: 封禁
    封禁 --> 正常: 解封
```

## 3. 字段规则

无。
""", encoding="utf-8")

        model = atlas.compile(self.root)
        by_object = {}
        for node in model["nodes"]:
            if (node["kind"] == "state"
                    and node["detail"].get("category") == "businessState"):
                by_object.setdefault(
                    node["detail"]["object"], set()).add(node["title"])

        self.assertEqual(by_object.get("账号"), {"正常", "封禁"})
        self.assertEqual(by_object.get("客户"), {"待激活", "已激活", "已停用"})
        transitions = {
            (edge["from"].split(":")[-2], edge["from"].split(":")[-1],
             edge["to"].split(":")[-1])
            for edge in model["edges"] if edge["kind"] == "transition"}
        self.assertIn(("账号", "正常", "封禁"), transitions)
        self.assertIn(("客户", "待激活", "已激活"), transitions)
        self.assertEqual(self._module_gaps(model, ":business-states"), [])


class PublishAndFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.root, self.tmp = atlas_worktree(self)
        manifest = atlas.publish(self.root)
        self.assertEqual(manifest["phase"], "committed")

    def test_published_artifacts_and_manifest_digests(self):
        for rel in (MODEL_RELPATH, PRESENTATION_RELPATH, MD_RELPATH,
                    MANIFEST_RELPATH, REPORT_RELPATH):
            self.assertTrue((self.root / rel).exists(), rel)
        manifest = read_json(self.root / MANIFEST_RELPATH)
        self.assertEqual(manifest["authoritativeSourceDigest"],
                         base_cas.authoritative_source_digest(self.root))
        self.assertEqual(manifest["ledgerSourceDigest"],
                         base_cas.ledger_source_digest(self.root))
        for key in ("generatorVersion", "logicModelSchemaVersion", "ledgerArtifactDigest"):
            self.assertIn(key, manifest)
        self.assertIn(PRESENTATION_RELPATH, manifest["artifacts"])
        presentation = read_json(self.root / PRESENTATION_RELPATH)
        self.assertEqual(presentation["renderer"], "archify-lifecycle")
        self.assertEqual(len(presentation["machines"]), 1)
        self.assertIn(presentation["machines"][0]["status"], ("ok", "degraded"))
        # Markdown 视图自述生成快照，不宣称「当前最新」。
        md = (self.root / MD_RELPATH).read_text(encoding="utf-8")
        digest_hex = manifest["authoritativeSourceDigest"].removeprefix("sha256:")
        self.assertIn(digest_hex[:12], md)
        self.assertIn("客户列表页", md)

    def test_fresh_after_publish_then_stale_on_master_edit(self):
        self.assertTrue(atlas.check_freshness(self.root)["contentFresh"])
        (self.root / MODULE_A_PRD_RELPATH).write_text(
            (self.root / MODULE_A_PRD_RELPATH).read_text(encoding="utf-8") + "\n补充说明\n",
            encoding="utf-8")
        before = snapshot(self.root)
        result = atlas.check_freshness(self.root)
        self.assertFalse(result["contentFresh"])
        self.assertEqual(snapshot(self.root), before, "检查器必须零写入")

    def test_pending_revision_does_not_stale_atlas(self):
        v2 = self.tmp / "v2.xlsx"
        build_xlsx(v2, data_rows=ROWS_V2)
        sync.sync_source(self.root, SOURCE_ID, v2)  # 只推进 observed/pending
        self.assertTrue(atlas.check_freshness(self.root)["contentFresh"],
                        "未确认内容不得让 PRD 未变的 Atlas 无故过期")

    def test_tampered_ledger_is_stale(self):
        ledger = self.root / "_generated/requirements-ledger.jsonl"
        ledger.write_text(ledger.read_text(encoding="utf-8") + '{"junk":1}\n',
                          encoding="utf-8")
        self.assertFalse(atlas.check_freshness(self.root)["contentFresh"],
                         "旧/坏 Ledger 配新主本不得 contentFresh")


class FailClosedTest(unittest.TestCase):
    def test_validation_failure_writes_nothing(self):
        root, _ = atlas_worktree(self)
        write_atlas_module(root, ATLAS_MODULE_PRD_BROKEN)  # 指向不存在的模块
        with self.assertRaises(atlas.AtlasValidationError):
            atlas.publish(root)
        self.assertFalse((root / MODEL_RELPATH).exists())
        self.assertFalse((root / MD_RELPATH).exists())


class StageGateTest(unittest.TestCase):
    MARKDOWN_STEPS = ["rebuild-ledger", "compile-logic-model", "validate-model",
                      "render-markdown", "write-manifest", "static-check-markdown"]

    def _steps(self, root):
        gate = atlas.gate_requirements(root)
        return gate["stage"], [(s["id"], s["blocking"]) for s in gate["steps"]]

    def test_legacy_and_disabled_have_no_atlas_steps(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        legacy_root = make_legacy_worktree(tmp.name)
        stage, steps = self._steps(legacy_root)
        self.assertEqual((stage, steps), ("legacy", []))

        migration.commit_migration(legacy_root, confirmations={MANUAL_KEY: "TST-006"})
        stage, steps = self._steps(legacy_root)  # sourceSync 开、logicAtlas 关
        self.assertEqual((stage, steps), ("legacy", []))

    def test_markdown_stage_excludes_html(self):
        root, _ = atlas_worktree(self, stage="markdown")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "markdown")
        self.assertEqual([s for s, _ in steps], self.MARKDOWN_STEPS)
        self.assertTrue(all(blocking for _, blocking in steps))

    def test_html_stage_appends_blocking_html_steps(self):
        root, _ = atlas_worktree(self, stage="html")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "html")
        self.assertEqual([s for s, _ in steps],
                         self.MARKDOWN_STEPS + ["render-html", "static-check-html"])
        self.assertTrue(all(blocking for _, blocking in steps))

    def test_polish_stage_naturalization_is_non_blocking(self):
        root, _ = atlas_worktree(self, stage="polish")
        stage, steps = self._steps(root)
        self.assertEqual(stage, "polish")
        self.assertEqual(steps[-1], ("naturalize-narratives", False))
        self.assertTrue(all(blocking for _, blocking in steps[:-1]))


if __name__ == "__main__":
    unittest.main()
