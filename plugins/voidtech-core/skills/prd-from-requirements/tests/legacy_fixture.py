"""门 2 fixture：合成 legacy PRD 工作树（区间级矩阵 + 无序号行 + 原始 xlsx）。

结构与真实 Example 工作树同构：`_source/original/*.xlsx` 原件、区间级
需求追溯矩阵（`TST-001 ~ 003` 区间行、`TST-003+a` 无序号待确认行、覆盖率
对账表）、模块目录。无 prd-worktree.json（legacy 工作树）。
"""

import hashlib
import sys
import zipfile
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

MANUAL_KEY = "TST-003+a"
AUTO_COUNT = 5
MANUAL_COUNT = 1

# 数据行：(序号|None, 模块, 需求点)。None = 无序号行。
ROWS_BASE = [
    (1, "模块甲", "客户新增"),
    (2, "模块甲", "客户列表"),
    (3, "模块甲", "客户详情"),
    (None, "模块甲", "站内通知-无序号补充"),   # → TST-003+a
    (4, "模块乙", "订单列表"),
    (5, "模块乙", "订单导出"),
]

# V2：一处正文修改（客户列表→支持导出）、一条新增（订单退款）且插在中部——
# 后续行的物理行号全部偏移，用于验证 recordKey 与行号无关。
ROWS_V2 = [
    (1, "模块甲", "客户新增"),
    (2, "模块甲", "客户列表-支持导出"),
    (6, "模块乙", "订单退款"),
    (3, "模块甲", "客户详情"),
    (None, "模块甲", "站内通知-无序号补充"),
    (4, "模块乙", "订单列表"),
    (5, "模块乙", "订单导出"),
]

# DUP：两条业务内容完全相同的行（序号不同）——duplicateOrdinal 消歧用。
ROWS_DUP = ROWS_BASE + [
    (6, "模块乙", "会员导入"),
    (7, "模块乙", "会员导入"),
]

# REMOVED：删去「订单导出」（TST-005）——撤回候选用。
ROWS_REMOVED = ROWS_BASE[:-1]

# BACKFILL：带外变更的需求随后出现在主表中（来源回填用）。
BACKFILL_TEXT = "邮件补充-数据导出"
ROWS_BACKFILL = ROWS_BASE + [(6, "模块乙", BACKFILL_TEXT)]

# ---------------------------------------------------------------- Logic Atlas 工装

ATLAS_MODULE_PRD = """# 模块甲 PRD

## 3. 需求范围

### 3.3 模块边界

| 边界项 | 本模块负责 | 不负责 | 依赖模块/系统 |
|---|---|---|---|
| 客户资料 | 客户资料维护 | 订单履约 | 02-module-b |

### 3.4 模块交互（机器可解析）

| 目标模块 | 方向 | 触发 | 失败传播 |
|---|---|---|---|
| 02-module-b | 调用 | 客户下单后查询订单 | 提示稍后重试 |

## 5. 核心用户路径

### 5.0 页面契约（机器可解析）

| 页面 | 入口 | 角色 | 前置条件 | 用户动作 | 系统结果 |
|---|---|---|---|---|---|
| 客户列表页 | 主导航 | 管理员 | 已登录 | 查看客户列表 | 展示分页客户 |
| 客户详情页 | 客户列表页 | 管理员 | 客户存在 | 查看详情 | 展示客户资料 |

### 5.0.1 核心流程（机器可解析）

| 流程 | 步骤ID | 关联页面 | 角色 | 用户动作/触发 | 条件/分支 | 系统结果 | 下一步 | 失败处理 | 需求编号 |
|---|---|---|---|---|---|---|---|---|---|
| 查看客户详情 | S1 | 客户列表页 | 管理员 | 选择客户 | 客户存在 | 打开客户详情 | S2 | 提示客户不存在并停留当前页 | TST-001~003 |
| 查看客户详情 | S2 | 客户详情页 | 管理员 | 查看资料 | 客户存在 | 展示客户资料 | 结束 | 返回客户列表 | TST-003 |

### 5.1 查看客户详情

**边缘状态**

| 页面 | 状态 | 触发条件 | 系统行为 | 用户可执行操作 | 验收要点 |
|---|---|---|---|---|---|
| 客户列表页 | 加载中 | 首次进入 | 显示骨架屏 | 等待 | 数据返回后展示列表 |
| 客户详情页 | 对象不存在 | 客户已删除 | 提示客户不存在 | 返回列表 | 不展示旧资料 |

## 6. 状态机与状态流转

| 对象 | 当前状态 | 状态含义 | 进入条件 | 可执行操作 | 下一状态 | 是否可逆 | 操作人 | 通知/日志 |
|---|---|---|---|---|---|---|---|---|
| 客户 | 待激活 | 已创建但未启用 | 创建成功 | 激活 | 已激活 | 否 | 管理员 | 记录操作人 |
| 客户 | 已激活 | 可正常使用 | 激活成功 | 停用 | 已停用 | 是 | 管理员 | 通知客户 |

## 7. 字段与数据规则

### 7.0 数据读写（机器可解析）

| 数据对象 | 操作 | 权威来源 | 同步方式 |
|---|---|---|---|
| 客户 | 读 | 01-module-a | 实时 |
| 客户 | 写 | 01-module-a | 实时 |
"""

# 交互目标不存在的变体——模型校验必须 fail closed。
ATLAS_MODULE_PRD_BROKEN = ATLAS_MODULE_PRD.replace("02-module-b", "99-ghost-module")

MODULE_A_PRD_RELPATH = "01-test-system/01-module-a/prd.md"


