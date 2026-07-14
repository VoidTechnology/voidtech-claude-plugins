#!/usr/bin/env python3
"""Convert an .xlsx workbook into per-sheet CSV and Markdown files."""

from __future__ import annotations

import argparse
import csv
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "office_rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def col_to_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref)
    if not letters:
        return 0
    value = 0
    for char in letters.group(0):
        value = value * 26 + (ord(char) - ord("A") + 1)
    return value - 1


def cell_to_indices(cell_ref: str) -> tuple[int, int]:
    match = re.match(r"([A-Z]+)(\d+)", cell_ref)
    if not match:
        return 0, 0
    return int(match.group(2)) - 1, col_to_index(match.group(1))


def safe_name(value: str) -> str:
    normalized = re.sub(r"[^\w._-]+", "-", value.strip()).strip("-")
    return normalized or "sheet"


def read_xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    with archive.open(name) as handle:
        return ET.parse(handle).getroot()


def read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []

    root = read_xml(archive, "xl/sharedStrings.xml")
    values: list[str] = []
    for item in root.findall("main:si", NS):
        parts = [node.text or "" for node in item.findall(".//main:t", NS)]
        values.append("".join(parts))
    return values


def workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    workbook = read_xml(archive, "xl/workbook.xml")
    rels = read_xml(archive, "xl/_rels/workbook.xml.rels")
    rel_targets = {
        rel.attrib["Id"]: rel.attrib["Target"]
        for rel in rels.findall("rel:Relationship", NS)
    }

    result: list[tuple[str, str]] = []
    for sheet in workbook.findall("main:sheets/main:sheet", NS):
        name = sheet.attrib.get("name", "Sheet")
        rel_id = sheet.attrib.get(f"{{{NS['office_rel']}}}id")
        if not rel_id or rel_id not in rel_targets:
            continue
        target = rel_targets[rel_id].lstrip("/")
        path = target if target.startswith("xl/") else f"xl/{target}"
        result.append((name, path))
    return result


def cell_text(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", NS))

    value_node = cell.find("main:v", NS)
    if value_node is None:
        formula = cell.find("main:f", NS)
        return f"={formula.text}" if formula is not None and formula.text else ""

    value = value_node.text or ""
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (ValueError, IndexError):
            return value
    if cell_type == "b":
        return "TRUE" if value == "1" else "FALSE"
    return value


def read_sheet(
    archive: zipfile.ZipFile, path: str, shared_strings: list[str]
) -> list[list[str]]:
    root = read_xml(archive, path)
    cells: dict[tuple[int, int], str] = {}
    max_row = 0
    max_col = 0

    for fallback_row_index, row in enumerate(root.findall(".//main:sheetData/main:row", NS)):
        row_index = int(row.attrib.get("r", fallback_row_index + 1)) - 1
        for cell in row.findall("main:c", NS):
            cell_ref = cell.attrib.get("r", f"A{row_index + 1}")
            cell_row_index, col_index = cell_to_indices(cell_ref)
            cells[(cell_row_index, col_index)] = cell_text(cell, shared_strings)
            max_row = max(max_row, cell_row_index + 1)
            max_col = max(max_col, col_index + 1)

    for merge_cell in root.findall(".//main:mergeCells/main:mergeCell", NS):
        ref = merge_cell.attrib.get("ref", "")
        if ":" not in ref:
            continue
        start_ref, end_ref = ref.split(":", 1)
        start_row, start_col = cell_to_indices(start_ref)
        end_row, end_col = cell_to_indices(end_ref)
        anchor_value = cells.get((start_row, start_col), "")
        if not anchor_value:
            continue
        for row_index in range(start_row, end_row + 1):
            for col_index in range(start_col, end_col + 1):
                if not cells.get((row_index, col_index)):
                    cells[(row_index, col_index)] = anchor_value
        max_row = max(max_row, end_row + 1)
        max_col = max(max_col, end_col + 1)

    rows = [
        [cells.get((row_index, col_index), "") for col_index in range(max_col)]
        for row_index in range(max_row)
    ]

    while rows and not any(value.strip() for value in rows[-1]):
        rows.pop()
    width = max((len(row) for row in rows), default=0)
    while width > 0 and all(width > len(row) or not row[width - 1].strip() for row in rows):
        width -= 1
    return [row[:width] + [""] * max(0, width - len(row)) for row in rows]


def markdown_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\n", "<br>")


def write_markdown(rows: list[list[str]], path: Path, title: str) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write(f"# {title}\n\n")
        handle.write("> 转换产物，以原始 xlsx 为准。\n\n")
        if not rows:
            handle.write("_空表_\n")
            return

        width = max(len(row) for row in rows)
        header = rows[0] + [""] * (width - len(rows[0]))
        handle.write("| " + " | ".join(markdown_escape(value) for value in header) + " |\n")
        handle.write("|" + "|".join("---" for _ in range(width)) + "|\n")
        for row in rows[1:]:
            padded = row + [""] * (width - len(row))
            handle.write("| " + " | ".join(markdown_escape(value) for value in padded) + " |\n")


def write_csv(rows: list[list[str]], path: Path) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(rows)


def convert(workbook_path: Path, output_dir: Path) -> None:
    if workbook_path.suffix.lower() != ".xlsx":
        raise ValueError("仅支持 .xlsx；请先将 .xls 另存为 .xlsx 或 .csv。")

    output_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(workbook_path) as archive:
        shared_strings = read_shared_strings(archive)
        sheets = workbook_sheets(archive)
        index_lines = [
            f"# {workbook_path.name} 转换结果",
            "",
            f"- 原始文件：`{workbook_path}`",
            "- 说明：以下文件是转换产物，以原始 xlsx 为准。",
            "- 注意：日期单元格可能显示为 Excel 序列数字，需要结合原始表格确认日期口径。",
            "",
            "| Sheet | CSV | Markdown |",
            "|---|---|---|",
        ]
        for position, (sheet_name, sheet_path) in enumerate(sheets, start=1):
            rows = read_sheet(archive, sheet_path, shared_strings)
            base = f"{position:02d}-{safe_name(sheet_name)}"
            csv_path = output_dir / f"{base}.csv"
            md_path = output_dir / f"{base}.md"
            write_csv(rows, csv_path)
            write_markdown(rows, md_path, sheet_name)
            index_lines.append(f"| {sheet_name} | `{csv_path.name}` | `{md_path.name}` |")

    (output_dir / "INDEX.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    try:
        convert(args.workbook.resolve(), args.output_dir.resolve())
    except Exception as error:
        print(f"转换失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
