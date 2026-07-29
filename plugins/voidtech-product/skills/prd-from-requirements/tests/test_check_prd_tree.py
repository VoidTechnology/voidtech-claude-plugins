"""check-prd-tree.py 改造后的行为契约（技术设计 §9、§10;ADR-0004）。

- legacy 工作树（无 prd-worktree.json）通过检查,行为与改造前一致。
- 读取栅栏（publishing）: 退出码 3、报告 operation id、零写入（mtime +
  内容快照对比）。
- 默认模式排除 `_source/reconciliation/`: staging 镜像不重复计入。
- `--operation-id` 模式经 overlay resolver 看到 staging 版本,且同一逻辑
  文件只出现一次。
- Logic Atlas 能力开启后带外改主本 → 检查失败并报 stale（§10）。
- 已声明的编号格式正则,必须被同段数的编号字面量满足;自校准的不误报范围
  与已知盲区一并固化。
"""

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from legacy_fixture import (
    MANUAL_KEY, MODULE_A_PRD_RELPATH, enable_logic_atlas,
    make_legacy_worktree, write_atlas_module,
)
from worktree_fixture import SKILL_ROOT

from prdsync import atlas, migration
from prdsync.markdown_validator import (
    ACCEPTANCE_LOGIC_MARKERS, acceptance_section_has_content,
)
from prdsync.writer_lock import OPERATIONS_RELPATH

CHECKER = SKILL_ROOT / "scripts" / "check-prd-tree.py"


def run_checker(root, *extra):
    return subprocess.run(
        [sys.executable, str(CHECKER), str(root), *extra],
        capture_output=True, text=True)


def clean_legacy_worktree(testcase) -> Path:
    """legacy fixture 树本身缺模块主本「深度」声明,补齐得到最小干净树。"""
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    root = make_legacy_worktree(tmp.name)
    for module, title in (("01-module-a", "模块甲"), ("02-module-b", "模块乙")):
        (root / f"01-test-system/{module}/prd.md").write_text(
            f"# {title}\n\n- 深度:骨架级\n\n骨架级模块主本。\n", encoding="utf-8")
    return root


def full_snapshot(root):
    """全树 {相对路径: (mtime_ns, 内容字节)} 快照,用于零写入断言。"""
    result = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_file():
            stat = path.stat()
            result[path.relative_to(root).as_posix()] = (stat.st_mtime_ns, path.read_bytes())
    return result


def template_section(text, marker):
    """取含 marker 的标题到下一个同级或更高级标题之间的正文。"""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        heading = re.match(r"^(#{1,6})\s+", line.strip())
        if not heading or marker not in line:
            continue
        level = len(heading.group(1))
        for cursor in range(index + 1, len(lines)):
            following = re.match(r"^(#{1,6})\s+", lines[cursor].strip())
            if following and len(following.group(1)) <= level:
                return "\n".join(lines[index + 1:cursor])
        return "\n".join(lines[index + 1:])
    return ""