def write_atlas_module(root, content=ATLAS_MODULE_PRD):
    (Path(root) / MODULE_A_PRD_RELPATH).write_text(content, encoding="utf-8")


def enable_logic_atlas(root, stage="markdown"):
    """置位 Atlas 能力开关（fixture 直写 prd-worktree.json，模拟阶段交付置位）。"""
    import json as _json
    manifest_path = Path(root) / "prd-worktree.json"
    manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["capabilities"]["logicAtlas"] = True
    manifest["logicAtlasStage"] = stage
    manifest["schemaVersions"]["logicModel"] = 1
    manifest_path.write_text(
        _json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                    separators=(",", ":")) + "\n", encoding="utf-8")

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _layout(data_rows):
    """把数据行编译为 (shared_strings, sheet_rows)：标题 + 表头 + 数据。"""
    shared = ["需求表-测试", "序号", "模块", "需求点"]

    def sid(text):
        if text not in shared:
            shared.append(text)
        return shared.index(text)

    sheet_rows = [
        (1, [("A", "s", 0)]),
        (2, [("A", "s", 1), ("B", "s", 2), ("C", "s", 3)]),
    ]
    for offset, (seq, module, text) in enumerate(data_rows):
        cells = []
        if seq is not None:
            cells.append(("A", "n", seq))
        cells.append(("B", "s", sid(module)))
        if text is not None:  # None = 该行正文单元格缺失（空观测/合并续行）
            cells.append(("C", "s", sid(text)))
        sheet_rows.append((3 + offset, cells))
    return shared, sheet_rows


def _sheet_xml(sheet_rows, merges=()) -> str:
    rows = []
    for row_num, cells in sheet_rows:
        parts = []
        for col, kind, value in cells:
            ref = f"{col}{row_num}"
            if kind == "s":
                parts.append(f'<c r="{ref}" t="s"><v>{value}</v></c>')
            else:
                parts.append(f'<c r="{ref}"><v>{value}</v></c>')
        rows.append(f'<row r="{row_num}">{"".join(parts)}</row>')
    merge_xml = ""
    if merges:
        refs = "".join(f'<mergeCell ref="{ref}"/>' for ref in merges)
        merge_xml = f'<mergeCells count="{len(merges)}">{refs}</mergeCells>'
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<worksheet xmlns="{_MAIN_NS}"><sheetData>{"".join(rows)}</sheetData>'
            f"{merge_xml}</worksheet>")


def build_xlsx(path: Path, data_rows=None, date_time=(2026, 7, 1, 0, 0, 0),
               merges=()) -> None:
    shared, sheet_rows = _layout(ROWS_BASE if data_rows is None else data_rows)
    shared_items = "".join(f"<si><t>{text}</t></si>" for text in shared)
    members = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            "</Types>"),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{_PKG_REL_NS}">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<workbook xmlns="{_MAIN_NS}" xmlns:r="{_REL_NS}">'
            '<sheets><sheet name="saas后台" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{_PKG_REL_NS}">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            "</Relationships>"),
        "xl/sharedStrings.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<sst xmlns="{_MAIN_NS}" count="{len(shared)}" uniqueCount="{len(shared)}">'
            f"{shared_items}</sst>"),
        "xl/worksheets/sheet1.xml": _sheet_xml(sheet_rows, merges),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            info = zipfile.ZipInfo(name, date_time=date_time)
            archive.writestr(info, content)


def make_legacy_worktree(base) -> Path:
    root = Path(base) / "legacy-worktree"
    xlsx_path = root / "_source/original/requirements.xlsx"
    build_xlsx(xlsx_path)
    sha = hashlib.sha256(xlsx_path.read_bytes()).hexdigest()

    matrix = f"""# 需求追溯矩阵

- 日期:2026-07-01
- 状态:Draft(骨架阶段,分组级追溯)
- 深度:骨架级
- 权威来源:`../_source/original/requirements.xlsx`(工作树内权威副本,SHA-256 `{sha}`)

## 说明

- 需求 ID 前缀:`TST-`,编号对齐原表「序号」。
- **无序号行**:原表存在少量无序号行(疑似后补需求),以 `xxx+a` 标注,落盘前需对照原始 xlsx 人工确认效力。

## 一、saas后台 → 系统 A:测试系统

| 需求 ID 区间 | 数量 | 原表模块/子模块 | 归属模块 | 期次 |
|---|---|---|---|---|
| TST-001 ~ 003 | 3 | 模块甲 | 01-module-a | MVP |
| TST-003+a | 1 | 模块甲/站内通知(无序号) | 01-module-a | 二期 |
| TST-004 ~ 005 | 2 | 模块乙 | 02-module-b | MVP |

小计:5 序号 + 1 无序号 = **6**

## 覆盖率对账

| 来源 sheet | 原表序号数 | 无序号行 | 输入合计 | 已映射 | 遗漏 |
|---|---|---|---|---|---|
| saas后台 | 5 | 1 | 6 | 6 | 0 |
| **总计** | **{AUTO_COUNT}** | **{MANUAL_COUNT}** | **6** | **6** | **0** |

## 待人工核对项(落盘前)

1. 1 条无序号行({MANUAL_KEY})是否为有效需求,以原始 xlsx 为准。
"""
    (root / "00-global").mkdir(parents=True, exist_ok=True)
    (root / "00-global/requirement-traceability-matrix.md").write_text(matrix, encoding="utf-8")
    for module, title in (("01-module-a", "模块甲"), ("02-module-b", "模块乙")):
        prd = root / f"01-test-system/{module}/prd.md"
        prd.parent.mkdir(parents=True, exist_ok=True)
        prd.write_text(f"# {title}\n\n骨架级模块主本。\n", encoding="utf-8")
    return root
