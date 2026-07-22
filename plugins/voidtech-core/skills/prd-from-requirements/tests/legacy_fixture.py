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

_SHARED = ["需求表-测试", "序号", "模块", "需求点", "模块甲", "客户新增",
           "客户列表", "客户详情", "站内通知-无序号补充", "模块乙",
           "订单列表", "订单导出"]

_ROWS = [
    # (row, [(col, kind, value)]); kind: "s"=shared string 下标, "n"=数字
    (1, [("A", "s", 0)]),
    (2, [("A", "s", 1), ("B", "s", 2), ("C", "s", 3)]),
    (3, [("A", "n", 1), ("B", "s", 4), ("C", "s", 5)]),
    (4, [("A", "n", 2), ("B", "s", 4), ("C", "s", 6)]),
    (5, [("A", "n", 3), ("B", "s", 4), ("C", "s", 7)]),
    (6, [("B", "s", 4), ("C", "s", 8)]),          # 无序号行 → TST-003+a
    (7, [("A", "n", 4), ("B", "s", 9), ("C", "s", 10)]),
    (8, [("A", "n", 5), ("B", "s", 9), ("C", "s", 11)]),
]

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _sheet_xml() -> str:
    rows = []
    for row_num, cells in _ROWS:
        parts = []
        for col, kind, value in cells:
            ref = f"{col}{row_num}"
            if kind == "s":
                parts.append(f'<c r="{ref}" t="s"><v>{value}</v></c>')
            else:
                parts.append(f'<c r="{ref}"><v>{value}</v></c>')
        rows.append(f'<row r="{row_num}">{"".join(parts)}</row>')
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<worksheet xmlns="{_MAIN_NS}"><sheetData>{"".join(rows)}</sheetData></worksheet>')


def build_xlsx(path: Path) -> None:
    shared_items = "".join(f"<si><t>{text}</t></si>" for text in _SHARED)
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
            f'<sst xmlns="{_MAIN_NS}" count="{len(_SHARED)}" uniqueCount="{len(_SHARED)}">'
            f"{shared_items}</sst>"),
        "xl/worksheets/sheet1.xml": _sheet_xml(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 7, 1, 0, 0, 0))
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