def write_operation_manifest(root, op_id, phase, files=()):
    ops_dir = Path(root) / OPERATIONS_RELPATH
    ops_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"operationId": op_id, "phase": phase, "files": list(files)}
    (ops_dir / f"{op_id}.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def stage_module_a_with_todo(root, op_id="op-stage-1"):
    """暂存一份引入 TODO 错误的模块甲主本,返回 staging 相对路径。"""
    staged_rel = f"{OPERATIONS_RELPATH}/{op_id}/staging/{MODULE_A_PRD_RELPATH}"
    staged = Path(root) / staged_rel
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(
        "# 模块甲\n\n- 深度:骨架级\n\n骨架级模块主本。\n\nTODO 待补详情\n",
        encoding="utf-8")
    write_operation_manifest(root, op_id, "staged", files=[
        {"action": "write", "path": MODULE_A_PRD_RELPATH, "stagedPath": staged_rel},
    ])
    return staged_rel


class LegacyWorktreeTest(unittest.TestCase):
    def test_clean_legacy_worktree_passes(self):
        root = clean_legacy_worktree(self)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("检查完成: 3 个文件, 0 个错误, 0 个警告", proc.stdout)


class AcceptanceStructureTest(unittest.TestCase):
    def test_acceptance_module_requires_auditable_logic_tables(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            "# 模块甲\n\n- 深度:验收级\n\n只有叙述，没有审计结构。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("验收级模块缺少审计结构", proc.stdout)
        self.assertIn("页面数据读写（机器可解析）", proc.stdout)


    def test_acceptance_module_requires_permission_and_field_contracts(self):
        """权限与字段契约同属 Atlas 编译依赖（atlas.py 的 marker 常量为准）。

        只查流程侧六项、放行权限与字段，会让模块合法标成「验收级」并通过机械
        自检，而 Atlas 编译时 requiredActions.permissionRefs 与字段示例全进
        gaps——「验收级」由此变成自报深度，不是可验证事实。
        """
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        sections = "\n\n".join(
            f"## {marker}\n\n| 列甲 | 列乙 |\n|---|---|\n| 数据 | 行 |"
            for marker in (
                "页面契约（机器可解析）",
                "核心流程（机器可解析）",
                "流程状态影响（机器可解析）",
                "页面交互（机器可解析）",
                "状态机与状态流转",
                "页面数据读写（机器可解析）"))
        module.write_text(
            f"# 模块甲\n\n- 深度:验收级\n\n{sections}\n", encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        for marker in ("模块交互（机器可解析）", "步骤权限合同（机器可解析）",
                       "字段定义（机器可解析）", "权限矩阵"):
            self.assertIn(
                f"验收级模块缺少审计结构「{marker}」", proc.stdout)


    def test_template_blockquote_does_not_satisfy_not_applicable(self):
        """模板说明里的「不涉及：…」示例不算声明——否则硬门形同虚设。

        `§5.0.4`、`§7.0.1` 的模板说明 blockquote 自带「不涉及：{原因}」示例
        句。豁免检测若搜整个章节，照模板生成的文档只要保留说明、删掉整张表，
        就被判成「已声明不涉及」。真实声明写在表格行或正文，不写在引用块里。
        """
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        sections = "\n\n".join(
            f"## {marker}\n\n> 本表按模块条件适用。无角色差异时写一行"
            f"「不涉及：本模块无角色差异」即可，不逐步骤铺表。"
            for marker in ACCEPTANCE_LOGIC_MARKERS)
        module.write_text(
            f"# 模块甲\n\n- 深度:验收级\n\n{sections}\n", encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("审计结构没有数据行", proc.stdout)


    def test_shipped_template_satisfies_every_gated_marker(self):
        """模板必须自带全部受硬门约束的章节与数据行。

        硬门、`atlas.py` 的 marker 常量与模板三方对齐，靠这条锁：任一侧改了
        标题字面或删了表，模板产出的文档就会被自己的硬门判错，而这种漂移只有
        用户建树时才发现。
        """
        template = (SKILL_ROOT / "templates" / "module-prd.md").read_text(
            encoding="utf-8")
        for marker in ACCEPTANCE_LOGIC_MARKERS:
            with self.subTest(marker=marker):
                self.assertIn(marker, template)
                self.assertTrue(
                    acceptance_section_has_content(template, marker),
                    f"模板的「{marker}」章节过不了硬门")

    def test_template_exemption_wording_passes_the_gate(self):
        """模板教作者写的清空写法，必须是硬门认的写法。

        §3.4 曾写「无跨模块交互写「无」并删除表格」：照做的独立模块标验收级后
        拿到一个模板里找不到解法的硬错误——豁免只认「不涉及：原因」。这里只取
        允许清空本节的句子（提到删除表格/整节/不逐步骤铺表），不管列取值约定。
        """
        template = (SKILL_ROOT / "templates" / "module-prd.md").read_text(
            encoding="utf-8")
        checked = 0
        for marker in ACCEPTANCE_LOGIC_MARKERS:
            for sentence in re.split(r"[。\n]", template_section(template, marker)):
                if not any(hint in sentence for hint in
                           ("删除表格", "整节", "不逐步骤铺表")):
                    continue
                for literal in re.findall(r"[「『]([^」』]+)[」』]", sentence):
                    checked += 1
                    with self.subTest(marker=marker, literal=literal):
                        self.assertTrue(
                            acceptance_section_has_content(
                                f"## {marker}\n\n{literal}\n", marker),
                            f"「{marker}」章节的清空写法「{literal}」过不了硬门")
        self.assertGreaterEqual(checked, 3, "模板的清空写法句子没被取到，检查提示词")

    def test_navigation_label_is_not_a_business_state(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            """# 模块甲

- 深度:骨架级

```mermaid
stateDiagram-v2
    正常 --> 已注销
```

进入「转为会员」/会员列表。
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("疑似幽灵状态「转为会员」", proc.stdout)


    def test_acceptance_module_rejects_empty_audit_tables(self):
        root = clean_legacy_worktree(self)
        module = root / MODULE_A_PRD_RELPATH
        sections = "\n\n".join(
            f"## {marker}\n\n| 占位列 |\n|---|"
            for marker in (
                "模块交互（机器可解析）",
                "页面契约（机器可解析）",
                "核心流程（机器可解析）",
                "流程状态影响（机器可解析）",
                "页面交互（机器可解析）",
                "步骤权限合同（机器可解析）",
                "状态机与状态流转",
                "页面数据读写（机器可解析）",
                "字段定义（机器可解析）",
                "权限矩阵"))
        module.write_text(
            f"# 模块甲\n\n- 深度:验收级\n\n{sections}\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("审计结构没有数据行", proc.stdout)


CHANGELOG_OK = """## 9. 变更记录

| 日期 | 版本 | 主题 | commit |
|---|---|---|---|
| 2026-07-29 | 1.2 | 补部分收款的落账路径 | `a1b2c3d` |
"""


class SummaryDocumentTest(unittest.TestCase):
    """汇总正文不得落盘: 没有生成器的「生成物」声明只能靠记性执行。"""

    def test_root_full_prd_is_rejected(self):
        root = clean_legacy_worktree(self)
        (root / "full-prd.md").write_text(
            "# 完整 PRD\n\n- 深度:骨架级\n\n本文档为生成物。\n", encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("汇总正文不得落盘", proc.stdout)

    def test_system_level_full_prd_is_rejected(self):
        root = clean_legacy_worktree(self)
        (root / "01-test-system/test-system-full-prd.md").write_text(
            "# 系统汇总\n\n- 深度:骨架级\n\n本文档为生成物。\n", encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("汇总正文不得落盘", proc.stdout)


class ChangelogContractTest(unittest.TestCase):
    """变更记录固定四列,格内不写关于修改本身的声明。"""

    def write_module(self, root, changelog):
        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            f"# 模块甲\n\n- 深度:骨架级\n\n骨架级模块主本。\n\n{changelog}",
            encoding="utf-8")

    def test_four_column_changelog_passes(self):
        root = clean_legacy_worktree(self)
        self.write_module(root, CHANGELOG_OK)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_legacy_six_column_changelog_is_rejected(self):
        root = clean_legacy_worktree(self)
        self.write_module(root, """## 9. 变更记录

| 日期 | 版本 | 变更摘要 | 变更原因 | 影响范围 | 修改人 |
|---|---|---|---|---|---|
| 2026-07-29 | 1.2 | 补落账路径 | 核验打回 | 第 4 节 | 主 Agent |
""")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("变更记录表头必须是固定四列", proc.stdout)

    def test_count_reconciliation_in_changelog_is_rejected(self):
        root = clean_legacy_worktree(self)
        self.write_module(root, """## 9. 变更记录

| 日期 | 版本 | 主题 | commit |
|---|---|---|---|
| 2026-07-29 | 1.2 | 边缘状态扩到 14 项 | `a1b2c3d` |
""")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("变更记录禁止写数量对账", proc.stdout)

    def test_claim_about_the_fix_itself_is_rejected(self):
        root = clean_legacy_worktree(self)
        self.write_module(root, """## 9. 变更记录

| 日期 | 版本 | 主题 | commit |
|---|---|---|---|
| 2026-07-29 | 1.2 | 更正上一版的虚报 | `a1b2c3d` |
""")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("关于修改本身的声明", proc.stdout)


class CountConsistencyTest(unittest.TestCase):
    def test_cross_section_count_restatement_is_rejected(self):
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            "# 模块甲\n\n- 深度:骨架级\n\n操作类型见第 4.1 节，共 14 项。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("既指向别处、又写死数目", proc.stdout)

    def test_leadin_count_must_match_following_table(self):
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

边缘状态共 3 项：

| 场景 | 系统行为 |
|---|---|
| 甲 | 拒绝 |
| 乙 | 排队 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("与紧随表格的实际行数 2 不符", proc.stdout)


class DeclaredIdFormatTest(unittest.TestCase):
    """已声明的编号格式正则,必须被同段数的编号字面量满足。

    规则靠自校准控制假阳性(一条正则只管「已经有合规实例」的前缀),因此
    正例、假阳性例和自校准换来的盲区都要固化——盲区一旦被无意「修掉」,
    换回来的是朴素版本上千条的假阳性。
    """

    DECLARED = "| 会员号 | string | 格式 `^[A-Z]{2,8}-\\d{5}$` |"

    def write_module(self, body):
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            f"# 模块甲\n\n- 深度:骨架级\n\n{self.DECLARED}\n\n{body}\n",
            encoding="utf-8")
        return root

    def test_stale_id_literal_is_rejected(self):
        """真实漏检成因: 定案格式后没回扫编号字面量,AC 夹具留着旧形态。"""
        root = self.write_module(
            "验收: 旧号 `HKSC-00042` 迁移后新号不等于 `HKSC-S001`。")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("编号字面量「HKSC-S001」不满足已声明的格式", proc.stdout)

    def test_conforming_literals_pass(self):
        root = self.write_module("验收: 旧号 `HKSC-00042` 迁移为 `HKSC-00043`。")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_other_prefixes_are_not_governed(self):
        """声明里的 `[A-Z]{2,8}` 是「任意租户前缀」,不是「任意编号」。"""
        root = self.write_module(
            "会员 `HKSC-00042`;架构决策 `ARC-201`;需求 `P1B-0003`。")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_different_segment_count_is_out_of_scope(self):
        """收据号三段,不该拿会员号的两段正则去判它。"""
        root = self.write_module("会员 `HKSC-00042` 的收据号 `HKSC-2026-000123`。")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_prefix_without_conforming_instance_is_blind_spot(self):
        """已知盲区: 某前缀下全部字面量都是旧形态时,规则不认领该前缀。

        自校准的代价——没有合规实例就无从判断该前缀归哪条正则管。本规则
        只覆盖「新旧共存」,不覆盖「全量陈旧」;后者仍要靠定案时的回扫。
        """
        root = self.write_module("验收: 新号 `HKSC-S001`。")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class VerbatimQuoteTest(unittest.TestCase):
    def test_verbatim_column_must_match_source(self):
        root = clean_legacy_worktree(self)
        source = root / "_source" / "original" / "req.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            "| 1 | 账号信息 | 邮箱、手机号、第三方绑定 |\n", encoding="utf-8")
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

| 来源 | 原文（逐字） |
|---|---|
| `P1W-004` | 字段：邮箱、手机号、第三方绑定 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("标为逐字的引文", proc.stdout)

    def test_true_verbatim_quote_passes(self):
        root = clean_legacy_worktree(self)
        source = root / "_source" / "original" / "req.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            "| 1 | 账号信息 | 邮箱、手机号、第三方绑定 |\n", encoding="utf-8")
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

| 来源 | 原文（逐字） |
|---|---|
| `P1W-004` | 邮箱、手机号、第三方绑定 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class FalsePositiveTest(unittest.TestCase):
    """假阳性必须当场修脚本——留着它等于教所有人忽略整个告警通道。"""

    def test_template_column_name_is_not_a_bare_marker(self):
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

| 编号 | 问题 | 推荐默认方案 | 需要确认人 |
|---|---|---|---|
| `OQ-001` | 阈值未定 | 每小时 10 次 | 总会 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("裸「推荐默认」", proc.stdout)

    def test_derive_as_business_verb_is_not_a_marker_variant(self):
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            "# 模块甲\n\n- 深度:骨架级\n\n会计科目订单侧不存储，导出时自流水派生。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("派生", proc.stdout)

    def test_derive_as_field_source_value_is_not_flagged(self):
        """字段定义表的「来源 = 派生」是合法第三类取值,不是漏标的推断。"""
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

| 字段 | 含义 | 来源 | 可编辑 |
|---|---|---|---|
| 剩余天数 | 到期日 − 当日 | 派生 | 否 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("派生", proc.stdout)

    def test_marker_variant_does_not_cross_table_cells(self):
        """「[推荐默认] | 待确认」是两格,不是一处「默认…待确认」变体。"""
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            """# 模块甲

- 深度:骨架级

| 需求 | 期次 | 状态 |
|---|---|---|
| `ARC-033` | 二期 [推荐默认] | 待确认 |
""",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("默认…待确认", proc.stdout)

    def test_prose_about_the_marker_system_is_not_a_bare_marker(self):
        """「是原文而非推断」在谈标记体系,不是漏标。"""
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            "# 模块甲\n\n- 深度:骨架级\n\n"
            "留痕要求本身是原文，只有「纳入敏感清单」是推断；币种是原文而非推断。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("裸「推断」", proc.stdout)

    def test_business_threshold_is_not_a_count_restatement(self):
        """「单次导出 > 1000 条」是业务阈值,不是复述表规模。"""
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            "# 模块甲\n\n- 深度:骨架级\n\n"
            "第 4 节的告警阈值：单次导出 > 1000 条、单日累计超过 20 次。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_ordinal_index_is_not_a_count_restatement(self):
        """「操作功能列第 6 项」是序数索引,不是规模。"""
        root = clean_legacy_worktree(self)
        (root / MODULE_A_PRD_RELPATH).write_text(
            "# 模块甲\n\n- 深度:骨架级\n\n"
            "这是 `P1B-035` 操作功能列第 6 项，第 2.3 节据此裁决可见范围。\n",
            encoding="utf-8")

        proc = run_checker(root)

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class ReadFenceTest(unittest.TestCase):
    def test_publishing_operation_exits_3_and_writes_nothing(self):
        root = clean_legacy_worktree(self)
        write_operation_manifest(root, "op-fence-1", "publishing")
        before = full_snapshot(root)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn("op-fence-1", proc.stderr)
        self.assertIn("prd-sync recover", proc.stderr)
        self.assertEqual(full_snapshot(root), before, "读取栅栏路径必须零写入")


class OverlayViewTest(unittest.TestCase):
    def test_default_mode_excludes_staging_mirror(self):
        root = clean_legacy_worktree(self)
        stage_module_a_with_todo(root)
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("TODO", proc.stdout, "staging 镜像不得计入默认扫描")
        self.assertIn("检查完成: 3 个文件", proc.stdout, "staging 副本不得重复计入文件数")

    def test_operation_id_mode_sees_staged_version_exactly_once(self):
        root = clean_legacy_worktree(self)
        staged_rel = stage_module_a_with_todo(root, op_id="op-stage-2")
        proc = run_checker(root, "--operation-id", "op-stage-2")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertEqual(
            proc.stdout.count("残留 TODO"), 1,
            "同一逻辑文件只能出现一次: " + proc.stdout)
        self.assertIn(f"{MODULE_A_PRD_RELPATH}:7: 残留 TODO", proc.stdout,
                      "错误必须落在逻辑相对路径上")
        self.assertNotIn(staged_rel, proc.stdout, "不得暴露 staging 物理路径")
        self.assertIn("检查完成: 3 个文件", proc.stdout)

    def test_operation_id_mode_missing_manifest_is_usage_error(self):
        root = clean_legacy_worktree(self)
        proc = run_checker(root, "--operation-id", "op-ghost")
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)


class AtlasFreshnessTest(unittest.TestCase):
    def test_out_of_band_master_edit_reports_stale(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = make_legacy_worktree(tmp.name)
        migration.commit_migration(root, confirmations={MANUAL_KEY: "TST-006"})
        write_atlas_module(root)
        enable_logic_atlas(root)
        atlas.publish(root)

        fresh_proc = run_checker(root)
        self.assertNotIn("stale", fresh_proc.stdout,
                         "发布后未带外修改不得报 stale")

        module = root / MODULE_A_PRD_RELPATH
        module.write_text(
            module.read_text(encoding="utf-8") + "\n带外补充说明\n",
            encoding="utf-8")
        proc = run_checker(root)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("stale", proc.stdout)
        self.assertIn("authoritativeSourceDigest", proc.stdout)


if __name__ == "__main__":
    unittest.main()
